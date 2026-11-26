package gameserver

// 27/1 卡片出售（客户端收藏册服务 bbpmdcodcee.igchdonlnmf；命令号 capstone
// 实锤：send 调用点 mov r9b,0x1b + sub=1）。只卖收藏册容器（native:18）里
// 未入册的散卡——已入册卡（container=card_deck）必须先 27/3 取回，与客户
// 端入口一致。请求参数 [GuidArr 卡实例, U64 客户端报价]；报价只作对账
// 日志，成交价以服务端 def 属性 obcephkkfhi 为准（防作弊口径）。
// 响应 obj-800：f2=已售 guid 列表，作为客户端唯一的库存删除事件。
// 幂等：同 call 重放返回缓存 ACK，不重复删除入账。

import (
	"database/sql"
	"encoding/json"
	"fmt"

	"rf4server/internal/proto"
)

func hTradingCardSell(ctx *Ctx) ([]byte, bool) {
	if !ctx.Sess.Srv.requireDB(ctx) {
		return nil, false
	}
	if !ctx.DecodeOK || ctx.Tree == nil || ctx.Tree.Kind != proto.KindArgs || ctx.Tree.ArgCount() < 1 ||
		ctx.Tree.ArgItem(0) == nil || ctx.Tree.ArgItem(0).Kind != proto.KindGuidArr {
		ctx.ReplyFailure("System.ArgumentException", "Неверные параметры продажи карточек")
		return nil, true
	}
	clientQuote := uint64(0)
	if ctx.Tree.ArgCount() >= 2 && ctx.Tree.ArgItem(1) != nil && ctx.Tree.ArgItem(1).Kind == proto.KindU64 {
		clientQuote = ctx.Tree.ArgItem(1).U64Val()
	}
	s := ctx.Sess.Srv
	c, uid := ctx.Sess.pushCtx(), ctx.Sess.Userid
	key, sha := requestReceiptKey(ctx)
	receiptKey := fmt.Sprintf("card-sell:%d:%s:%d:%d:%d", uid, key.TokenHash, key.Main, key.Sub, key.CallID)
	tx, err := beginEconomyTx(c, s.DB)
	if err != nil {
		ctx.Log.Warn("Продажа карточек: не удалось начать транзакцию", "err", err)
		ctx.ReplyFailure("System.IO.IOException", "Продажа карточек не удалась, попробуйте ещё раз")
		return nil, true
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(c, `UPDATE kv SET v=v WHERE k=?`, receiptKey); err != nil {
		ctx.Log.Warn("Продажа карточек: не удалось записать блокировку", "err", err)
		ctx.ReplyFailure("System.IO.IOException", "Продажа карточек не удалась, попробуйте ещё раз")
		return nil, true
	}
	var raw string
	if err := tx.QueryRowContext(c, `SELECT v FROM kv WHERE k=?`, receiptKey).Scan(&raw); err == nil {
		var receipt cardAlbumReceipt
		if err := json.Unmarshal([]byte(raw), &receipt); err != nil || receipt.RequestSHA != sha {
			ctx.Log.Warn("Продажа карточек: квитанция не совпадает", "err", err)
			ctx.ReplyFailure("System.InvalidOperationException", "Содержимое повторного запроса не совпадает")
			return nil, true
		}
		return receipt.Body, true
	} else if err != sql.ErrNoRows {
		ctx.Log.Warn("Продажа карточек: не удалось прочитать квитанцию", "err", err)
		ctx.ReplyFailure("System.IO.IOException", "Продажа карточек не удалась, попробуйте ещё раз")
		return nil, true
	}
	sold := make([]string, 0, len(ctx.Tree.ArgItem(0).Items))
	total := int64(0)
	for _, item := range ctx.Tree.ArgItem(0).Items {
		card, err := getOwnedItemTx(c, tx, uid, item.Hex)
		if err != nil || card.WireClass != cardClass || card.Qty != 1 ||
			card.Container != tradingCardContainer || card.RigGUID != "" {
			ctx.Log.Warn("Продажа карточек: пропущена неверная карточка", "guid", item.Hex, "err", err)
			continue
		}
		def, err := itemDefByItemIDTx(c, tx, card.ItemID)
		if err != nil || def.Category != 78 {
			ctx.Log.Warn("Продажа карточек: пропущена карточка без определения", "guid", item.Hex, "item", card.ItemID)
			continue
		}
		price, _ := defAttrU64(def, "obcephkkfhi")
		if price <= 0 {
			ctx.Log.Warn("Продажа карточек: пропущена карточка без цены", "guid", item.Hex, "item", card.ItemID)
			continue
		}
		if _, err := tx.ExecContext(c, `DELETE FROM item WHERE guid=? AND uid=?`, item.Hex, uid); err != nil {
			ctx.Log.Warn("Продажа карточек: не удалось удалить карточку", "guid", item.Hex, "err", err)
			ctx.ReplyFailure("System.IO.IOException", "Продажа карточек не удалась, попробуйте ещё раз")
			return nil, true
		}
		sold = append(sold, item.Hex)
		total += int64(price)
	}
	if len(sold) == 0 {
		ctx.ReplyFailure("System.InvalidOperationException", "Нет карточек для продажи")
		return nil, true
	}
	if clientQuote != 0 && clientQuote != uint64(total) {
		ctx.Log.Info("Цена продажи карточек не совпадает с итоговой (решает сервер)",
			"uid", uid, "client", clientQuote, "server", total)
	}
	if err := applyWalletTx(c, tx, uid, total, 0, "sell_card", "", "",
		fmt.Sprintf("Продано карточек из коллекции: %d", len(sold))); err != nil {
		ctx.Log.Warn("Продажа карточек: ошибка зачисления", "err", err)
		ctx.ReplyFailure("System.IO.IOException", "Продажа карточек не удалась, попробуйте ещё раз")
		return nil, true
	}
	body, err := proto.EncodeValue(build800(
		proto.Args(proto.S("61")),
		proto.Args(proto.S("61")),
		proto.GuidArr(sold)), s.Table())
	if err != nil {
		ctx.Log.Warn("Продажа карточек: ошибка кодирования", "err", err)
		ctx.ReplyFailure("System.IO.IOException", "Продажа карточек не удалась, попробуйте ещё раз")
		return nil, true
	}
	receipt, err := json.Marshal(cardAlbumReceipt{RequestSHA: sha, Body: body})
	if err != nil {
		ctx.ReplyFailure("System.IO.IOException", "Продажа карточек не удалась, попробуйте ещё раз")
		return nil, true
	}
	if _, err := tx.ExecContext(c, `INSERT INTO kv(k,v) VALUES(?,?)`, receiptKey, string(receipt)); err != nil {
		ctx.Log.Warn("Продажа карточек: не удалось записать квитанцию", "err", err)
		ctx.ReplyFailure("System.IO.IOException", "Продажа карточек не удалась, попробуйте ещё раз")
		return nil, true
	}
	if err := tx.Commit(); err != nil {
		ctx.Log.Warn("Продажа карточек: ошибка фиксации", "err", err)
		ctx.ReplyFailure("System.IO.IOException", "Продажа карточек не удалась, попробуйте ещё раз")
		return nil, true
	}
	// 800.f2 已经会让客户端删除成交卡；不再追加 4/21 或全量卡片
	// 重同步，避免同一张卡的重复库存事件重建列表/选中项。余额在响应后更新。
	ctx.AfterResponse(func() {
		ctx.Sess.Push2_1()
	})
	ctx.Log.Info("Продажа карточек завершена", "uid", uid, "cards", len(sold), "silver", total)
	return body, true
}
