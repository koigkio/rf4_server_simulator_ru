package gameserver

import (
	"maps"
	"testing"

	"rf4server/internal/proto"
)

func TestStoreRejectsUnprojectableGoodsBeforePayment(t *testing.T) {
	for _, tc := range []struct {
		name          string
		gold          bool
		encodeFailure bool
	}{
		{"silver-projection", false, false},
		{"gold-projection", true, false},
		{"silver-encoding", false, true},
		{"gold-encoding", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, db := newEconomyTxTestServer(t)
			const uid = int64(2099)
			const model = "invalid_attractant"
			seedEconomyItemDef(t, db, 9199, model, 17)
			if !tc.encodeFailure {
				if _, err := db.SQL.Exec(`UPDATE item_def SET attrs_json=? WHERE item_id=?`, `{"gpoaffnjbdo":"invalid"}`, model); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := db.EnsureProfile(t.Context(), uid); err != nil {
				t.Fatal(err)
			}
			if _, err := db.SQL.Exec(`UPDATE profile SET silver=200000,gold=200000 WHERE uid=?`, uid); err != nil {
				t.Fatal(err)
			}
			if _, err := db.SQL.Exec(`INSERT INTO shop_item(store_id,item_id,silver,gold,stock) VALUES('shop',?,1000,1000,10)`, model); err != nil {
				t.Fatal(err)
			}
			// 确认异常出现在物品投影，而不是更早的物品创建阶段。
			items, _, err := s.prepareStoreGoods(t.Context(), uid, model)
			if err != nil || len(items) != 1 {
				t.Fatalf("prepare goods: items=%d err=%v", len(items), err)
			}
			tree, err := s.ItemToTree(t.Context(), items[0])
			if tc.encodeFailure {
				if err != nil {
					t.Fatal(err)
				}
				ops := maps.Clone(s.table.Ops)
				ops[tree.Class] = nil
				s.table = proto.NewOpsTable(maps.Clone(s.table.TypeToClass), ops)
				if _, err := proto.EncodeValue(tree, s.table); err == nil {
					t.Fatal("incompatible protocol table must fail encoding")
				}
			} else if err == nil {
				t.Fatal("invalid hook configuration must fail projection")
			}
			c := economyTestCtx(s, uid, proto.Args524(proto.StrVal("shop"), proto.StrVal(model), proto.U64(1)))
			c.ExpectResponse = true
			c.replyCapture = &ctxReplyCapture{}
			hStoreBuy(tc.gold)(c)
			if _, _, _, failure := c.replyCapture.snapshot(); !failure {
				t.Error("unprojectable goods must be rejected")
			}
			var silver, goldBalance, itemsCount, txns int64
			if err := db.SQL.QueryRow(`SELECT silver,gold FROM profile WHERE uid=?`, uid).Scan(&silver, &goldBalance); err != nil {
				t.Fatal(err)
			}
			if err := db.SQL.QueryRow(`SELECT COUNT(*) FROM item WHERE uid=?`, uid).Scan(&itemsCount); err != nil {
				t.Fatal(err)
			}
			if err := db.SQL.QueryRow(`SELECT COUNT(*) FROM txn WHERE uid=? AND kind='buy'`, uid).Scan(&txns); err != nil {
				t.Fatal(err)
			}
			if silver != 200000 || goldBalance != 200000 || itemsCount != 0 || txns != 0 {
				t.Fatalf("rejected purchase changed state: silver=%d gold=%d items=%d txns=%d", silver, goldBalance, itemsCount, txns)
			}
		})
	}
}
