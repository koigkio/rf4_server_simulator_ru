package gameserver

import (
	"math"
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
