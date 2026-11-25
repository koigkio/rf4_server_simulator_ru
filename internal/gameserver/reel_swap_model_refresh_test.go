package gameserver

// 电轮换普通轮“不生效”的通信回归：
// 16/1、16/2 只回全量 800（竿树在 f0 新增段），客户端的竿建模不随快照重建。
// 实机表现：其它轮换电轮实时生效，电轮换普通轮仍停在电动模式，必须收起再
// 取竿（17/7 重建 158）才清掉。修复：装/拆轮回包后补推版本戳更大的 4/22
// 竿树，与 17/3 拆轮同因同修法（rig_detach_model_refresh_test.go）。

import (
	"context"
	"testing"

	"rf4server/internal/logging"
	"rf4server/internal/proto"
	"rf4server/internal/tunnel"
	"rf4server/internal/wiregen"
)

// snapshotTreeAt 从 800 响应第 seg 段（f0 新增 / f1 更新）里取出指定 guid 的物品树。
func snapshotTreeAt(t *testing.T, body []byte, seg int, guid string) *proto.Value {
	t.Helper()
	dec, end, err := proto.DecodeValue(body, 0, wiregen.Table())
	if err != nil || end != len(body) {
		t.Fatalf("解码 800 响应失败: err=%v end=%d len=%d", err, end, len(body))
	}
	if dec.Kind != proto.KindObj || dec.FieldCount() <= seg {
		t.Fatalf("800 响应形状异常: kind=%v fields=%d", dec.Kind, dec.FieldCount())
	}
	segVal := dec.Field(seg).Val
	if segVal == nil || segVal.Kind != proto.KindArgs {
		t.Fatalf("800 f%d 段不是 args", seg)
	}
	for _, it := range segVal.Items {
		if it == nil || it.Kind != proto.KindObj {
			continue
		}
		if gidx := fieldIdxByCS(it.Class, csGUID); gidx >= 0 && it.Fields[gidx].GuidHex() == guid {
			return it
		}
	}
	t.Fatalf("800 f%d 段里没有 %s 树", seg, guid)
	return nil
}

// treeCreatedVersion 读物品树的版本戳（csCreated）。
func treeCreatedVersion(t *testing.T, tree *proto.Value) uint64 {
	t.Helper()
	cidx := fieldIdxByCS(tree.Class, csCreated)
	if cidx < 0 || tree.Fields[cidx].Num == nil {
		t.Fatal("树里读不到版本戳")
	}
	return *tree.Fields[cidx].Num
}

// reelFieldGUID 读竿树的 f4（渔轮 GUID）。
func reelFieldGUID(tree *proto.Value) string {
	if tree == nil || len(tree.Fields) <= 4 {
		return ""
	}
	return tree.Fields[4].GuidHex()
}

// awaitRodModelPush 等一条 4/22 推送并取出其中的竿树，断言版本戳严格大于
// 响应里的竿树版本（客户端只接受严格变大的更新）。
func awaitRodModelPush(t *testing.T, gc *tunnel.Conn, rodGUID string, respVer uint64) *proto.Value {
	t.Helper()
	push := awaitPushEnvelope(t, gc)
	if push.Main != 4 || push.Sub != 22 {
		t.Fatalf("补推 = %d/%d, want 4/22", push.Main, push.Sub)
	}
	dec, _, err := proto.DecodeValue(push.Body, 0, wiregen.Table())
	if err != nil {
		t.Fatal(err)
	}
	if dec.Kind != proto.KindArgs || dec.Code == nil || *dec.Code != "61" {
		t.Fatalf("推送形状不是 args(61): kind=%v code=%v", dec.Kind, dec.Code)
	}
	for _, it := range dec.Items {
		if it == nil || it.Kind != proto.KindObj {
			continue
		}
		gidx := fieldIdxByCS(it.Class, csGUID)
		if gidx < 0 || it.Fields[gidx].GuidHex() != rodGUID {
			continue
		}
		if got := treeCreatedVersion(t, it); got <= respVer {
			t.Fatalf("推送版本戳 %d 必须严格大于响应版本戳 %d", got, respVer)
		}
		return it
	}
	t.Fatal("4/22 推送里没有竿树")
	return nil
}

// TestReelSwapToPlainPushesRodModelRefresh 16/1 电轮换普通轮：回包后必须补推
// 竿树，推送里 f4 已是新轮且版本戳更大——客户端据此重建模型、退出电动模式。
func TestReelSwapToPlainPushesRodModelRefresh(t *testing.T) {
	srv, _ := newRigTestServer(t)
	ctx := context.Background()
	const uid = int64(1000001)

	rod, err := srv.CreateItem(ctx, uid, "tele_10180_4", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	electric, err := srv.CreateItem(ctx, uid, "elcon_5999", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := srv.CreateItem(ctx, uid, "spin_5820", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	mountGearForTest(t, srv, nil, rod.GUID, electric.GUID)

	sess, gc := newTunnelProbe(t, srv)
	req := proto.Args524(
		proto.U32(0),
		proto.Guid(rod.GUID),
		proto.U32(0),
		proto.Guid(plain.GUID),
	)
	c := &Ctx{Sess: sess, Main: 16, Sub: 1, Tree: rigRequestTree(t, req),
		ExpectResponse: true, Log: logging.Discard()}
	body, ok := hReelSetComp(c)
	if !ok || len(body) == 0 {
		t.Fatal("16/1 换轮未回包")
	}
	// 16/1 回全量快照：竿树在 f0。
	respRod := snapshotTreeAt(t, body, 0, rod.GUID)
	if got := reelFieldGUID(respRod); got != plain.GUID {
		t.Fatalf("响应竿树 f4=%s, want 新轮 %s", got, plain.GUID)
	}
	respVer := treeCreatedVersion(t, respRod)

	if len(c.afterResponse) != 1 {
		t.Fatalf("换轮后应注册一次竿建模刷新，实得 %d", len(c.afterResponse))
	}
	c.afterResponse[0]()

	pushed := awaitRodModelPush(t, gc, rod.GUID, respVer)
	if got := reelFieldGUID(pushed); got != plain.GUID {
		t.Fatalf("推送竿树 f4=%s, want %s（旧电轮应已摘掉）", got, plain.GUID)
	}
}

// TestReelRemovePushesRodModelRefresh 16/2 拆电轮：回包后补推 f4 为空的竿树。
func TestReelRemovePushesRodModelRefresh(t *testing.T) {
	srv, _ := newRigTestServer(t)
	ctx := context.Background()
	const uid = int64(1000001)

	rod, err := srv.CreateItem(ctx, uid, "tele_10180_4", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	electric, err := srv.CreateItem(ctx, uid, "elcon_5999", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	mountGearForTest(t, srv, nil, rod.GUID, electric.GUID)

	sess, gc := newTunnelProbe(t, srv)
	req := proto.Args524(
		proto.U32(0),
		proto.Guid(rod.GUID),
		proto.U32(6),
		proto.Guid(electric.GUID),
		proto.U32(0),
	)
	c := &Ctx{Sess: sess, Main: 16, Sub: 2, Tree: rigRequestTree(t, req),
		ExpectResponse: true, Log: logging.Discard()}
	body, ok := hReelRemoveComp(c)
	if !ok || len(body) == 0 {
		t.Fatal("16/2 拆轮未回包")
	}
	respRod := snapshotTreeAt(t, body, 0, rod.GUID)
	if got := reelFieldGUID(respRod); got != "" {
		t.Fatalf("响应竿树 f4=%s, want 空", got)
	}
	respVer := treeCreatedVersion(t, respRod)

	if len(c.afterResponse) != 1 {
		t.Fatalf("拆轮后应注册一次竿建模刷新，实得 %d", len(c.afterResponse))
	}
	c.afterResponse[0]()

	pushed := awaitRodModelPush(t, gc, rod.GUID, respVer)
	if got := reelFieldGUID(pushed); got != "" {
		t.Fatalf("推送竿树 f4=%s, want 空（电轮已拆）", got)
	}
}

// TestRodSetCompReelPushesRodModelRefresh 17/2 是通用装竿路径，装轮同样要补推。
func TestRodSetCompReelPushesRodModelRefresh(t *testing.T) {
	srv, _ := newRigTestServer(t)
	ctx := context.Background()
	const uid = int64(1000001)

	rod, err := srv.CreateItem(ctx, uid, "tele_10180_4", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	electric, err := srv.CreateItem(ctx, uid, "elcon_5999", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := srv.CreateItem(ctx, uid, "spin_5820", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	mountGearForTest(t, srv, nil, rod.GUID, electric.GUID)

	sess, gc := newTunnelProbe(t, srv)
	req := proto.Args524(
		proto.U32(0),
		proto.Guid(rod.GUID),
		proto.U32(0),
		proto.Guid(plain.GUID),
		proto.U32(0),
	)
	c := &Ctx{Sess: sess, Main: 17, Sub: 2, Tree: rigRequestTree(t, req),
		ExpectResponse: true, Log: logging.Discard()}
	body, ok := hRodSetComp(c)
	if !ok || len(body) == 0 {
		t.Fatal("17/2 换轮未回包")
	}
	// 17/2 是增量快照：竿树在 f1。
	respRod := snapshotTreeAt(t, body, 1, rod.GUID)
	respVer := treeCreatedVersion(t, respRod)

	if len(c.afterResponse) != 1 {
		t.Fatalf("装轮后应注册一次竿建模刷新，实得 %d", len(c.afterResponse))
	}
	c.afterResponse[0]()

	pushed := awaitRodModelPush(t, gc, rod.GUID, respVer)
	if got := reelFieldGUID(pushed); got != plain.GUID {
		t.Fatalf("推送竿树 f4=%s, want %s", got, plain.GUID)
	}
}
