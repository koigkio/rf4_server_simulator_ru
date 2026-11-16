package gameserver

import (
	"math"
	"testing"
	"time"
)

// 官服 14/14 抓包 A 级锚点（2026-09-18 真值表 9 样本 + 2026-11-10/11 新抓 12+8
// 样本 + 2026-11-16/17 断电抢救包 53 样本，见 fish-pull-k-table spec v2 章节）。
// 只落数值锚点，不含任何抓包原始数据（CONTRIBUTING 禁令不受影响）。
// 恒 k 类鱼种锚点配对跨体重档（如 coalfish 702/3027g），钉死 Slope=0。
var officialPullAnchors = []struct {
	species string
	weightG int64
	pullN   float64 // 官方 f8（牛）
	tolPct  float64 // 允许偏差
}{
	{"crucian", 611, 9.0919, 2},
	{"crucian", 293, 4.28627, 2},
	{"crucian", 743, 11.1182, 2},
	{"crucian", 193, 2.7937, 2},
	{"crucian", 527, 7.814, 2},
	{"crucian", 320, 4.695, 2},
	{"crucian", 341, 5.014, 2},
	{"c.roach", 680, 11.0735, 2},
	{"c.roach", 150, 2.3899, 2},
	{"c.roach", 713, 11.6109, 2},
	{"perch", 221, 3.74761, 2},
	{"perch", 93, 1.55752, 3},
	{"perch", 1070, 18.9743, 3},
	{"perch", 119, 1.99803, 3},
	{"perch", 342, 5.86736, 3},
	{"perch", 642, 11.1688, 3},
	{"perch", 100, 1.676, 3},
	{"perch", 340, 5.832, 3},
	{"perch", 259, 4.408, 3},
	{"g_carp", 21742, 423.798, 2},
	{"g_carp", 4880, 93.4397, 2},
	{"g_carp", 5484, 105.073, 2},
	{"g_carp", 5716, 109.545, 2},
	{"g_carp", 10307, 198.496, 2},
	{"b_carp", 7828, 146.519, 2},
	{"carp", 1063, 17.5527, 2},
	{"carp", 4589, 79.202, 2},
	{"carp", 2434, 41.320, 2},
	{"carp", 5710, 98.919, 2},
	{"c.carp", 655, 8.9112, 2},
	{"c.carp", 140, 1.8186, 3},
	{"c.carp", 631, 8.576, 3},
	{"c.carp", 1574, 22.198, 3},
	{"s.bream", 359, 4.5193, 2},
	{"taran", 611, 11.3884, 2},
	{"piksha", 2975, 55.451, 2},
	{"merlang", 252, 5.19145, 2},
	{"b_gill", 113, 2.21706, 2},
	{"n.pike", 4305, 76.6636, 2},
	{"din_l_carp", 1715, 29.3737, 2},
	// —— v2 新实测种（2026-11-16/17 断电抢救包）——
	// 恒 k 类：跨体重档锚点钉死 Slope=0。
	{"coalfish", 702, 15.151, 2},
	{"coalfish", 3027, 65.329, 2},
	{"coalfish", 1456, 31.423, 2},
	{"coalfish", 1692, 36.517, 2},
	{"atl_cod", 2674, 57.710, 2},
	{"atl_cod", 5677, 122.521, 2},
	{"m_scorpius", 205, 3.620, 2},
	{"m_scorpius", 585, 10.330, 2},
	{"m_scorpius", 1142, 20.165, 2},
	{"shemaya_cha", 117, 2.181, 2},
	{"shemaya_cha", 237, 4.417, 2},
	{"shemaya_cha", 220, 4.101, 2},
	{"tiulka", 10, 0.186, 3},
	{"tiulka", 13, 0.242, 3},
	{"pumps_sunfish", 52, 1.020, 2},
	{"menek", 6117, 114.015, 2},
	{"pollachius", 2387, 53.858, 2},
	{"atl_herring", 560, 12.635, 2},
	{"makrel", 1891, 44.522, 2},
	{"cha_herring", 114, 2.908, 2},
	// 变 k 类新种：配对锚点钉 slope。
	{"rudd", 196, 3.602, 3},
	{"rudd", 402, 7.541, 3},
	{"rudd", 397, 7.446, 3},
	{"rudd", 195, 3.583, 3},
	{"n_carp", 4405, 75.099, 2},
	{"carp_ghost", 4513, 77.871, 2},
	{"kw_tench", 987, 18.432, 2},
	{"c_bleak", 24, 0.424, 3},
}

// TestFishPullMatchesOfficialAnchors 防回归：已实测鱼种的 f8 必须落在官服
// A 级样本 ±tol% 内。这是 P1 修复的核心验收。
func TestFishPullMatchesOfficialAnchors(t *testing.T) {
	srv := &Server{}
	for _, a := range officialPullAnchors {
		f := &RolledFish{Species: a.species, WeightG: a.weightG}
		got := srv.fishFightPullFor(f)
		tol := a.pullN * a.tolPct / 100
		if math.Abs(got-a.pullN) > tol {
			t.Errorf("%s %dg f8=%.4fN，官服=%.4fN（±%v%%）", a.species, a.weightG, got, a.pullN, a.tolPct)
		}
	}
}

// TestFishPullGroupFallback 验证未实测鱼种走习性组表与 fallback，量级为官方域；
// 已升实测的种（v2：coalfish 等 17 种）优先走逐鱼种表，不再落组。
func TestFishPullGroupFallback(t *testing.T) {
	srv := &Server{}
	cases := []struct {
		species string
		group   string
		wantK   float64
	}{
		{"riv_rb_trout", "salmonid", 18.0},
		{"lm_b_bass", "predator", 17.30},     // v2：组值锚 n.pike 实测
		{"din_m_carp", "carp_mid", 16.50},    // v2：组值锚 carp
		{"karasekarp", "still_carp", 15.05},  // v2：组值锚 crucian
		{"shemaya", "small_forage", 18.64},   // v2：移出 roach_run，同黑海欧白鱼实测族
		{"cetorhinus_m", "apex", 25.53},      // v2 新组：鲨/剑鱼/金枪鱼（纯推断）
		{"carp_albino", "alias→carp", 16.50}, // v2 别名：皮肤变种继承宿主 carp
		{"not_in_calib", "fallback", 17.5},
	}
	for _, c := range cases {
		if got := srv.fishPullK0For(c.species); math.Abs(got-c.wantK) > 1e-9 {
			t.Errorf("%s K0=%f，期望 %s 组 %f", c.species, got, c.group, c.wantK)
		}
		// 官方 k 实测域 [12.59, 25.53]（v2：s.bream~cha_herring；v1 的 [12.6, 20.6]
		// 被恒 k 海鱼实证推翻）。1kg 时 ln 项为 0，k 即 K0。
		pull := srv.fishFightPullFor(&RolledFish{Species: c.species, WeightG: 1000})
		k := pull // w=1kg 时 k 即 pull
		if k < 12.0 || k > 26.0 {
			t.Errorf("%s 1kg 等效 k=%f 越出官方域", c.species, k)
		}
	}
	// v2 升实测的种必须优先命中逐鱼种表（组表已移除其映射）。
	if got := srv.fishPullK0For("coalfish"); math.Abs(got-21.58) > 1e-9 {
		t.Errorf("coalfish 应走实测表 K0=21.58，实得 %f（v2 前=组 19.7）", got)
	}
	if got := srv.fishPullK0For("n_carp"); math.Abs(got-16.53) > 1e-9 {
		t.Errorf("n_carp 应走实测表 K0=16.53，实得 %f（v2 前=组 16.7）", got)
	}
}

// TestFishPullLnSlopeTunable 验证斜率与 fallback 的 tunable 应急覆盖。
func TestFishPullLnSlopeTunable(t *testing.T) {
	srv := &Server{}
	srv.tunCache = map[string]float64{"fish_pull_ln_slope": 0}
	srv.tunAt = time.Now()
	if got := srv.fishFightPullFor(&RolledFish{Species: "perch", WeightG: 1000}); math.Abs(got-17.6) > 1e-6 {
		t.Fatalf("斜率置 0 后 1kg perch 应恰为 K0=17.6，实得 %f", got)
	}
	if got := srv.fishPullK0For("not_in_calib"); got != 17.5 {
		t.Fatalf("fallback K0 应为 17.5，实得 %f", got)
	}
	// 恒 k 类（Slope=0）不受全局斜率 tunable 影响。
	srv.tunCache = map[string]float64{"fish_pull_ln_slope": 1.0}
	srv.tunAt = time.Now()
	if got := srv.fishFightPullFor(&RolledFish{Species: "coalfish", WeightG: 1000}); math.Abs(got-21.58) > 1e-6 {
		t.Fatalf("恒 k 的 coalfish 1kg 应恒为 21.58（Slope=0 不吃 tunable），实得 %f", got)
	}
	// Slope<0 的单样本种仍吃全局斜率 tunable。
	if got := srv.fishFightPullFor(&RolledFish{Species: "not_in_calib", WeightG: 1000}); math.Abs(got-17.5) > 1e-6 {
		t.Fatalf("斜率 tunable=1 时 fallback 1kg 应为 K0+1·ln(1)=17.5，实得 %f", got)
	}
}
