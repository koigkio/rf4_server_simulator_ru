package gameserver

import (
	"testing"
	"time"

	"rf4server/internal/proto"
)

// 27/1 出售：只卖散卡（native:18 且未入册），成交价取 def 属性
// obcephkkfhi，回执幂等；800.f2 是唯一删除事件，响应后只推送 2/1 余额。
func TestTradingCardSell(t *testing.T) {
	s, db := newProgressSrv(t)
	seedTradingCards(t, db)
	// 补售价定义
	if _, err := db.SQL.Exec(`UPDATE item_def SET attrs_json=json_set(attrs_json,'$.obcephkkfhi',12000)
		WHERE item_id='card_perch'`); err != nil {
		t.Fatal(err)
	}
	c := t.Context()
	if _, err := db.EnsureProfile(c, 7); err != nil {
		t.Fatal(err)
	}
	card, err := s.CreateItem(c, 7, "card_perch", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	var silverBefore int64
	if err := db.SQL.QueryRow(`SELECT silver FROM profile WHERE uid=7`).Scan(&silverBefore); err != nil {
		t.Fatal(err)
	}
	ctx := tradingAlbumRequest(t, s, 1, 601,
		proto.GuidArr([]string{card.GUID, "ffffffffffffffffffffffffffffffff"}), proto.U64(12000))
	sess, peer := newTunnelProbe(t, s)
	sess.Userid, sess.Token = 7, "album-test"
	ctx.Sess = sess
	result := s.dispatch.executeRequest(ctx, true)
	if !result.hasResponse || result.failed {
		t.Fatalf("sell response: %+v", result)
	}
	if len(ctx.afterResponse) != 1 {
		t.Fatalf("出售后只应安排余额同步，回调数=%d", len(ctx.afterResponse))
	}
	body := result.body
	v, _, err := proto.DecodeValue(body, 0, s.Table())
	if err != nil {
		t.Fatal(err)
	}
	if v.TypeID != 800 || len(v.Fields) < 3 {
		t.Fatalf("27/1 response should be obj-800: %+v", v)
	}
	for i := 0; i < 2; i++ {
		items := v.Fields[i].Val
		if items == nil || items.Kind != proto.KindArgs || items.ArgCodeStr() != "61" || items.ArgCount() != 0 {
			t.Fatalf("27/1 f%d should be an empty 61 array: %+v", i, items)
		}
	}
	removed := v.Fields[2].Val
	if removed.Kind != proto.KindGuidArr || len(removed.Items) != 1 || removed.Items[0].Hex != card.GUID {
		t.Fatalf("27/1 f2 应只含成交卡: %+v", removed)
	}
	ctx.afterResponse[0]()
	walletPush := awaitPushEnvelope(t, peer)
	if walletPush.Main != 2 || walletPush.Sub != 1 {
		t.Fatalf("出售后唯一推送=%d/%d，期望 2/1", walletPush.Main, walletPush.Sub)
	}
	assertNoPush(t, peer, 100*time.Millisecond, "出售后不应追加库存删除或全量卡片同步")
	var silver int64
	if err := db.SQL.QueryRow(`SELECT silver FROM profile WHERE uid=7`).Scan(&silver); err != nil {
		t.Fatal(err)
	}
	if silver-silverBefore != 12000 {
		t.Fatalf("入账错误: %d", silver-silverBefore)
	}
	// 外星 guid 不计价；卡已删除
	if _, err := db.GetItemByGUID(c, card.GUID); err == nil {
		t.Fatal("出售后卡应被删除")
	}
	// 回执幂等：同 call 重放返回缓存 ACK，不重复入账
	replay := tradingAlbumRequest(t, s, 1, 601,
		proto.GuidArr([]string{card.GUID}), proto.U64(12000))
	replayResult := s.dispatch.executeRequest(replay, true)
	if !replayResult.hasResponse || replayResult.failed || len(replayResult.body) == 0 {
		t.Fatalf("sell replay: %+v", replayResult)
	}
	if len(replay.afterResponse) != 0 {
		t.Fatalf("回执重放不应重复安排同步，回调数=%d", len(replay.afterResponse))
	}
	if err := db.SQL.QueryRow(`SELECT silver FROM profile WHERE uid=7`).Scan(&silver); err != nil {
		t.Fatal(err)
	}
	if silver-silverBefore != 12000 {
		t.Fatalf("重放不得重复入账: %d", silver-silverBefore)
	}
}

// 已入册的卡不能直接出售（先取回），与客户端入口一致。
func TestTradingCardSellRejectsAlbumCard(t *testing.T) {
	s, db := newProgressSrv(t)
	seedTradingCards(t, db)
	if _, err := db.SQL.Exec(`UPDATE item_def SET attrs_json=json_set(attrs_json,'$.obcephkkfhi',12000)
		WHERE item_id='card_perch'`); err != nil {
		t.Fatal(err)
	}
	c := t.Context()
	card, err := s.CreateItem(c, 7, "card_perch", "backpack", 1)
	if err != nil {
		t.Fatal(err)
	}
	addCtx := tradingAlbumRequest(t, s, 2, 602, proto.Str(proto.S("tcdeck_test")), proto.Guid(zeroGUID), proto.Guid(card.GUID))
	runTradingAlbumRequest(t, s, addCtx, false)
	sellCtx := tradingAlbumRequest(t, s, 1, 603, proto.GuidArr([]string{card.GUID}), proto.U64(12000))
	runTradingAlbumRequest(t, s, sellCtx, true)
	if row, err := db.GetItemByGUID(c, card.GUID); err != nil || row.Container != "card_deck" {
		t.Fatalf("入册卡不得被出售: %v %s", err, row.Container)
	}
}
