package gameserver

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"rf4server/internal/proto"
)

// 会员时长物品：4/8 使用后按物品面额续期会员，并在同一事务里消耗物品。
// 物品定义 category 75，attrs.mgbjgaebnne 为天数（如 premium_3d=3、premium_7d=7）。
// 此前这类物品只回 800 快照，客户端提示成功但服务端没有任何入账逻辑。
// 非会员品类交回 hItemUse 的通用分支，保持原行为。

const (
	membershipItemCategory = int64(75)
	membershipDaysAttr     = "mgbjgaebnne"
)

func (s *Server) useMembershipItem(ctx *Ctx) ([]byte, bool) {
	if !s.requireDB(ctx) {
		return nil, false
	}
	if ctx.Tree == nil || ctx.Tree.Kind != proto.KindArgs || len(ctx.Tree.Items) != 2 {
		return nil, false
	}
	storage, hasStorage := ctx.ArgInt(0)
	arg := ctx.Tree.ArgItem(1)
	if arg == nil || arg.Kind != proto.KindGuid || !validRigGUID(arg.Hex) {
		return nil, false
	}

	var tx *sql.Tx
	fail := func(message string) ([]byte, bool) {
		if tx != nil {
			_ = tx.Rollback()
		}
		ctx.ReplyFailure("System.InvalidOperationException", message)
		return nil, true
	}
	failed := func(err error) ([]byte, bool) {
		ctx.Log.Warn("Использование предмета премиума не завершено", "err", err)
		return fail("Предмет не использован, попробуйте ещё раз")
	}

	cctx, uid := ctx.Sess.pushCtx(), ctx.Sess.Userid
	var err error
	tx, err = beginEconomyTx(cctx, s.DB)
	if err != nil {
		return failed(err)
	}
	defer func() { _ = tx.Rollback() }()

	row, err := getItemTx(cctx, tx, arg.Hex)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false
	}
	if err != nil {
		return failed(err)
	}
	def, err := itemDefByNumericIDTx(cctx, tx, row.NumericID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false
	}
	if err != nil {
		return failed(err)
	}
	if def.Category != membershipItemCategory {
		return nil, false
	}
	if ctx.Sess.Closed() {
		return fail("Сессия закрыта, переподключитесь")
	}
	if !hasStorage || storage != 0 || row.UID != uid || row.Container != "backpack" || row.RigGUID != "" {
		return fail("Можно использовать только предметы премиума из своего инвентаря")
	}
	days, ok := defAttrU64(def, membershipDaysAttr)
	if !ok || days == 0 || days > 3660 {
		return fail("Неверная длительность премиума")
	}
	now := time.Now().Unix()
	newExp, err := grantMembershipDaysTx(cctx, tx, uid, int64(days), now)
	if err != nil {
		return failed(err)
	}
	if err := addTxnTx(cctx, tx, uid, "membership_item", def.ItemID, row.GUID, 0, 0,
		fmt.Sprintf("+%d days -> %d", days, newExp)); err != nil {
		return failed(err)
	}
	if _, err := consumeItemQtyTx(cctx, tx, row, 1); err != nil {
		return failed(err)
	}

	var updated []*proto.Value
	var removed []string
	if row.Qty == 0 {
		removed = []string{row.GUID}
	} else {
		fields, err := FieldsFromJSON(row.FieldsJSON)
		if err != nil {
			return failed(err)
		}
		tree := proto.Obj(row.WireClass, uint32(row.TypeID), fields...)
		stateFlagsZeroFill(row.WireClass, tree, def)
		updated = []*proto.Value{tree}
	}
	body, err := proto.EncodeValue(buildRigSnapshot800(nil, updated, removed), ctx.Sess.Table())
	if err != nil {
		return failed(err)
	}
	if err := tx.Commit(); err != nil {
		return failed(err)
	}
	change := baitChange{Removed: removed}
	if len(updated) > 0 {
		change.Updated = []string{row.GUID}
	}
	ctx.AfterResponse(func() {
		ctx.Sess.Push2_1()
		ctx.Sess.pushBaitChange(change)
	})
	ctx.Log.Info("4/8 Использование предмета продления премиума", "item", def.ItemID, "days", days, "exp", newExp)
	return body, true
}

// grantMembershipDaysTx 在同一事务内续期会员：从当前未过期到期时间顺延；
// 永久会员(kind=2)不接受续期。
func grantMembershipDaysTx(ctx context.Context, tx *sql.Tx, uid, days, now int64) (int64, error) {
	if days <= 0 || days > 3660 {
		return 0, fmt.Errorf("Неверное число дней премиума")
	}
	var kind, exp int64
	if err := tx.QueryRowContext(ctx,
		`SELECT COALESCE(membership,0), COALESCE(membership_exp,0) FROM profile WHERE uid=?`, uid).
		Scan(&kind, &exp); err != nil {
		return 0, err
	}
	if kind == 2 {
		return 0, fmt.Errorf("У персонажа уже вечный премиум")
	}
	base := now
	if kind == 1 && exp > base {
		base = exp
	}
	const maxUnix = 253402300799
	if base > maxUnix-days*86400 {
		return 0, fmt.Errorf("Время окончания премиума вне допустимого диапазона")
	}
	newExp := base + days*86400
	if _, err := tx.ExecContext(ctx,
		`UPDATE profile SET membership=1, membership_exp=?, updated_ts=? WHERE uid=?`,
		newExp, now, uid); err != nil {
		return 0, err
	}
	return newExp, nil
}
