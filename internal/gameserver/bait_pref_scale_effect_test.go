package gameserver

import (
	"math"
	"math/rand"
	"testing"
)

// bait_pref_scale 是「饵效层效果有多强」的强度系数。它必须作用在每个候选倍率
// 与 1 的差距上；若像旧实现那样给全部候选同乘一个常数，weightedChoice 归一化
// 会把这个常数约掉，参数等于没配（玩家看到「饵料影响力 2 倍」但出鱼分布不变）。
func TestBaitPrefScaleChangesSpeciesShare(t *testing.T) {
	keys := []string{"tier3Fish", "tier1Fish", "unlisted"}
	base := []float64{100, 100, 100}
	tiers := map[string]int64{"tier3Fish": 3, "tier1Fish": 1}
	coverage := map[string]int64{"unlisted": 200} // 覆盖度满 → 0.9-0.6 = 0.3

	shares := func(scale float64) []float64 {
		wts := make([]float64, len(base))
		for i, key := range keys {
			wts[i] = base[i]
			if tier := tiers[key]; tier > 0 {
				wts[i] *= baitPrefScale(companionTierMult(tier), scale)
				continue
			}
			cov := math.Min(float64(coverage[key])/200.0, 1.0)
			wts[i] *= baitPrefScale(0.9-0.6*cov, scale)
		}
		var total float64
		for _, w := range wts {
			total += w
		}
		out := make([]float64, len(wts))
		for i, w := range wts {
			out[i] = w / total
		}
		return out
	}

	neutral, weak, strong := shares(1), shares(0.5), shares(2)

	// 1 倍保持原倍率语义：tier3 占比就是 8 份对 2 份对 0.3 份。
	if math.Abs(neutral[0]-(8.0/(8+2+0.3))) > 1e-9 {
		t.Fatalf("scale=1 应保持原倍率，实得 %v", neutral)
	}
	// 强度放大：对口鱼占比上升，不对口鱼下降。
	if !(strong[0] > neutral[0] && strong[2] < neutral[2]) {
		t.Fatalf("scale=2 应放大饵效差距: neutral=%v strong=%v", neutral, strong)
	}
	// 强度减弱：差距被拉平。
	if !(weak[0] < neutral[0] && weak[2] > neutral[2]) {
		t.Fatalf("scale=0.5 应拉平饵效差距: neutral=%v weak=%v", neutral, weak)
	}
}

func TestBaitPrefScaleChangesActualRollDistribution(t *testing.T) {
	t.Setenv("GODEBUG", "randseednop=0")
	s, db := seedBaitWeightTest(t)
	// 让青蛙作为“未上榜”候选参与派鱼；拟鲤对 rule_worm 是 tier3。
	if _, err := db.SQL.Exec(`UPDATE fish_weight_override
		SET weight=1, enabled=1
		WHERE loc='rules-test' AND fish_key='frog'`); err != nil {
		t.Fatal(err)
	}

	cache := newFishingRollCache()
	const draws = 1200
	rollShare := func(scale string) float64 {
		t.Helper()
		if err := db.TunableSet(t.Context(), "bait_pref_scale", scale, "test"); err != nil {
			t.Fatal(err)
		}
		s.execAdminCmd(&AdminCommand{Op: "reload_tunables"})
		rand.Seed(20261125)

		hits := 0
		for range draws {
			fish := s.rollFishWithRules("level_900_rules", "rule_worm", 0, neutralFishingSkillBonus(),
				fishRollContext{cache: cache})
			if fish == nil {
				t.Fatalf("scale=%s 实际派鱼返回空", scale)
			}
			if fish.Species == "c.roach" {
				hits++
			}
		}
		return float64(hits) / draws
	}

	weak := rollShare("0.5")
	neutral := rollShare("1")
	strong := rollShare("2")
	disabled := rollShare("0")
	t.Logf("拟鲤实际占比: 0.5=%.3f 1=%.3f 2=%.3f 0=%.3f", weak, neutral, strong, disabled)

	if !(weak < neutral && neutral < strong) {
		t.Fatalf("实际派鱼占比未随 bait_pref_scale 单调变化: 0.5=%g 1=%g 2=%g", weak, neutral, strong)
	}
	if neutral < 0.85 {
		t.Fatalf("scale=1 应保留 tier3 的强偏好，拟鲤占比=%g", neutral)
	}
	if math.Abs(disabled-0.5) > 0.05 {
		t.Fatalf("scale=0 应关闭饵效层、恢复等权派鱼，拟鲤占比=%g", disabled)
	}
}
