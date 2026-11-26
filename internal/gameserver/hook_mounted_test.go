package gameserver

import (
	"strings"
	"testing"
	"time"

	"rf4server/internal/logging"
	"rf4server/internal/proto"
	"rf4server/internal/wiregen"
)

// hookFlagsOut 读钩对象 hgaijieklek 当前值。
func hookFlagsOut(t *testing.T, hook *proto.Value) uint64 {
	t.Helper()
	idx := fieldIdxByCS("agedjipcnpe", csStateEnum)
	if idx < 0 || idx >= len(hook.Fields) || hook.Fields[idx].Num == nil {
		t.Fatalf("钩对象缺少 %s 字段", csStateEnum)
	}
	return *hook.Fields[idx].Num
}

// markHookMounted 补挂竿位：官方四钓法抓包口径（钩 20992 | 1024 = 22016），
// 缺位时客户端钩实体不进搏鱼态。裸钩与容器嵌套钩两种推送形状都必须补齐。
func TestMarkHookMountedBareHook(t *testing.T) {
	hook := wiregen.MustMakeObj("agedjipcnpe", map[int]*proto.Value{
		fieldIdxByCS("agedjipcnpe", csStateEnum): proto.U32(20992),
	})
	markHookMounted(hook)
	if got := hookFlagsOut(t, hook); got != 22016 {
		t.Fatalf("裸钩 flags=%d, 期望 22016 (20992|1024)", got)
	}
}

func TestMarkHookMountedNestedRig(t *testing.T) {
	// 路亚/海钓串钩形状：ioombppcnlh 容器 f0 挂 ARGS(60)[钩...]，钩在树深处。
	inner := wiregen.MustMakeObj("agedjipcnpe", map[int]*proto.Value{
		fieldIdxByCS("agedjipcnpe", csStateEnum): proto.U32(20992),
	})
	container := wiregen.MustMakeObj("ioombppcnlh", map[int]*proto.Value{
		0: proto.Args(proto.S("60"), inner),
	})
	markHookMounted(container)
	if got := hookFlagsOut(t, inner); got != 22016 {
		t.Fatalf("嵌套钩 flags=%d, 期望 22016", got)
	}
}

func TestMarkHookMountedNilAndNonHook(t *testing.T) {
	markHookMounted(nil)
	rod := wiregen.MustMakeObj("kkmhfbeldpg", nil)
	markHookMounted(rod) // 非钩对象递归无副作用, 仅要求不 panic
}

// 多钩钓组逐钩挂竿位：每枚挂了鱼的钩单独推 4/22，互不影响。
// 实机 2026-11-13：倒钓臂 4 枚钩全挂了鱼，但只有主鱼那枚在 14/11 拿到挂竿位，
// 其余钩停在静止件状态，鱼模型不会挂上去——拉上来只看得见一条。
func TestBuildHookTreeByGUIDMarksOnlyItsOwnHook(t *testing.T) {
	t.Parallel()
	s, _ := newRigTestServer(t)
	hook, err := s.CreateItem(t.Context(), 1000001, "c_hook_20712", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateItem(t.Context(), 1000001, "c_hook_20712", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}

	tree := s.buildHookTreeByGUID(t.Context(), hook.GUID)
	if tree == nil {
		t.Fatal("按 GUID 取不到钩树")
	}
	markHookMounted(tree)
	if got := hookFlagsOut(t, tree); got&hookMountedFlag == 0 {
		t.Fatalf("目标钩未补挂竿位: flags=%d", got)
	}

	otherTree := s.buildHookTreeByGUID(t.Context(), other.GUID)
	if otherTree == nil {
		t.Fatal("第二枚钩取不到树")
	}
	if got := hookFlagsOut(t, otherTree); got&hookMountedFlag != 0 {
		t.Fatalf("只该影响自己那枚钩, 另一枚却被改了: flags=%d", got)
	}
}

// 14/11 中鱼钩帧必须按本杆实际中鱼的钩位推送。
//
// 实机 2026-11-26 23:49（rig 50，倒钓臂 250/1001/1005/1009）：thynnus_t 咬
// 1005，但 14/11 只给线末端钩 250 补了挂竿位，客户端把鱼挂到 250 上——收线后
// 250/1001 出水，1005 与鱼模型被拉在水下。这里锁定 4/22 必须指向 fish.HookGUID。
func TestPushFightHookMountedUsesFishHookGUID(t *testing.T) {
	t.Parallel()
	srv, _ := newDetachTestServer(t)
	ctx := t.Context()
	const uid = int64(1000001)
	rod, err := srv.CreateItem(ctx, uid, "boatr_10213_012", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	if !srv.rigSetType(ctx, uid, rod.GUID, 50) {
		t.Fatal("rigSetType 50 Ошибка")
	}
	mainHook, err := srv.CreateItem(ctx, uid, "c_hook_20712", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	armHook, err := srv.CreateItem(ctx, uid, "c_hook_20712", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range []struct {
		guid  string
		extra int64
	}{{mainHook.GUID, 250}, {armHook.GUID, 1001}} {
		res := srv.rigSetComponent(ctx, uid, rod.GUID, catHook, m.guid, m.extra,
			rigSetOpts{ParentType: familyRod, EnforceCategory: true})
		if res.Rejected || res.MountedGUID == "" {
			t.Fatalf("装钩(extra=%d) 被拒: %+v", m.extra, res)
		}
	}

	conn, peer := cleanupTestTunnel(t, "fight-hook-mounted")
	live := registerBiteTestSession(t, srv, 404, conn)
	received := receiveTestPush(peer, 4, 22)
	live.pushFightHookMounted(rod.GUID, &RolledFish{HookGUID: armHook.GUID})

	var env *proto.Envelope
	select {
	case env = <-received:
	case <-time.After(2 * time.Second):
		t.Fatal("4/22 挂载推送超时")
	}
	dec, _, err := proto.DecodeValue(env.Body, 0, srv.Table())
	if err != nil || dec.ArgCodeStr() != "61" {
		t.Fatalf("4/22 应为 args(61): %v", err)
	}
	if len(dec.Items) != 1 {
		t.Fatalf("按钩 GUID 推送应只有 1 棵树, 实得 %d (%v)", len(dec.Items), classList(dec.Items))
	}
	got := dec.Items[0]
	gi := fieldIdxByCS(got.Class, csGUID)
	if gi < 0 || gi >= len(got.Fields) || !strings.EqualFold(got.Fields[gi].GuidHex(), armHook.GUID) {
		t.Fatalf("4/22 推的是 %q, 期望本次中鱼的倒钓臂钩 %s", got.Fields[gi].GuidHex(), shortGUID(armHook.GUID))
	}
	if flags := objFlagsOf(t, got); flags&hookMountedFlag == 0 {
		t.Fatalf("中鱼钩未补挂竿位: flags=%d", flags)
	}
}

// 取不到咬钩钩的独立物品行（内置钩/悬空引用）时回退线末端钩形状，
// 不能因为多钩改动把原有单钩/路亚中鱼帧发空。
func TestPushFightHookMountedFallsBackToMountedHook(t *testing.T) {
	t.Parallel()
	srv, _ := newDetachTestServer(t)
	ctx := t.Context()
	const uid = int64(1000001)
	rod, err := srv.CreateItem(ctx, uid, "boatr_10213_012", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	if !srv.rigSetType(ctx, uid, rod.GUID, 50) {
		t.Fatal("rigSetType 50 Ошибка")
	}
	mainHook, err := srv.CreateItem(ctx, uid, "c_hook_20712", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	res := srv.rigSetComponent(ctx, uid, rod.GUID, catHook, mainHook.GUID, 250,
		rigSetOpts{ParentType: familyRod, EnforceCategory: true})
	if res.Rejected || res.MountedGUID == "" {
		t.Fatalf("装钩(extra=250) 被拒: %+v", res)
	}

	conn, peer := cleanupTestTunnel(t, "fight-hook-fallback")
	live := registerBiteTestSession(t, srv, 405, conn)
	received := receiveTestPush(peer, 4, 22)
	live.pushFightHookMounted(rod.GUID, &RolledFish{HookGUID: "00112233445566778899aabbccddeeff"})

	var env *proto.Envelope
	select {
	case env = <-received:
	case <-time.After(2 * time.Second):
		t.Fatal("4/22 挂载推送超时")
	}
	dec, _, err := proto.DecodeValue(env.Body, 0, srv.Table())
	if err != nil || dec.ArgCodeStr() != "61" || len(dec.Items) != 1 {
		t.Fatalf("回退帧应为单钩 args(61): err=%v items=%d", err, len(dec.Items))
	}
	got := dec.Items[0]
	gi := fieldIdxByCS(got.Class, csGUID)
	if gi < 0 || gi >= len(got.Fields) || !strings.EqualFold(got.Fields[gi].GuidHex(), mainHook.GUID) {
		t.Fatalf("回退应推线末端钩 %s, 实得 %q", shortGUID(mainHook.GUID), got.Fields[gi].GuidHex())
	}
	if flags := objFlagsOf(t, got); flags&hookMountedFlag == 0 {
		t.Fatalf("回退钩未补挂竿位: flags=%d", flags)
	}
}

// 空会话/空鱼不得 panic。
func TestPushFightHookMountedNilSafe(t *testing.T) {
	var nilSess *Session
	nilSess.pushFightHookMounted("", nil)
}

// 空会话/空 GUID 不得 panic。
func TestPush4_22HookGUIDNoop(t *testing.T) {
	t.Parallel()
	s, _ := newRigTestServer(t)
	var nilSess *Session
	if nilSess.Push4_22HookGUID("abc", true) {
		t.Fatal("空会话不应推送成功")
	}
	sess := &Session{Srv: s, Userid: 1000001, log: logging.Discard()}
	if sess.Push4_22HookGUID("", true) {
		t.Fatal("空钩 GUID 不应推送成功")
	}
}
