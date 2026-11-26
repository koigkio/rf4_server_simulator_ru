package gameserver

// 海钓多钩判鱼的回归：钩位上可能同时挂天然饵或彩珠/发光管，它们只作
// 吸引成分。主鱼、多钩额外鱼和开口率分母必须按同一口径只认真实拟饵，
// 否则会出现"用装饰饵咬钩"和"装饰钩位压低有效开口率"两类问题。

import "testing"

// rollBaitsForGroup / marineBaitHookCount 只保留真实拟饵；
// 天然饵与 lureType=17 吸引成分不参与判鱼，也不计入有效钩位数。
func TestMarineRollBaitsOnlyKeepsRealLures(t *testing.T) {
	s, _ := newRigTestServer(t)
	c := fishRollContext{rigType: 50}

	// 同一钩位混挂真实拟饵、天然饵和彩珠：只有真实拟饵参与判鱼。
	mixed := baitedHookSet{baits: []string{"pilkerlures_2630", "worm_01", "color_bead_009"}}
	if got := s.rollBaitsForGroup(t.Context(), c, mixed, 50); len(got) != 1 || got[0] != "pilkerlures_2630" {
		t.Fatalf("混挂钩位的候选=%v, 期望只保留 pilkerlures_2630", got)
	}

	// 只有天然饵与彩珠的钩位视为装饰，不会出鱼。
	decorated := baitedHookSet{baits: []string{"worm_01", "color_bead_009"}}
	if got := s.rollBaitsForGroup(t.Context(), c, decorated, 50); len(got) != 0 {
		t.Fatalf("装饰钩位不应有判鱼候选, 得到 %v", got)
	}

	// 开口率分母只算能出鱼的钩位。
	groups := []baitedHookSet{mixed, decorated}
	if got := s.marineBaitHookCount(t.Context(), 50, groups); got != 1 {
		t.Fatalf("海钓有效钩位数=%d, 期望 1 (天然饵与彩珠不算)", got)
	}
	// 非海钓钓组保持原口径：每组饵都能参与判鱼。
	if got := s.marineBaitHookCount(t.Context(), 12, groups); got != 2 {
		t.Fatalf("非海钓钩位数=%d, 期望原样返回 2", got)
	}
}

// 多钩额外鱼路径不能从"只剩装饰"的钩位出鱼。
// 主鱼占掉唯一的真实拟饵钩位后，其余钩位挂的都是天然饵/彩珠。
func TestRollExtraFishSkipsDecorationOnlyHooks(t *testing.T) {
	s, _ := newRigTestServer(t)
	ctx := t.Context()
	setMultiHookTunableForTest(t, s, "multi_hook_bite", 1)
	setMultiHookTunableForTest(t, s, "multi_hook_max", 3)
	setMultiHookTunableForTest(t, s, "multi_hook_bite_chance", 1)

	rod := newArmMultiHookRod(t, s)
	mainHook := mountArmHook(t, s, rod, 250)
	mountArmHook(t, s, rod, 1001)
	mountArmHook(t, s, rod, 1005)
	baitTestMount(t, s, rod, "worm_01", 1, 350)
	baitTestMount(t, s, rod, "color_bead_009", 1, 351)

	primary := &RolledFish{HookGUID: mainHook, WeightG: 200}
	extras := s.rollExtraFishForRig(ctx, 1000001, rod, "loc12_15", "worm_01",
		fishingSkillBonus{}, fishRollContext{rigType: 50}, primary, s.multiHookConfig())
	if len(extras) != 0 {
		t.Fatalf("装饰钩位不应出额外鱼, 得到 %d 条: %+v", len(extras), extras)
	}
}

// 逐钩循环换饵后，拟饵属性必须跟着当前钩位重算。
// 修复前 lureKnown 只算第一次，第二钩会继续沿用第一钩的拟饵。
func TestPrepareFishRollRuntimeRecomputesLureForNewBaits(t *testing.T) {
	s, _ := newRigTestServer(t)
	c := fishRollContext{rigType: 50, baits: []string{"pilkerlures_2630"}}
	s.prepareFishRollRuntime(t.Context(), &c, "loc12_15")
	if !c.runtime.lureKnown || c.runtime.lure.ItemID != "pilkerlures_2630" {
		t.Fatalf("第一组饵的拟饵属性未解析: known=%v item=%q",
			c.runtime.lureKnown, c.runtime.lure.ItemID)
	}

	// 模拟下一个钩位换了一枚真实拟饵：属性必须更新，不能沿用上一钩。
	c.baits = []string{"monojig_2418"}
	s.prepareFishRollRuntime(t.Context(), &c, "loc12_15")
	if !c.runtime.lureKnown || c.runtime.lure.ItemID != "monojig_2418" {
		t.Fatalf("换饵后拟饵属性未重算: known=%v item=%q",
			c.runtime.lureKnown, c.runtime.lure.ItemID)
	}

	// 换成不含真实拟饵的钩位（只有天然饵）时应清空，而不是留着上一钩。
	c.baits = []string{"worm_01"}
	s.prepareFishRollRuntime(t.Context(), &c, "loc12_15")
	if c.runtime.lureKnown || c.runtime.lure.ItemID != "" {
		t.Fatalf("只有天然饵时应清空拟饵属性: known=%v item=%q",
			c.runtime.lureKnown, c.runtime.lure.ItemID)
	}
}
