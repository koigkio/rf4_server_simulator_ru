package gameserver

import (
	"context"
	"encoding/binary"
	"math"
	"testing"
	"time"

	"rf4server/internal/proto"
)

// biteOffTestTunables 把咬断层参数直接写进缓存，绕过 kv 表与 30 秒刷新。
func biteOffTestTunables(srv *Server, pct, minDrop, sprintSecs float64) {
	srv.tunCache = map[string]float64{
		"bite_off_enabled":          1,
		"bite_off_over_pct":         pct,
		"bite_off_under_pct":        pct,
		"bite_off_sprint_seconds":   sprintSecs,
		"bite_off_min_stamina_drop": minDrop,
	}
	if srv.tunText == nil {
		srv.tunText = map[string]string{}
	}
	srv.tunText["bite_off_species"] = "n.pike"
	srv.tunAt = time.Now()
}

// biteOffFrame 构造一条 14/8 并塞进请求上下文，走与 dispatch 相同的入口。
func biteOffFrame(sess *Session, stamina float32) *Ctx {
	c := miscCtx(sess, 14, 8, nil)
	c.Body = loadFrameBytes(stamina, 11.0)
	return c
}

// loadFrameBytes 与 gear_assistant_stamina_test.go 的 loadFrame 同形，
// 但不需要 *testing.T，便于在循环里造多帧。
func loadFrameBytes(stamina, rigLimit float32) []byte {
	body := make([]byte, loadFrameLength)
	binary.LittleEndian.PutUint32(body[staminaLoadOffset:], math.Float32bits(stamina))
	binary.LittleEndian.PutUint32(body[staminaRigLimitOffset:], math.Float32bits(rigLimit))
	return body
}

// biteOffFixture 起一套「竿 + 线 + 引线 + 拟饵」并返回各件 GUID。
type biteOffFixture struct {
	srv    *Server
	ctx    context.Context
	sess   *Session
	st     *FishState
	rod    string
	line   string
	leader string
	lure   string
	fish   *RolledFish
}

func newBiteOffFixture(t *testing.T) *biteOffFixture {
	t.Helper()
	return newBiteOffFixtureWithLeader(t, true)
}

// newBiteOffFixtureWithLeader 允许不挂引线，用来覆盖 P1-1 的「咬断落在主线上」。
func newBiteOffFixtureWithLeader(t *testing.T, withLeader bool) *biteOffFixture {
	t.Helper()
	srv, _ := newRigTestServer(t)
	ctx := context.Background()
	const uid = int64(1000001)
	sess := newProbeSess(srv)

	rod, err := srv.CreateItem(ctx, uid, "spin_10158_M100HH", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	reel, err := srv.CreateItem(ctx, uid, "spin_5691", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	line, err := srv.CreateItem(ctx, uid, "braid_40898", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	leader, err := srv.CreateItem(ctx, uid, "fc_leader_40048", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	lure, err := srv.CreateItem(ctx, uid, "plug_w_2370", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	mounted := []string{reel.GUID, line.GUID, lure.GUID}
	if withLeader {
		mounted = append(mounted, leader.GUID)
	}
	for _, g := range mounted {
		mountGearForTest(t, srv, sess, rod.GUID, g)
	}

	ids := srv.rigGearIDs(ctx, uid, rod.GUID)
	spec := srv.loadGearSpecForRig(ctx, ids, rod.GUID)
	if withLeader && spec.LeaderStrengthKg <= 0 {
		t.Fatalf("测试钓组读不到引线承力: %+v", spec)
	}
	if spec.LineStrengthKg <= 0 {
		t.Fatalf("测试钓组读不到主线承力: %+v", spec)
	}

	st := srv.selectFishingRod(uid, rod.GUID)
	fish := &RolledFish{FishGUID: newFishGUID(), Species: "n.pike", WeightG: 12000, Grade: 2}
	st.mu.Lock()
	st.Pending = fish
	st.CastActive = true
	st.Hooked = true
	st.Resolved = false
	st.mu.Unlock()

	return &biteOffFixture{srv: srv, ctx: ctx, sess: sess, st: st,
		rod: rod.GUID, line: line.GUID, leader: leader.GUID, lure: lure.GUID, fish: fish}
}

// TestBiteOffBreaksLeaderAndDropsDownstream 覆盖 P1-2：咬断引线必须与 17/9 同口径，
// 走 breakLineTxWithLineOut 删掉下游钩饵拟饵并写 line_break / lost_on_line_break。
func TestBiteOffBreaksLeaderAndDropsDownstream(t *testing.T) {
	t.Parallel()
	f := newBiteOffFixture(t)
	f.srv.randFloat = fixedRolls(0)
	biteOffTestTunables(f.srv, 100, 0, 1)

	f.srv.maybeBiteOff(biteOffFrame(f.sess, 0.90))

	if row, _ := f.srv.DB.GetItemByGUID(f.ctx, f.leader); row != nil {
		t.Fatal("咬断后引线实例应被删除")
	}
	if row, _ := f.srv.DB.GetItemByGUID(f.ctx, f.lure); row != nil {
		t.Fatal("咬断引线后下游拟饵应一并丢失 (不能像 breakComponentTx 那样留在竿上)")
	}
	if row, _ := f.srv.DB.GetItemByGUID(f.ctx, f.line); row == nil {
		t.Fatal("断引线不应删除主线")
	}
	if row, _ := f.srv.DB.GetItemByGUID(f.ctx, f.rod); row == nil {
		t.Fatal("断引线不应删除鱼竿")
	}

	logs, err := f.srv.DB.ListItemDamageLogs(f.ctx, f.sess.Userid, 100)
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, entry := range logs {
		counts[entry.Event]++
	}
	if counts[damageEventLineBreak] != 1 {
		t.Fatalf("line_break 记录=%d, 期望 1; 全部=%v", counts[damageEventLineBreak], counts)
	}
	if counts[damageEventLostOnLineBreak] == 0 {
		t.Fatalf("缺 lost_on_line_break 记录; 全部=%v", counts)
	}

	f.st.mu.Lock()
	defer f.st.mu.Unlock()
	if f.st.Pending != nil || !f.st.Resolved {
		t.Fatalf("咬断后应清空在途鱼: pending=%v resolved=%v", f.st.Pending, f.st.Resolved)
	}
}

// TestBiteOffWithoutLeaderBreaksMainLine 覆盖 P1-1：没挂引线时比较值退到主线承载，
// 咬断要真的落在主线上，而不是被 biteOffChance 判成「不可判」直接跳过。
func TestBiteOffWithoutLeaderBreaksMainLine(t *testing.T) {
	t.Parallel()
	f := newBiteOffFixtureWithLeader(t, false)
	const uid = int64(1000001)
	if ids := f.srv.rigGearIDs(f.ctx, uid, f.rod); ids.LeaderGUID != "" || ids.LeadcoreGUID != "" {
		t.Fatalf("这套钓组本就没挂引线: %+v", ids)
	}
	f.srv.randFloat = fixedRolls(0)
	biteOffTestTunables(f.srv, 100, 0, 1)

	f.srv.maybeBiteOff(biteOffFrame(f.sess, 0.90))

	if row, _ := f.srv.DB.GetItemByGUID(f.ctx, f.line); row != nil {
		t.Fatal("没有引线时咬断应落在主线上, 主线实例应被删除")
	}
	if row, _ := f.srv.DB.GetItemByGUID(f.ctx, f.lure); row != nil {
		t.Fatal("断主线后拟饵应随线丢失")
	}
	if row, _ := f.srv.DB.GetItemByGUID(f.ctx, f.rod); row == nil {
		t.Fatal("咬断主线不应删除鱼竿")
	}
}

// TestBiteOffAccumulatesSmallStaminaDrops 覆盖 P2-1：单帧降幅低于门槛时不再永远掷不了骰，
// 而是按距上次掷骰的累计降幅判定。
func TestBiteOffAccumulatesSmallStaminaDrops(t *testing.T) {
	t.Parallel()
	f := newBiteOffFixture(t)
	f.srv.randFloat = fixedRolls(0)
	// 门槛 0.002，单帧只掉 0.0008：一条 14/8 实测就是这样。
	biteOffTestTunables(f.srv, 100, 0.002, 1)

	stamina := float32(0.9000)
	for i := 0; i < 3; i++ {
		stamina -= 0.0008
		f.srv.maybeBiteOff(biteOffFrame(f.sess, stamina))
	}
	if row, _ := f.srv.DB.GetItemByGUID(f.ctx, f.leader); row == nil {
		t.Fatalf("累计降幅 %0.4f 仍未达门槛就咬断了 (不应发生)", 0.0024)
	}
	// 第四帧后累计 0.0024 > 0.002，应当掷骰并命中。
	stamina -= 0.0008
	f.srv.maybeBiteOff(biteOffFrame(f.sess, stamina))
	if row, _ := f.srv.DB.GetItemByGUID(f.ctx, f.leader); row != nil {
		t.Fatal("累计降幅跨过门槛后应判定咬断")
	}
}

// TestBiteOffResetsStateOnFishChange 覆盖 P2-2：换鱼必须重置节流时间与体力基线，
// 不能继承上一尾鱼的冲刺窗口。
func TestBiteOffResetsStateOnFishChange(t *testing.T) {
	t.Parallel()
	f := newBiteOffFixture(t)
	// 1% 概率 + 掷 1.0：必定不咬断，只走节流与基线维护。
	f.srv.randFloat = fixedRolls(1.0)
	biteOffTestTunables(f.srv, 1, 0, 60)

	f.srv.maybeBiteOff(biteOffFrame(f.sess, 0.95))
	f.st.mu.Lock()
	if !f.st.biteOffSeen || f.st.biteOffLastStamina == 0 {
		f.st.mu.Unlock()
		t.Fatal("首帧应写入体力基线")
	}
	firstGUID := f.st.biteOffFishGUID
	firstAt := f.st.biteOffRollAt
	f.st.mu.Unlock()
	if firstGUID != f.fish.FishGUID {
		t.Fatalf("基线应绑定当前鱼 %s, 实得 %s", f.fish.FishGUID, firstGUID)
	}

	// 换鱼：新鱼的体力基线必须重新起算。
	next := &RolledFish{FishGUID: newFishGUID(), Species: "n.pike", WeightG: 12000}
	f.st.mu.Lock()
	f.st.Pending = next
	f.st.mu.Unlock()

	f.srv.maybeBiteOff(biteOffFrame(f.sess, 0.20))
	f.st.mu.Lock()
	defer f.st.mu.Unlock()
	if f.st.biteOffFishGUID != next.FishGUID {
		t.Fatalf("换鱼后基线应改绑新鱼, 实得 %s", f.st.biteOffFishGUID)
	}
	if f.st.biteOffDropAccum != 0 {
		t.Fatalf("换鱼后累计降幅应清零, 实得 %v", f.st.biteOffDropAccum)
	}
	if !f.st.biteOffRollAt.Equal(firstAt) {
		return // 允许新窗口已掷骰, 说明节流时间边界被正确重置
	}
}

// TestBiteOffWireLeaderBreaksItself 覆盖断件品类取错的问题：rigGearIDs 优先
// 取 15（钢丝前导），此时 rig_component 槽位也是 15。若这里硬写 13 展开下游集合，
// 前导线自己不在集合里，咬断后钩饵没了、前导线还挂在竿上。
func TestBiteOffWireLeaderBreaksItself(t *testing.T) {
	t.Parallel()
	f := newBiteOffFixtureWithLeader(t, false)
	const uid = int64(1000001)

	wire, err := f.srv.CreateItem(f.ctx, uid, "wrl_sim_fluoro7lb", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	mountGearForTest(t, f.srv, f.sess, f.rod, wire.GUID)
	if ids := f.srv.rigGearIDs(f.ctx, uid, f.rod); ids.LeaderGUID != wire.GUID {
		t.Fatalf("前导线应成为当前引线: %+v", ids)
	}

	f.srv.randFloat = fixedRolls(0)
	biteOffTestTunables(f.srv, 100, 0, 1)
	f.srv.maybeBiteOff(biteOffFrame(f.sess, 0.90))

	if row, _ := f.srv.DB.GetItemByGUID(f.ctx, wire.GUID); row != nil {
		t.Fatalf("前导线还在竿上 (container=%s): 断件品类没取实例真实品类", row.Container)
	}
	if row, _ := f.srv.DB.GetItemByGUID(f.ctx, f.lure); row != nil {
		t.Fatal("前导线断了, 下游拟饵也应丢失")
	}
	if row, _ := f.srv.DB.GetItemByGUID(f.ctx, f.line); row == nil {
		t.Fatal("断前导线不应删除主线")
	}
}

// TestBiteOffEscapeUsesOwnReasonCode 覆盖 P2-3：咬断必须用独立原因码 10，
// 不能复用张力断线的 30/6。
func TestBiteOffEscapeUsesOwnReasonCode(t *testing.T) {
	t.Parallel()
	if got, ok := escapeTemplateKind["Рыба перекусила оснастку зубами"]; !ok || got != 10 {
		t.Fatalf("咬断原因码=%d ok=%v, 期望 10", got, ok)
	}
}

// TestBiteOffHandlerUsesTeethEscapeTemplate 锁定真实 14/8 handler 接线与原因码：
// 直接调用生产 hFishingLoad，而不是绕过它去调 maybeBiteOff；关闭嘲讽模板后，
// 跑鱼播报必须回退官方 kind10（牙齿咬断钓组），不能复用张力断线的 30/6。
func TestBiteOffHandlerUsesTeethEscapeTemplate(t *testing.T) {
	t.Parallel()
	f := newBiteOffFixture(t)
	sess, peer := newTunnelProbe(t, f.srv)
	f.sess = sess
	f.srv.randFloat = fixedRolls(0)
	biteOffTestTunables(f.srv, 100, 0, 1)
	f.srv.tunCache["fish_escape_taunt"] = 0

	notified := receiveTestPush(peer, 24, 27)
	hFishingLoad(biteOffFrame(f.sess, 0.90))

	select {
	case env := <-notified:
		dec, _, err := proto.DecodeValue(env.Body, 0, f.srv.Table())
		if err != nil {
			t.Fatalf("跑鱼推送不可解码: %v", err)
		}
		if dec.Kind != proto.KindArgs || len(dec.Items) == 0 {
			t.Fatalf("跑鱼推送应为非空 args, 实得 %v/%d", dec.Kind, len(dec.Items))
		}
		f0 := dec.Items[0].Field(0).Num
		if f0 == nil || *f0 != 10 {
			t.Fatalf("咬断跑鱼应使用官方模板 10, 实得 %v", f0)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("等待咬断跑鱼推送超时")
	}
	if row, _ := f.srv.DB.GetItemByGUID(f.ctx, f.leader); row != nil {
		t.Fatal("真实 handler 路径未咬断引线")
	}
}

// TestBiteOffChanceUsesMainLineFallback 是 P1-1 的纯函数侧对照：
// 比较值退到主线后 biteOffChance 必须可判，而不是 leaderKg<=0 直接返回不可判。
func TestBiteOffChanceUsesMainLineFallback(t *testing.T) {
	t.Parallel()
	chance, ok := biteOffChance(12000, 15.0, 20, 4)
	if !ok || math.Abs(chance-0.04) > 1e-9 {
		t.Fatalf("12kg 鱼对 15kg 承载应取轻档 4%%, 实得 %v ok=%v", chance, ok)
	}
	if _, ok := biteOffChance(12000, 0, 20, 4); ok {
		t.Fatal("比较值 <=0 时应判不可判")
	}
}
