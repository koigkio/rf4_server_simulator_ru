package gameserver

import (
	"math"
	"time"
)

// 海钓水层状态机（tunable marine_layer_enabled，默认关）。
//
// 只服务 rig 50~60。它给海钓一个“相对水层”的唯一来源：
//
//	0    = 水面
//	0.93 = 贴底活动层（不是 1.0 水底）
//
// 下沉推进不依赖总水深、物理阻力或标定下沉速率，只用相对时长：
//
//	layer = start + (bottom-start) * elapsed/T
//
// 触底事件直接 clamp 到 bottom；循环收放线从当前层继续，不回到水面。
// 其它钓法继续走 rigWaterLayer 的旧分支，不经过这里。
const (
	marineLayerStart  = 0.05
	marineLayerBottom = 0.93
)

const (
	marineStateUnknown = iota
	marineStateDescending
	marineStateOnBottom
	marineStateRetrieving
	marineStateAscending
	marineStateMidwater
	marineStateSurface
)

// 14/7 f5 位。0x800000 不在 lureMotionStatusMask 内，但仍能提示“开始下沉”。
const (
	marineBottomTouchBit uint32 = 0x8
	marineBottomStillBit uint32 = 0x800
	marineBottomMoveBit  uint32 = 0x2000
	marineBottomLayerBit uint32 = 0x400000
	marineAscendBit      uint32 = 0x200000
	marineMidwaterBit    uint32 = 0x200
	marineSurfaceMask    uint32 = 0x1000 | 0x20 | 0x100
	marineDiveMask       uint32 = 0x80000 | 0x800000
	marineUniformBit     uint32 = 0x400

	marineBottomMask = marineBottomTouchBit | marineBottomStillBit | marineBottomMoveBit | marineBottomLayerBit
)

const (
	// 离散动作位（收线/上升）最多每 1.5 秒改一次层，避免 14/7 每帧都叠加。
	marineLayerStepInterval = 1500 * time.Millisecond
	// 底层位消失后先宽限，避免 0x8 瞬时位或单帧丢包立刻判离底。
	marineBottomLostGrace = 2 * time.Second
	// 收线把层数带到 0.85 以下后，还要持续 1 秒才真正判离底。
	marineUniformLeaveGrace = time.Second
)

// marineLayerEnabled 是海钓水层影响总开关；官方鱼汛 realistic 会把它设为 1。
func (s *Server) marineLayerEnabled() bool {
	return s != nil && s.tunableF("marine_layer_enabled", 0) == 1
}

// marineLayerBiteFactor 海钓水层影响开启时，海钓模式的整杆开口率取实时
// 海钓水层：刚入水约 0.05，贴底约 0.93，越接近目标水层鱼口越高。关闭
// 该开关或非海钓钓法返回 1。调用方需持有 st.mu。
func (s *Server) marineLayerBiteFactor(st *FishState) float64 {
	if st == nil || !s.marineLayerEnabled() || !marineRigType(st.RigType) {
		return 1
	}
	if !st.MarineLayerSeen {
		return marineLayerStart
	}
	return clampFloat(st.MarineLayer, marineLayerStart, marineLayerBottom)
}

// marineLayerBiteProbability 海钓水层影响开启时，整杆开口率按实时水层缩放，
// 再按可出鱼的钩位/饵数分摊：每个钩位独立判定，整杆概率先除以钩位数，
// 避免多钩把总开口率放大 N 倍。关闭开关或非海钓钓法原样返回 base。
func (s *Server) marineLayerBiteProbability(base float64, st *FishState, baitCount int) float64 {
	if st == nil || !s.marineLayerEnabled() || !marineRigType(st.RigType) {
		return base
	}
	if baitCount < 1 {
		baitCount = 1
	}
	return base * s.marineLayerBiteFactor(st) / float64(baitCount)
}

// marineDescentSample 是某个“区号 + 钓组类别”的触底学习结果。
// 只存内存，重启丢失；样本数用于决定 EMA 的新旧权重。
type marineDescentSample struct {
	seconds float64
	samples int
}

func marineRigClass(rigType int64) string {
	switch {
	case rigType == 50:
		return "pilker"
	case rigType >= 51 && rigType <= 54:
		return "jig"
	case rigType >= 55 && rigType <= 60:
		return "bottom"
	default:
		return "other"
	}
}

func (s *Server) marineDescentKey(st *FishState) string {
	loc := "unknown"
	if st != nil && st.Loc != "" {
		loc = st.Loc
	}
	rig := "other"
	if st != nil {
		rig = marineRigClass(st.RigType)
	}
	return loc + "/" + rig
}

// learnedMarineDescent 返回该区号 + 钓组类别已经学到的满程时长。
// 没有样本或样本异常时返回 false，由调用方回退默认值。
func (s *Server) learnedMarineDescent(st *FishState) (float64, bool) {
	if s == nil || st == nil {
		return 0, false
	}
	key := s.marineDescentKey(st)
	s.marineDescentMu.Lock()
	sample, ok := s.marineDescentCache[key]
	s.marineDescentMu.Unlock()
	if !ok || sample.samples <= 0 || sample.seconds < 5 || sample.seconds > 300 {
		return 0, false
	}
	return sample.seconds, true
}

// learnMarineDescent 用一次干净的“从水面附近到底”的触底事件反推满程时长。
// 只学 DescentStartLayer <= 0.2 的段；循环放线从中层到底不参与，否则会高估 T。
func (s *Server) learnMarineDescent(st *FishState, now time.Time) {
	if s == nil || st == nil {
		return
	}
	if st.MarineState != marineStateDescending || !st.MarineDescentClean {
		return
	}
	if st.DescentStartAt.IsZero() || st.DescentStartLayer <= 0 || st.DescentStartLayer > 0.2 {
		return
	}
	elapsed := now.Sub(st.DescentStartAt).Seconds()
	if elapsed < 2 {
		return
	}
	// T 是“从 0 到 0.93 的满程时长”；本次只走了 startLayer -> 0.93。
	span := (marineLayerBottom - st.DescentStartLayer) / marineLayerBottom
	if span <= 0.1 {
		return
	}
	sample := elapsed / span
	if sample < 5 || sample > 300 {
		return
	}
	key := s.marineDescentKey(st)
	s.marineDescentMu.Lock()
	defer s.marineDescentMu.Unlock()
	if s.marineDescentCache == nil {
		s.marineDescentCache = map[string]marineDescentSample{}
	}
	prev, ok := s.marineDescentCache[key]
	if !ok || prev.samples <= 0 {
		s.marineDescentCache[key] = marineDescentSample{seconds: sample, samples: 1}
		return
	}
	// 前几次更信新样本，之后平滑；避免单次丢帧/水流突变把默认值带飞。
	alpha := 0.3
	if prev.samples < 3 {
		alpha = 0.5
	}
	next := prev.seconds*(1-alpha) + sample*alpha
	s.marineDescentCache[key] = marineDescentSample{seconds: next, samples: prev.samples + 1}
}

// marineDescentSeconds 是“从水面附近到贴底”的相对时长，不是物理下沉速率。
// 优先使用同区号 + 钓组类别的内存学习值；没有样本时按钓组给默认值。
func (s *Server) marineDescentSeconds(st *FishState) float64 {
	if v, ok := s.learnedMarineDescent(st); ok {
		return v
	}
	def := s.tunableF("marine_descent_seconds", 60)
	if def <= 0 {
		def = 60
	}
	if st == nil {
		return def
	}
	switch {
	case st.RigType == 50:
		if v := s.tunableF("marine_descent_seconds_pilker", 60); v > 0 {
			return v
		}
	case st.RigType >= 51 && st.RigType <= 54:
		if v := s.tunableF("marine_descent_seconds_jig", 50); v > 0 {
			return v
		}
	case st.RigType >= 55 && st.RigType <= 60:
		if v := s.tunableF("marine_descent_seconds_bottom", 45); v > 0 {
			return v
		}
	}
	return def
}

func resetMarineLayerLocked(st *FishState) {
	if st == nil {
		return
	}
	st.MarineLayerSeen = false
	st.MarineState = marineStateUnknown
	st.MarineLayer = 0
	st.MarineLayerStart = 0
	st.MarineLayerBottom = 0
	st.MarineDescentSeconds = 0
	st.DescentStartAt = time.Time{}
	st.DescentStartLayer = 0
	st.BottomReachedAt = time.Time{}
	st.BottomLeftAt = time.Time{}
	st.LastBottomBitAt = time.Time{}
	st.MarineUniformSince = time.Time{}
	st.MarineLayerAt = time.Time{}
	st.MarineLastAnim = 0
	st.MarineDescentClean = false
	st.BottomCycle = 0
}

// marineContextLayer 给判鱼上下文取海钓状态机层；未开启/无 14/7 序列时 known=false。
func (s *Server) marineContextLayer(st *FishState) (float64, bool) {
	if st == nil || !marineRigType(st.RigType) || !s.marineLayerEnabled() || !st.MarineLayerSeen {
		return 0, false
	}
	return st.MarineLayer, true
}

// updateMarineLayerLocked 每帧 14/7 调用；调用方必须持有 st.mu。
//
// 状态与事件：
//   - 0x8 / 0x800 / 0x2000 / 0x400000：到底，进入 OnBottom；只有从 Descending
//     进入时才生成新的 BottomCycle，贴底抖动不重复计数。
//   - 0x200000：上升；0x200：中层悬挂；0x1000/0x20/0x100：水面。
//   - 0x400：收线。贴底慢收时层数逐级下降，到 0.85 以下并持续 1 秒才离底。
//   - 0x80000 / 0x800000：开始或重新开始下沉；0x0 丢帧不立即判离底。
func (s *Server) updateMarineLayerLocked(st *FishState, anim uint32, now time.Time) {
	if st == nil || !marineRigType(st.RigType) || !s.marineLayerEnabled() {
		return
	}
	// 未抛竿/已收竿不维护状态；下一次 14/1 会重置，14/7 首帧再初始化。
	if !st.CastActive {
		return
	}
	if !st.MarineLayerSeen {
		// 还没确认入水时不启动，避免岸上 0x0 先把下沉计时跑掉。
		if !st.InWater && anim&(rigAnimInWaterMask|marineDiveMask|marineBottomMask) == 0 {
			return
		}
		st.MarineLayerSeen = true
		st.MarineState = marineStateDescending
		st.MarineLayer = marineLayerStart
		st.MarineLayerStart = marineLayerStart
		st.MarineLayerBottom = marineLayerBottom
		st.DescentStartAt = now
		st.DescentStartLayer = marineLayerStart
		st.MarineDescentSeconds = s.marineDescentSeconds(st)
		st.MarineDescentClean = true
		st.MarineLayerAt = now
		st.MarineLastAnim = anim
	}

	// 离散动作位按“动作位变化或 1.5 秒”更新；连续下沉仍按时间每帧推进。
	step := st.MarineLayerAt.IsZero() || anim != st.MarineLastAnim ||
		now.Sub(st.MarineLayerAt) >= marineLayerStepInterval
	if step {
		st.MarineLayerAt = now
		st.MarineLastAnim = anim
	}

	// 到底优先：同一帧同时带 0x400 或 0x80000 时，触底/贴底仍算到底。
	if anim&marineBottomMask != 0 {
		st.LastBottomBitAt = now
		if st.MarineState == marineStateDescending || st.MarineState == marineStateUnknown {
			if st.MarineState == marineStateDescending {
				s.learnMarineDescent(st, now)
			}
			st.BottomReachedAt = now
			st.BottomCycle++
			st.BottomLeftAt = time.Time{}
		}
		st.MarineState = marineStateOnBottom
		st.MarineLayer = marineLayerBottom
		st.MarineUniformSince = time.Time{}
		st.MarineDescentClean = false
		return
	}

	// 明确离开底层的事件：一帧即可，不做额外去抖。
	if anim&marineSurfaceMask != 0 {
		st.MarineState = marineStateSurface
		st.MarineLayer = 0.08
		st.MarineDescentClean = false
		st.markMarineBottomLeftLocked(now)
		return
	}
	if anim&marineAscendBit != 0 {
		st.MarineState = marineStateAscending
		if step {
			st.MarineLayer = math.Max(marineLayerStart, st.MarineLayer-0.08)
		}
		st.MarineDescentClean = false
		st.markMarineBottomLeftLocked(now)
		return
	}
	if anim&marineMidwaterBit != 0 {
		st.MarineState = marineStateMidwater
		st.MarineLayer = 0.55
		st.MarineDescentClean = false
		st.markMarineBottomLeftLocked(now)
		return
	}

	// 重新下沉。从贴底状态放线时层数已经在 0.93，不需要重新走满全程。
	if anim&marineDiveMask != 0 && st.MarineState != marineStateDescending {
		st.MarineState = marineStateDescending
		st.DescentStartAt = now
		st.DescentStartLayer = st.MarineLayer
		st.MarineDescentSeconds = s.marineDescentSeconds(st)
		// 从贴底继续放线没有“满程”可学；只有从明显上方开始才允许学习。
		st.MarineDescentClean = st.MarineLayer < marineLayerBottom-0.001
	}

	// 收线：只对非下沉状态生效，避免和下沉时间推进打架。
	if anim&marineUniformBit != 0 {
		st.MarineDescentClean = false
		if st.MarineState != marineStateDescending {
			if step {
				st.MarineLayer = math.Max(marineLayerStart, st.MarineLayer-0.03)
			}
			if st.MarineLayer > 0.85 {
				st.MarineUniformSince = time.Time{}
				return
			}
			if st.MarineUniformSince.IsZero() {
				st.MarineUniformSince = now
			}
			if now.Sub(st.MarineUniformSince) < marineUniformLeaveGrace {
				return
			}
			st.MarineState = marineStateRetrieving
			st.markMarineBottomLeftLocked(now)
			return
		}
	}
	st.MarineUniformSince = time.Time{}

	// 客户端丢帧/只发 0x0：宽限后判离底，不立即改层。
	if anim == 0 && st.MarineState == marineStateOnBottom &&
		!st.LastBottomBitAt.IsZero() && now.Sub(st.LastBottomBitAt) >= marineBottomLostGrace {
		st.MarineState = marineStateRetrieving
		st.MarineDescentClean = false
		st.markMarineBottomLeftLocked(now)
	}

	// 下沉按相对时长连续推进；触底事件到得早会提前 clamp。
	if st.MarineState == marineStateDescending {
		if st.MarineDescentSeconds <= 0 {
			st.MarineDescentSeconds = s.marineDescentSeconds(st)
		}
		elapsed := now.Sub(st.DescentStartAt).Seconds()
		p := elapsed / st.MarineDescentSeconds
		if p < 0 {
			p = 0
		}
		if p > 1 {
			p = 1
		}
		st.MarineLayer = st.DescentStartLayer + (marineLayerBottom-st.DescentStartLayer)*p
		if st.MarineLayer > marineLayerBottom {
			st.MarineLayer = marineLayerBottom
		}
	}
	if st.MarineState == marineStateOnBottom {
		st.MarineLayer = marineLayerBottom
	}
}

func (st *FishState) markMarineBottomLeftLocked(now time.Time) {
	if st == nil || !st.BottomLeftAt.IsZero() {
		return
	}
	st.BottomLeftAt = now
}
