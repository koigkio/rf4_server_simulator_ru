package gameserver

import (
	"context"
	"testing"

	"rf4server/internal/proto"
)

// ATM 钱包购买：金币扣款、银币直接到账、背包不留钱包实例。
func TestWalletAtmDirectCredit(t *testing.T) {
	srv, db := newEconomyTxTestServer(t)
	ctx := context.Background()
	const uid = int64(1000002)
	if _, err := db.EnsureProfile(ctx, uid); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL.Exec(`UPDATE profile SET silver=0,gold=10000 WHERE uid=?`, uid); err != nil {
		t.Fatal(err)
	}
	registerShopHandlers(srv.dispatch)
	// atm_01 的 wallet_100 金币价=99 分，attrs.pkdlooielib=10000 分
	request := economyTestCtx(srv, uid, proto.Args524(proto.StrVal("atm_01"), proto.StrVal("wallet_100"), proto.U64(99)))
	request.Main, request.Sub, request.ExpectResponse = 22, 3, true
	result := srv.dispatch.executeRequest(request, true)
	if result.nativeFailure || result.failed || !result.hasResponse {
		t.Fatalf("ATM 钱包购买被拒: %+v", result)
	}
	var silver, gold int64
	db.SQL.QueryRow(`SELECT silver,gold FROM profile WHERE uid=?`, uid).Scan(&silver, &gold)
	if silver != 10000 || gold != 10000-99 {
		t.Fatalf("到账不符: silver=%d want=10000, gold=%d want=%d", silver, gold, 10000-99)
	}
	var cnt int
	db.SQL.QueryRow(`SELECT COUNT(*) FROM item WHERE uid=? AND item_id='wallet_100'`, uid).Scan(&cnt)
	if cnt != 0 {
		t.Fatalf("背包不应留 wallet_100 实例，实得 %d 行", cnt)
	}
}

// 余额不足时不得到账，也不得留物品。
func TestWalletAtmInsufficient(t *testing.T) {
	srv, db := newEconomyTxTestServer(t)
	ctx := context.Background()
	const uid = int64(1000003)
	if _, err := db.EnsureProfile(ctx, uid); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL.Exec(`UPDATE profile SET silver=0,gold=0 WHERE uid=?`, uid); err != nil {
		t.Fatal(err)
	}
	registerShopHandlers(srv.dispatch)
	request := economyTestCtx(srv, uid, proto.Args524(proto.StrVal("atm_01"), proto.StrVal("wallet_100"), proto.U64(99)))
	request.Main, request.Sub, request.ExpectResponse = 22, 3, true
	result := srv.dispatch.executeRequest(request, true)
	if !result.nativeFailure {
		t.Fatal("余额不足应被拒")
	}
	var silver int64
	db.SQL.QueryRow(`SELECT silver FROM profile WHERE uid=?`, uid).Scan(&silver)
	if silver != 0 {
		t.Fatalf("余额不足时不应到账，实得 silver=%d", silver)
	}
}
