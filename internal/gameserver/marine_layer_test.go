package gameserver

import (
	"math"
	"testing"
	"time"
)

func newMarineLayerTestServer() *Server {
	s := &Server{}
	s.tunCache = map[string]float64{
		"marine_layer_enabled":          1,
		"marine_descent_seconds":        60,
		"marine_descent_seconds_pilker": 60,
		"marine_descent_seconds_jig":    50,
		"marine_descent_seconds_bottom": 45,
	}
	s.tunAt = time.Now()
	return s
}

func marineLayerNear(got, want float64) bool {
	return math.Abs(got-want) < 1e-9
}

func TestMarineLayerDescendsThenBottomEvent(t *testing.T) {
	s := newMarineLayerTestServer()
	st := &FishState{RigType: 50, CastActive: true}
	t0 := time.Unix(1000, 0)

	s.updateMarineLayerLocked(st, marineDiveMask, t0)
	if st.MarineState != marineStateDescending || !marineLayerNear(st.MarineLayer, marineLayerStart) {
		t.Fatalf("首次下沉状态错误: state=%d layer=%f", st.MarineState, st.MarineLayer)
	}

	// 60 秒满程的一半：0.05 + (0.93-0.05)*0.5 = 0.49。
	s.updateMarineLayerLocked(st, marineDiveMask, t0.Add(30*time.Second))
	wantMid := marineLayerStart + (marineLayerBottom-marineLayerStart)*0.5
	if !marineLayerNear(st.MarineLayer, wantMid) {
		t.Fatalf("30 秒层数=%f，期望 %f", st.MarineLayer, wantMid)
	}

	s.updateMarineLayerLocked(st, marineBottomTouchBit, t0.Add(60*time.Second))
	if st.MarineState != marineStateOnBottom || st.BottomCycle != 1 {
		t.Fatalf("触底状态错误: state=%d cycle=%d", st.MarineState, st.BottomCycle)
	}
	if !marineLayerNear(st.MarineLayer, marineLayerBottom) {
		t.Fatalf("触底后层数=%f，期望 %f", st.MarineLayer, marineLayerBottom)
	}
}

func TestMarineLayerCycleStartsFromCurrentLayer(t *testing.T) {
	s := newMarineLayerTestServer()
	st := &FishState{RigType: 50, CastActive: true}
	t0 := time.Unix(2000, 0)

	s.updateMarineLayerLocked(st, marineBottomStillBit, t0)
	if st.BottomCycle != 1 {
		t.Fatalf("第一次到底 cycle=%d", st.BottomCycle)
	}

	s.updateMarineLayerLocked(st, marineAscendBit, t0.Add(time.Second))
	if st.MarineState != marineStateAscending || !marineLayerNear(st.MarineLayer, 0.85) {
		t.Fatalf("上升状态错误: state=%d layer=%f", st.MarineState, st.MarineLayer)
	}
	if st.BottomLeftAt.IsZero() {
		t.Fatal("上升后应记录离底时间")
	}

	s.updateMarineLayerLocked(st, marineDiveMask, t0.Add(2*time.Second))
	if st.MarineState != marineStateDescending || !marineLayerNear(st.DescentStartLayer, 0.85) {
		t.Fatalf("再次下沉起点错误: state=%d start=%f", st.MarineState, st.DescentStartLayer)
	}

	s.updateMarineLayerLocked(st, marineBottomTouchBit, t0.Add(3*time.Second))
	if st.BottomCycle != 2 {
		t.Fatalf("第二次到底 cycle=%d，期望 2", st.BottomCycle)
	}
}

func TestMarineLayerUniformRetrieveLeavesAfterGrace(t *testing.T) {
	s := newMarineLayerTestServer()
	st := &FishState{RigType: 50, CastActive: true}
	t0 := time.Unix(3000, 0)

	s.updateMarineLayerLocked(st, marineBottomStillBit, t0)
	// 收线：层数每次只降 0.03；从 0.93 降到 0.84 约需 3 次。
	s.updateMarineLayerLocked(st, marineUniformBit, t0.Add(100*time.Millisecond))
	if !marineLayerNear(st.MarineLayer, 0.90) {
		t.Fatalf("第一次收线层数=%f，期望 0.90", st.MarineLayer)
	}
	s.updateMarineLayerLocked(st, marineUniformBit, t0.Add(1600*time.Millisecond))
	if !marineLayerNear(st.MarineLayer, 0.87) {
		t.Fatalf("第二次收线层数=%f，期望 0.87", st.MarineLayer)
	}
	s.updateMarineLayerLocked(st, marineUniformBit, t0.Add(3200*time.Millisecond))
	if !marineLayerNear(st.MarineLayer, 0.84) {
		t.Fatalf("第三次收线层数=%f，期望 0.84", st.MarineLayer)
	}
	if st.MarineState != marineStateOnBottom {
		t.Fatalf("刚降到 0.84 仍应保持贴底，state=%d", st.MarineState)
	}

	// 0.85 以下持续不足 1 秒：仍不判离底。
	s.updateMarineLayerLocked(st, marineUniformBit, t0.Add(3500*time.Millisecond))
	if st.MarineState != marineStateOnBottom {
		t.Fatalf("离底宽限内不应离开: state=%d", st.MarineState)
	}

	// 超过 1 秒：判离底。
	s.updateMarineLayerLocked(st, marineUniformBit, t0.Add(4300*time.Millisecond))
	if st.MarineState != marineStateRetrieving || st.BottomLeftAt.IsZero() {
		t.Fatalf("收线离底未生效: state=%d left=%v", st.MarineState, st.BottomLeftAt)
	}
}

func TestMarineLayerZeroFrameKeepsBottomUntilGrace(t *testing.T) {
	s := newMarineLayerTestServer()
	st := &FishState{RigType: 50, CastActive: true}
	t0 := time.Unix(4000, 0)

	s.updateMarineLayerLocked(st, marineBottomStillBit, t0)
	s.updateMarineLayerLocked(st, 0, t0.Add(time.Second))
	if st.MarineState != marineStateOnBottom {
		t.Fatalf("0x0 宽限内不应离底: state=%d", st.MarineState)
	}
	s.updateMarineLayerLocked(st, 0, t0.Add(2100*time.Millisecond))
	if st.MarineState != marineStateRetrieving {
		t.Fatalf("0x0 超时后应离底: state=%d", st.MarineState)
	}
}

func TestMarineLayerDisabledDoesNothing(t *testing.T) {
	s := newMarineLayerTestServer()
	s.tunCache["marine_layer_enabled"] = 0
	st := &FishState{RigType: 50, CastActive: true}

	s.updateMarineLayerLocked(st, marineDiveMask, time.Unix(5000, 0))
	if st.MarineLayerSeen || st.MarineState != marineStateUnknown || st.MarineLayer != 0 {
		t.Fatalf("关闭开关后不应维护状态: seen=%v state=%d layer=%f",
			st.MarineLayerSeen, st.MarineState, st.MarineLayer)
	}
}

func TestMarineLayerBottomRigUsesBottomDuration(t *testing.T) {
	s := newMarineLayerTestServer()
	st := &FishState{RigType: 55, CastActive: true}
	t0 := time.Unix(6000, 0)

	s.updateMarineLayerLocked(st, marineDiveMask, t0)
	if !marineLayerNear(st.MarineDescentSeconds, 45) {
		t.Fatalf("55 沉底默认时长=%f，期望 45", st.MarineDescentSeconds)
	}
	s.updateMarineLayerLocked(st, marineDiveMask, t0.Add(45*time.Second))
	if !marineLayerNear(st.MarineLayer, marineLayerBottom) {
		t.Fatalf("55 沉底满程层数=%f，期望 %f", st.MarineLayer, marineLayerBottom)
	}
}

func TestMarineRigWaterLayerUsesStateOnlyWhenEnabled(t *testing.T) {
	s := newMarineLayerTestServer()
	c50 := fishRollContext{rigType: 50, marineLayer: 0.42, marineLayerKnown: true}
	c55 := fishRollContext{rigType: 55, marineLayer: 0.42, marineLayerKnown: true}

	if got := s.rigWaterLayer(c50); !marineLayerNear(got, 0.42) {
		t.Fatalf("50 海钓层=%f，期望 0.42", got)
	}
	if got := s.rigWaterLayer(c55); !marineLayerNear(got, 0.42) {
		t.Fatalf("55 海钓层=%f，期望 0.42", got)
	}

	s.tunCache["marine_layer_enabled"] = 0
	// 生产路径由 marineContextLayer 在开关关闭时把 known 置 false；
	// 这里显式模拟，验证 rigWaterLayer 会回退旧分支。
	c50.marineLayerKnown = false
	c55.marineLayerKnown = false
	if got := s.rigWaterLayer(c50); !marineLayerNear(got, 0.5) {
		t.Fatalf("关闭后 50 应回退 effectiveLureLayer，得到 %f", got)
	}
	if got := s.rigWaterLayer(c55); !marineLayerNear(got, 0.93) {
		t.Fatalf("关闭后 55 应回退 0.93，得到 %f", got)
	}
}

func TestMarineLayerLearnsDescentByZoneAndRig(t *testing.T) {
	s := newMarineLayerTestServer()
	st := &FishState{RigType: 50, Loc: "loc12_198", CastActive: true}
	t0 := time.Unix(7000, 0)

	s.updateMarineLayerLocked(st, marineDiveMask, t0)
	s.updateMarineLayerLocked(st, marineBottomTouchBit, t0.Add(55*time.Second))

	// 推进模型里「到达 0.93」用的就是满程时长 T，观测到 55 秒下沉
	// 就应该学成 55 秒，不能再按层差放大。
	got := s.marineDescentSeconds(&FishState{RigType: 50, Loc: "loc12_198"})
	if !marineLayerNear(got, 55) {
		t.Fatalf("学习后的满程时长=%f，期望 55", got)
	}

	// 下一次同区号、同钓组类别的下沉：观测时长走到学习值时层数应正好到 0.93。
	next := &FishState{RigType: 50, Loc: "loc12_198", CastActive: true}
	t1 := time.Unix(7600, 0)
	s.updateMarineLayerLocked(next, marineDiveMask, t1)
	s.updateMarineLayerLocked(next, marineDiveMask, t1.Add(55*time.Second))
	if !marineLayerNear(next.MarineLayer, marineLayerBottom) {
		t.Fatalf("下一次下沉观测 55 秒后层数=%f，期望 %f", next.MarineLayer, marineLayerBottom)
	}
	if other := s.marineDescentSeconds(&FishState{RigType: 50, Loc: "loc12_199"}); !marineLayerNear(other, 60) {
		t.Fatalf("不同区号不应共享学习值，得到 %f", other)
	}
	if other := s.marineDescentSeconds(&FishState{RigType: 51, Loc: "loc12_198"}); !marineLayerNear(other, 50) {
		t.Fatalf("不同钓组类别不应共享学习值，得到 %f", other)
	}
}

// 学习开关已移除；旧库残留 marine_layer_learn_enabled=0 也不应影响学习。
func TestMarineLayerLearnIgnoresLegacySwitch(t *testing.T) {
	s := newMarineLayerTestServer()
	s.tunCache["marine_layer_learn_enabled"] = 0
	st := &FishState{RigType: 50, Loc: "loc12_198", CastActive: true}
	t0 := time.Unix(8000, 0)

	s.updateMarineLayerLocked(st, marineDiveMask, t0)
	s.updateMarineLayerLocked(st, marineBottomTouchBit, t0.Add(55*time.Second))

	got := s.marineDescentSeconds(&FishState{RigType: 50, Loc: "loc12_198"})
	if !marineLayerNear(got, 55) {
		t.Fatalf("旧开关残留不应关闭学习，得到 %f", got)
	}
}

func TestMarineLayerDoesNotLearnInterruptedDescent(t *testing.T) {
	s := newMarineLayerTestServer()
	st := &FishState{RigType: 50, Loc: "loc12_198", CastActive: true}
	t0 := time.Unix(9000, 0)

	s.updateMarineLayerLocked(st, marineDiveMask, t0)
	s.updateMarineLayerLocked(st, marineUniformBit, t0.Add(10*time.Second))
	s.updateMarineLayerLocked(st, marineBottomTouchBit, t0.Add(55*time.Second))

	if got := s.marineDescentSeconds(&FishState{RigType: 50, Loc: "loc12_198"}); !marineLayerNear(got, 60) {
		t.Fatalf("中途收线不应学习，得到 %f", got)
	}
}

func TestMarineLayerDoesNotLearnFromMidwaterRelease(t *testing.T) {
	s := newMarineLayerTestServer()
	st := &FishState{RigType: 50, Loc: "loc12_198", CastActive: true}
	t0 := time.Unix(10000, 0)

	s.updateMarineLayerLocked(st, marineBottomStillBit, t0)
	s.updateMarineLayerLocked(st, marineAscendBit, t0.Add(time.Second))
	s.updateMarineLayerLocked(st, marineDiveMask, t0.Add(2*time.Second))
	s.updateMarineLayerLocked(st, marineBottomTouchBit, t0.Add(3*time.Second))

	if got := s.marineDescentSeconds(&FishState{RigType: 50, Loc: "loc12_198"}); !marineLayerNear(got, 60) {
		t.Fatalf("从中层放线不应学习，得到 %f", got)
	}
}

// 海钓水层影响开启时，海钓模式整杆开口率取实时海钓水层；关闭开关或
// 非海钓钓法保持 1。
func TestMarineLayerBiteFactor(t *testing.T) {
	s := newMarineLayerTestServer()
	st := &FishState{RigType: 50, MarineLayerSeen: true, MarineLayer: 0.5}
	if got := s.marineLayerBiteFactor(st); !marineLayerNear(got, 0.5) {
		t.Fatalf("下沉到 0.5 时开口率应为 0.5：got %g", got)
	}
	st.MarineLayer = 0.93
	if got := s.marineLayerBiteFactor(st); !marineLayerNear(got, 0.93) {
		t.Fatalf("贴底时开口率应为 0.93：got %g", got)
	}
	st.MarineLayerSeen = false
	if got := s.marineLayerBiteFactor(st); !marineLayerNear(got, marineLayerStart) {
		t.Fatalf("状态机未启动时应按起点 0.05：got %g", got)
	}
	if got := s.marineLayerBiteFactor(&FishState{RigType: 5}); got != 1 {
		t.Fatalf("非海钓钓法应为 1：got %g", got)
	}
	s.tunMu.Lock()
	s.tunCache["marine_layer_enabled"] = 0
	s.tunAt = time.Now()
	s.tunMu.Unlock()
	if got := s.marineLayerBiteFactor(st); got != 1 {
		t.Fatalf("关闭海钓水层影响应为 1：got %g", got)
	}
}

// 海钓水层影响开启时，整杆开口率按实时水层缩放后再除以钩位/饵数。
func TestMarineLayerBiteProbability(t *testing.T) {
	s := newMarineLayerTestServer()
	st := &FishState{RigType: 50, MarineLayerSeen: true, MarineLayer: 0.93}
	if got := s.marineLayerBiteProbability(1, st, 4); !marineLayerNear(got, 0.93/4) {
		t.Fatalf("贴底 4 饵应为 0.93/4：got %g", got)
	}
	if got := s.marineLayerBiteProbability(1, st, 0); !marineLayerNear(got, 0.93) {
		t.Fatalf("饵数为 0 按 1 饵处理：got %g", got)
	}
	st.MarineLayer = 0.5
	if got := s.marineLayerBiteProbability(0.8, st, 2); !marineLayerNear(got, 0.8*0.5/2) {
		t.Fatalf("基础概率也应按水层与饵数缩放：got %g", got)
	}
	if got := s.marineLayerBiteProbability(1, &FishState{RigType: 5}, 4); got != 1 {
		t.Fatalf("非海钓钓法应原样返回：got %g", got)
	}
	s.tunMu.Lock()
	s.tunCache["marine_layer_enabled"] = 0
	s.tunAt = time.Now()
	s.tunMu.Unlock()
	if got := s.marineLayerBiteProbability(1, st, 4); got != 1 {
		t.Fatalf("关闭海钓水层影响应原样返回：got %g", got)
	}
}
