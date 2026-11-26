package gameserver

import (
	"context"
	"fmt"
	"math"
)

// catchXPBonus 随结算回执保存；重登和重放不按新装备重算奖励。
type catchXPBonus struct {
	Kind       uint32
	GUID       string
	Multiplier float64
	XP         int64
}

func (s *Server) rodXPBonuses(ctx context.Context, uid int64, rodGUID string, baseXP int64) ([]catchXPBonus, error) {
	if rodGUID == "" || rodGUID == zeroGUID || baseXP <= 0 {
		return nil, nil
	}
	row, err := s.DB.GetItemByGUID(ctx, rodGUID)
	if err != nil {
		return nil, err
	}
	if row == nil || row.UID != uid || row.Durability <= 0 {
		return nil, fmt.Errorf("Неверное удилище для расчёта опыта")
	}
	def, err := s.itemDefForRow(ctx, row)
	if err != nil {
		return nil, err
	}
	if def == nil || def.Category != gearCatRod {
		return nil, fmt.Errorf("Предмет для расчёта опыта не является удилищем")
	}
	entries, _ := defAttrs(def)["dmcgapifbdm"].([]any)
	var bonuses []catchXPBonus
	for _, raw := range entries {
		b, ok := raw.(map[string]any)
		if !ok || b["fopbhlmkcpe"] != float64(9) {
			continue
		}
		kind, ok := b["liampcgfchp"].(float64)
		if !ok || kind < 1 || kind > 3 || kind != math.Trunc(kind) {
			continue
		}
		rate, ok := decodeU32F32(b["kdhkgjcjpel"])
		if !ok || rate <= 0 || math.IsNaN(rate) || math.IsInf(rate, 0) {
			return nil, fmt.Errorf("Неверный бонус опыта удилища")
		}
		amount := math.Round(float64(baseXP) * rate)
		if amount >= float64(math.MaxInt64) {
			return nil, fmt.Errorf("Бонус опыта удилища вне допустимого диапазона")
		}
		if amount > 0 {
			bonuses = append(bonuses, catchXPBonus{Kind: uint32(kind), GUID: row.GUID, Multiplier: rate, XP: int64(amount)})
		}
	}
	return bonuses, nil
}
