package gameserver

import (
	_ "embed"
	"encoding/json"
	"sync"
)

// fish_record_weights.json 保存各鱼种的"Record（绿旗/达标）"重量（克）。
//
// 数据来源：外部鱼种阈值表（2026-11-25 版）的达标线，与 fish_grade_lines
// 的 qualified_g 同源。全量收录
// 252 个鱼种。隆头鳟 bs_salmon 无达标线（插件 targetWeight=0），达标线取
// 奖杯线前 1g（13999），奖杯线 14000、蓝冠线 20000；实际发鱼不设下限，
// 会出现更小的个体。roach 保留原配置，不写入本表。
// 未收录的鱼种由 settleStatics 回退到内置表或按奖杯线估算。
//
//go:embed assets/fish_record_weights.json
var fishRecordWeightsJSON []byte

var (
	fishRecordOnce sync.Once
	fishRecordMap  map[string]int64
)

func fishRecordWeight(species string) int64 {
	fishRecordOnce.Do(func() {
		m := map[string]int64{}
		if err := json.Unmarshal(fishRecordWeightsJSON, &m); err == nil {
			fishRecordMap = m
		}
	})
	return fishRecordMap[species]
}
