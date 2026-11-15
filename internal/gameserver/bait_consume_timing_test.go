package gameserver

// 扣饵时机回归（specs/changes/bait-consume-fight-end）：
// 中鱼确认（14/11）瞬间扣饵会推送 4/21 + 竿树重建 4/22，正好落进客户端搏鱼
// ctor 的挂载态读取窗口（f5 去饵 + flags=定义基值缺挂载运行位）→ 钩组/传动
// 链构造失败 → f4=0 秒脱。扣饵必须挪到搏鱼终局（14/12/14/5/14/6/14/4），
// 四个出口共享 txn(uid,'bait_bite',FishGUID) 幂等键。

import (
	"strings"
	"testing"

	"rf4server/internal/logging"
	"rf4server/internal/proto"
)

// 带饵钩 14/11 中鱼确认：饵实例仍在钩上、来源库存不扣、无 4/21 扣饵推送。
func TestHookConfirmDoesNotConsumeOrPushBait(t *testing.T) {
	s, db := newRigTestServer(t)
	if err := db.Migrate(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopFishingRecoveryTimers(s) })
	sess, _ := newTunnelProbe(t, s)
	s.sessions[sess.ID] = sess
	uid := sess.Userid
	if _, err := db.EnsureProfile(t.Context(), uid); err != nil {
		t.Fatal(err)
	}

	rod, err := s.CreateItem(t.Context(), uid, "tele_10012_tl16", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	mountHookForBaitTest(t, s, rod.GUID, 0)
	source, child := baitTestMount(t, s, rod.GUID, "worm_01", 5, 350)

	fish := &RolledFish{FishGUID: newFishGUID(), Species: "crucian", Grade: 1,
		WeightG: 500, LengthM: .25, BaitsKnown: true, BaitGUIDs: child}
	st := s.fishingStateForRod(uid, rod.GUID)
	st.mu.Lock()
	st.GearGuid = rod.GUID
	st.Loc = "unknown-map"
	st.Bait = "worm_01"
	st.CastActive, st.InWater = true, true
	st.Pending, st.PushSent, st.Hooked = fish, true, false
	st.mu.Unlock()

	if _, ok := hFishingHooked(&Ctx{Sess: sess, Main: 14, Sub: 11, Log: logging.Discard()}); !ok {
		t.Fatal("14/11 hook confirmation was not handled")
	}
	// 挂饵时已拆堆预留 1 份（来源堆 5→4），中鱼确认不扣饵：来源堆不变、
	// 预留子实例仍在钩上。
	if row, _ := db.GetItemByGUID(t.Context(), source); row == nil || baitQuantity(row) != 4 {
		t.Fatalf("14/11 hook confirmation consumed bait: %+v", row)
	}
	if row, _ := db.GetItemByGUID(t.Context(), child); row == nil {
		t.Fatal("14/11 hook confirmation removed the mounted bait child")
	}
}

// 14/12 跑鱼终局：扣一次饵、4/21 在终局到达；重复终局不重复扣；rebait:0 保留。
func TestEscapeConsumesBaitOnceAfterFight(t *testing.T) {
	s, db := newRigTestServer(t)
	if err := db.Migrate(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopFishingRecoveryTimers(s) })
	sess, gc := newTunnelProbe(t, s)
	s.sessions[sess.ID] = sess
	uid := sess.Userid
	if _, err := db.EnsureProfile(t.Context(), uid); err != nil {
		t.Fatal(err)
	}

	rod, err := s.CreateItem(t.Context(), uid, "tele_10012_tl16", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	mountHookForBaitTest(t, s, rod.GUID, 0)
	source, child := baitTestMount(t, s, rod.GUID, "worm_01", 5, 350)

	fish := &RolledFish{FishGUID: newFishGUID(), Species: "crucian", Grade: 1,
		WeightG: 500, LengthM: .25, BaitsKnown: true, BaitGUIDs: child}
	st := s.fishingStateForRod(uid, rod.GUID)
	st.mu.Lock()
	st.GearGuid = rod.GUID
	st.Loc = "unknown-map"
	st.Bait = "worm_01"
	st.CastActive, st.InWater = true, true
	st.Pending, st.PushSent, st.Hooked = fish, true, true
	st.Resolved = false
	st.mu.Unlock()

	if _, ok := hFishingLeft(&Ctx{Sess: sess, Main: 14, Sub: 12, Log: logging.Discard()}); !ok {
		t.Fatal("14/12 fish-left was not handled")
	}
	if row, _ := db.GetItemByGUID(t.Context(), source); row == nil || baitQuantity(row) != 4 {
		t.Fatalf("fight end did not consume exactly one unit: %+v", row)
	}
	if row, _ := db.GetItemByGUID(t.Context(), child); row != nil {
		t.Fatalf("consumed bait child still exists: %+v", row)
	}
	// 终局扣饵必须推 4/21（饵消失），客户端此时已离开搏鱼态。终局推送集合
	// 有界（播报 + 4/21 + 竿树重建），awaitPushEnvelope 超时即失败。
	sawBaitRemoval := false
	for !sawBaitRemoval {
		env := awaitPushEnvelope(t, gc)
		if env.Main == 4 && env.Sub == 21 {
			sawBaitRemoval = true
		}
	}
	// 重复 14/12：幂等键挡住，不再扣。
	if _, ok := hFishingLeft(&Ctx{Sess: sess, Main: 14, Sub: 12, Log: logging.Discard()}); !ok {
		t.Fatal("replayed 14/12 was not handled")
	}
	if row, _ := db.GetItemByGUID(t.Context(), source); row == nil || baitQuantity(row) != 4 {
		t.Fatalf("replayed fight end consumed another unit: %+v", row)
	}
	// 终局扣饵写 rebait:0（含 hook 归属的 JSON 形态），下一竿自动补同种饵的循环保留。
	var rebait string
	if err := db.SQL.QueryRow(`SELECT value FROM rod_setting WHERE guid=? AND key='rebait:0'`, rod.GUID).Scan(&rebait); err != nil {
		t.Fatalf("rebait:0 setting missing after fight-end consumption: %v", err)
	}
	if !strings.Contains(rebait, "worm_01") {
		t.Fatalf("rebait:0 = %q, want worm_01 request", rebait)
	}
}

// 14/5 入护终局扣一次；随后的 14/4 不重复扣。
func TestKeepConsumesBaitOnce(t *testing.T) {
	s, db := newRigTestServer(t)
	if err := db.Migrate(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopFishingRecoveryTimers(s) })
	sess, _ := newTunnelProbe(t, s)
	s.sessions[sess.ID] = sess
	uid := sess.Userid
	if _, err := db.EnsureProfile(t.Context(), uid); err != nil {
		t.Fatal(err)
	}

	rod, err := s.CreateItem(t.Context(), uid, "tele_10012_tl16", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	mountHookForBaitTest(t, s, rod.GUID, 0)
	source, child := baitTestMount(t, s, rod.GUID, "worm_01", 5, 350)

	fish := &RolledFish{FishGUID: newFishGUID(), Species: "crucian", Grade: 1,
		WeightG: 500, LengthM: .25, XP: 10, Silver: 1,
		BaitsKnown: true, BaitGUIDs: child}
	st := s.fishingStateForRod(uid, rod.GUID)
	st.mu.Lock()
	st.GearGuid = rod.GUID
	st.Loc = "unknown-map"
	st.Bait = "worm_01"
	st.CastActive, st.InWater = true, true
	st.Pending, st.PushSent, st.Hooked = fish, true, true
	st.Resolved = false
	st.mu.Unlock()

	// 14/5 入护（args 带 FishGUID）。
	keepCtx := &Ctx{Sess: sess, Main: 14, Sub: 5, ExpectResponse: true, Log: logging.Discard()}
	keepCtx.Tree = proto.Args(proto.S("524"), proto.Guid(rod.GUID), proto.Guid(fish.FishGUID))
	if _, ok := s.fishingKeep(keepCtx); !ok {
		t.Fatal("14/5 keep was not handled")
	}
	if row, _ := db.GetItemByGUID(t.Context(), source); row == nil || baitQuantity(row) != 4 {
		t.Fatalf("keep did not consume exactly one unit: %+v", row)
	}
	// 14/4 收竿结算：pending 已清（hasFish=false），不重复扣；结算内置的
	// 自动补饵按 rebait:0 从来源堆再预留 1 份（4→3）并挂回钩上。
	endCtx := &Ctx{Sess: sess, Main: 14, Sub: 4, ExpectResponse: true, Log: logging.Discard()}
	if body, ok := s.fishingEndSettle(endCtx); !ok || len(body) == 0 {
		t.Fatalf("14/4 was not handled: ok=%v", ok)
	}
	if row, _ := db.GetItemByGUID(t.Context(), source); row == nil || baitQuantity(row) != 3 {
		t.Fatalf("14/4 after keep: source stack = %+v, want 3 (rebait reserved one)", row)
	}
	if got := len(s.currentBaits(t.Context(), rod.GUID)); got != 1 {
		t.Fatalf("14/4 auto-rebait should mount 1 bait, got %d", got)
	}
}

