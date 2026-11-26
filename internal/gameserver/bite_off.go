package gameserver

// 咬断线组：少数掠食鱼能把引线/子线咬断。
//
// 这与「张力超过承力」的常规断线是两条独立通路。官方口径（issue #153 的 wiki 整理）：
//
//	常见狗鱼、哲罗鱼、鳄雀鳝/斑点雀鳝、鼠鲨
//	  鱼重 > 引线承载 → 每次冲刺 20% 咬断
//	  鱼重 < 引线承载 → 每次冲刺  4% 咬断
//	  其余鱼种均无法咬断线组
//
// 服务端不模拟搏鱼力学（docs/analysis-fish-fight-physics-2026-11-07.md:35），
// 也收不到「冲刺」事件——机动调度完全在客户端本地跑。因此这里用 14/8 遥测做节拍，
// 并用两个已验证的量把「冲刺」近似出来：
//
//	偏移 45（.1.4）鱼剩余体力比 0~1：休息机动让消耗趋近 0，挣扎时持续下降。
//	              两帧之间的降幅 > 0 就说明这尾鱼在挣扎，也就是「在冲刺」。
//	偏移 49（.1.5）钓组最弱环 kgf：与载力件现算结果逐位一致，直接读帧。
//
// 判定节流在 bite_off_sprint_seconds：一条 14/8 约 2 秒，官方机动时长下/上限
// 是 0.07~30 / 0.25~60 秒，所以「每 N 秒最多判一次」是冲刺频率的近似。
// 这个近似是本实现的唯一非官方成分，见 specs/changes/bite-off-leader/spec.md。
//
// 默认关闭：客户端自身已有一条「鱼把组磨断」的本地判定
// （docs/analysis-client-line-break-detection-2026-11-12.md:70，FishingSet.cs:1716-1758），
// 两端同时开会让咬断概率叠加。需要服务端权威时必须显式打开。

import (
	"fmt"
	"math"
	"math/rand"
	"strings"
	"time"
)

// 咬断相关默认值。概率取官方口径，鱼种表取官方列举的五个 key。
const (
	defaultBiteOffSpecies    = "n.pike,taimen,agar,sgar,lamna_n"
	defaultBiteOffOverPct    = 20.0
	defaultBiteOffUnderPct   = 4.0
	defaultBiteOffSprintSecs = 10.0
	// defaultBiteOffMinDrop 是「这尾鱼在挣扎」的体力降幅门槛。搏鱼全程体力从
	// 1.0 掉到 0，一条 14/8 约 2 秒；休息机动让消耗趋近 0，所以 0.002 足以把
	// 「在休息」和「在挣扎」分开。填 0 表示不用降幅门控，只看时间节拍。
	defaultBiteOffMinDrop     = 0.002
	biteOffMinSprintSecsFloor = 1.0
	biteOffMaxSprintSecs      = 120.0
	biteOffMaxPercent         = 100.0
	biteOffMinPercent         = 0.0
)

// biteOffSpeciesSet 解析 bite_off_species 的逗号分隔鱼种表。
// 空串表示整层关闭；未知 key 不报错，只是永不命中。
func (s *Server) biteOffSpeciesSet() map[string]bool {
	raw := strings.TrimSpace(s.tunableS("bite_off_species", defaultBiteOffSpecies))
	if raw == "" {
		return nil
	}
	out := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		key := strings.ToLower(strings.TrimSpace(part))
		if key != "" {
			out[key] = true
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// biteOffChance 返回一次冲刺判定里这尾鱼咬断线组的概率。
//
// 官方只按「鱼重 vs 引线承载」二选一：超过承载取 over，没超过取 under。
// leaderKg <= 0 表示读不到引线承力，此时不判——咬断的目标件都不存在，
// 也就无从「咬断线组」。返回 ok=false 表示这尾鱼不参与。
func biteOffChance(fishWeightG int64, leaderKg, overPct, underPct float64) (chance float64, ok bool) {
	if fishWeightG <= 0 || leaderKg <= 0 ||
		math.IsNaN(leaderKg) || math.IsInf(leaderKg, 0) {
		return 0, false
	}
	pct := underPct
	if float64(fishWeightG)/1000.0 > leaderKg {
		pct = overPct
	}
	if math.IsNaN(pct) || math.IsInf(pct, 0) || pct <= 0 {
		return 0, false
	}
	if pct > biteOffMaxPercent {
		pct = biteOffMaxPercent
	}
	return pct / 100.0, true
}

// rollBiteOffFloat 返回 [0,1) 随机数；测试可替换 Server.randFloat。
func (s *Server) rollBiteOffFloat() float64 {
	if s != nil && s.randFloat != nil {
		return s.randFloat()
	}
	return rand.Float64()
}

// biteOffTunables 把四个数值参数一起读出来并做区间收敛。
// 返回 enabled=false 表示整层关闭或参数不可用。
func (s *Server) biteOffTunables() (overPct, underPct, sprintSecs, minDrop float64, enabled bool) {
	if s.tunableF("bite_off_enabled", 0) == 0 {
		return 0, 0, 0, 0, false
	}
	overPct = s.tunableF("bite_off_over_pct", defaultBiteOffOverPct)
	underPct = s.tunableF("bite_off_under_pct", defaultBiteOffUnderPct)
	sprintSecs = s.tunableF("bite_off_sprint_seconds", defaultBiteOffSprintSecs)
	minDrop = s.tunableF("bite_off_min_stamina_drop", defaultBiteOffMinDrop)

	for _, v := range []float64{overPct, underPct, sprintSecs, minDrop} {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return 0, 0, 0, 0, false
		}
	}
	overPct = clampFloat(overPct, biteOffMinPercent, biteOffMaxPercent)
	underPct = clampFloat(underPct, biteOffMinPercent, biteOffMaxPercent)
	sprintSecs = clampFloat(sprintSecs, biteOffMinSprintSecsFloor, biteOffMaxSprintSecs)
	if minDrop < 0 {
		minDrop = 0
	}
	if overPct <= 0 && underPct <= 0 {
		return 0, 0, 0, 0, false
	}
	return overPct, underPct, sprintSecs, minDrop, true
}

// maybeBiteOff 在一条 14/8 到达时判断是否发生咬断，命中则立刻按断组处理。
//
// 全部内存门控通过后才读库取引线承力：搏鱼期 14/8 约 2 秒一条，
// 每帧查装备库没有意义，只有「在前摇 + 在挣扎 + 到闸门」之后才需要真值。
func (s *Server) maybeBiteOff(ctx *Ctx) {
	if s == nil || s.DB == nil || ctx == nil || ctx.Sess == nil {
		return
	}
	overPct, underPct, sprintSecs, minDrop, enabled := s.biteOffTunables()
	if !enabled {
		return
	}
	species := s.biteOffSpeciesSet()
	if len(species) == 0 {
		return
	}
	uid := ctx.Sess.Userid
	st := s.fishingStateForRequest(ctx)
	if st == nil || s.fishingState(uid) != st {
		return
	}
	stamina, ok := fishStaminaFromLoad(ctx.Body)
	if !ok {
		return
	}
	now := time.Now()

	st.mu.Lock()
	if !staminaFightActiveLocked(st) {
		st.resetBiteOffLocked()
		st.mu.Unlock()
		return
	}
	fish := st.Pending
	if fish == nil || !species[strings.ToLower(strings.TrimSpace(fish.Species))] {
		st.resetBiteOffLocked()
		st.mu.Unlock()
		return
	}
	// 换鱼后旧的节流时间与体力基线都不再适用：FishGUID 一变就整体重置，
	// 否则新鱼会继承上一尾鱼的掷骰时刻和体力基准。
	if st.biteOffFishGUID != fish.FishGUID {
		st.resetBiteOffLocked()
		st.biteOffFishGUID = fish.FishGUID
	}
	// 冲刺判据是「距上次掷骰累计掉了多少体力」，不是单帧降幅：一条 14/8 约
	// 2 秒，实测单帧降幅常在 0.001 以下，只比较相邻两帧会让低门槛鱼种永远掷不了骰。
	if st.biteOffSeen && stamina < st.biteOffLastStamina {
		st.biteOffDropAccum += st.biteOffLastStamina - stamina
	}
	st.biteOffSeen = true
	st.biteOffLastStamina = stamina
	dropped := st.biteOffDropAccum
	lastAt := st.biteOffRollAt
	if !lastAt.IsZero() && now.Sub(lastAt) < time.Duration(sprintSecs*float64(time.Second)) {
		st.mu.Unlock()
		return
	}
	st.mu.Unlock()
	if !biteOffSprintGate(dropped, minDrop) {
		return
	}

	rodGUID := strings.TrimSpace(st.GearGuid)
	if rodGUID == "" {
		return
	}
	ids := s.rigGearIDs(s.dbCtx(), uid, rodGUID)
	spec := s.loadGearSpecForRig(s.dbCtx(), ids, rodGUID)
	leaderGUID, leaderCat, leaderKg := ids.LeaderGUID, gearCatLeader, 0.0
	if leaderGUID == "" {
		leaderGUID, leaderCat = ids.LeadcoreGUID, gearCatLeadcore
	}
	// 断件品类必须取实例真实品类，不能按「前导就写 13」猜：rigGearIDs 的
	// LeaderGUID 优先取 15（钢丝前导），此时 rig_component 的槽位也是 15。
	// 硬写 13 会让下游集合按 13 展开，前导线自己不在集合里，断完只剩钩饵
	// 没了、前导线还挂在竿上。
	if leaderGUID != "" {
		if row, rerr := s.DB.GetItemByGUID(s.dbCtx(), leaderGUID); rerr == nil && row != nil {
			if def, derr := s.itemDefForRow(s.dbCtx(), row); derr == nil && def != nil && def.Category > 0 {
				leaderCat = def.Category
			}
		}
	}
	if leaderGUID != "" {
		switch leaderCat {
		case gearCatLeadcore:
			leaderKg = spec.LeadcoreStrengthKg
		default:
			leaderKg = spec.LeaderStrengthKg
		}
	}
	// 没有引线/铅芯，或引线承力读不出来时，比较值退到主线承载：
	// 否则 biteOffChance 直接判「不可判」，规格里「没有挂引线时咬断落在主线上」
	// 这条路径永远到不了。
	if leaderKg <= 0 {
		leaderKg = spec.LineStrengthKg
	}
	chance, eligible := biteOffChance(fish.WeightG, leaderKg, overPct, underPct)
	if !eligible {
		return
	}
	st.mu.Lock()
	if !staminaFightActiveLocked(st) || st.Pending != fish {
		st.mu.Unlock()
		return
	}
	st.biteOffRollAt = now
	st.biteOffDropAccum = 0
	st.mu.Unlock()

	if s.rollBiteOffFloat() >= chance {
		return
	}
	s.biteOffLeader(ctx, st, fish, leaderGUID, leaderCat, leaderKg)
}

// biteOffLeader 执行咬断：优先断引线/子线，没有引线时断主线。
//
// 走的是既有的断件事务（breakComponentTx / breakLineTx），因此装备销毁、
// 损伤日志、主线长度扣减的口径与 17/9 完全一致，不另写一套。
func (s *Server) biteOffLeader(ctx *Ctx, st *FishState, fish *RolledFish, leaderGUID string, leaderCat int64, leaderKg float64) {
	uid := ctx.Sess.Userid
	pushCtx := ctx.Sess.pushCtx()
	rodGUID := st.GearGuid

	var outcome *gearBreakOutcome
	var err error
	part := "leader"
	if leaderGUID != "" {
		// 与 17/9 同口径：断引线/铅芯走断线事务，按 downstreamLossCategories
		// 一并删除下游钩、饵、拟饵，并写 line_break / lost_on_line_break 日志。
		// breakComponentTx 只管终端件本身，用它会把钩饵留在竿上。
		outcome, err = s.breakLineTxWithLineOut(pushCtx, uid, rodGUID, leaderGUID, leaderCat, 0)
	} else {
		// 没有引线：咬断落在主线上。主线走 lineLossTx，按剪线口径丢钩饵。
		part = "line"
		outcome, err = s.breakLineTx(pushCtx, uid, rodGUID, "", catLine)
	}
	if err != nil || outcome == nil {
		if s.log != nil {
			s.log.Warn("咬断线组未完成", "rod", shortGUID(rodGUID),
				"part", part, "leader_kg", roundTo(leaderKg, 2), "err", err)
		}
		return
	}

	st.mu.Lock()
	st.Pending = nil
	st.CastActive = false
	st.Hooked = false
	st.Resolved = true
	st.resetBiteOffLocked()
	st.mu.Unlock()

	s.bumpFishingCounter(uid, "line_breaks")
	// 咬断有独立原因码（10=牙齿咬断钓组），不能复用张力断线的 30/6：
	// 客户端按原因码换文案，混用会把「被鱼咬断」显示成「引线断了」。
	s.notifyFishEscape(ctx.Sess, fish, "牙齿咬断钓组")

	syncGUIDs := append([]string(nil), outcome.RemovedGUIDs...)
	syncGUIDs = append(syncGUIDs, outcome.StackRefreshGUIDs...)
	if g := strings.TrimSpace(outcome.BrokenGUID); g != "" {
		syncGUIDs = append(syncGUIDs, g)
	}
	if len(syncGUIDs) > 0 {
		ctx.Sess.Push4_22ItemGUIDs(syncGUIDs)
	}
	ctx.Sess.pushSystemChat(fmt.Sprintf("牙齿咬断了%s，鱼跑了", map[string]string{
		"leader": "引线", "line": "主线",
	}[part]))
	if s.log != nil {
		s.log.Info("咬断线组", "rod", shortGUID(rodGUID), "fish", fish.Species,
			"weight_g", fish.WeightG, "part", part, "leader_kg", roundTo(leaderKg, 2))
	}
}

// resetBiteOffLocked 清空一尾鱼的冲刺窗口状态，调用方必须持有 st.mu。
// 换鱼、脱钩、判定成功都必须走这里，只清某个字段会留下别的尾巴。
func (st *FishState) resetBiteOffLocked() {
	st.biteOffSeen = false
	st.biteOffLastStamina = 0
	st.biteOffRollAt = time.Time{}
	st.biteOffFishGUID = ""
	st.biteOffDropAccum = 0
}

// biteOffSprintGate 判断这一帧是否算「鱼在冲刺」。
//
// 客户端把机动调度完全跑在本地，服务端收不到冲刺事件，只能从 14/8 的鱼剩余
// 体力反推：休息机动的消耗趋近 0，挣扎时持续下降。minDrop <= 0 表示关掉这条
// 门控，只按时间节拍判定。
func biteOffSprintGate(staminaDrop, minDrop float64) bool {
	if minDrop <= 0 {
		return true
	}
	if math.IsNaN(staminaDrop) || math.IsInf(staminaDrop, 0) {
		return false
	}
	return staminaDrop >= minDrop
}
