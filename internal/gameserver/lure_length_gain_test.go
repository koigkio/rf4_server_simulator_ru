package gameserver

import (
	"context"
	"math"
	"math/rand"
	"testing"
	"time"

	"rf4server/internal/store"
)

const lureLengthFishKey = "lure_len_db_fish"

func seedLureLengthFixture(t *testing.T) (*Server, *store.DB) {
	t.Helper()
	srv, db := newDetachTestServer(t)
	enableGradeRatio(t, srv, db)
	for _, query := range []string{
		`INSERT OR REPLACE INTO loc_alias(alias,loc) VALUES('level_900_rules','lure-len-rules'),('level_012_north_sea','lure-len-rules')`,
		`INSERT INTO loc_wiki_fish(loc,fish_key,fish_zh) VALUES('lure-len-rules','` + lureLengthFishKey + `','长饵测试鱼')`,
		`INSERT INTO loc_fish(loc,fish_key,name_zh,catches) VALUES('lure-len-rules','` + lureLengthFishKey + `','长饵测试鱼',100)`,
		`INSERT OR REPLACE INTO species_weight(fish_key,min_g,max_g,trophy_g,trophy_line_g,super_trophy_line_g) VALUES('` + lureLengthFishKey + `',120,10000,1000,5000,8000)`,
		`INSERT OR REPLACE INTO fish_grade_lines(fish_key,qualified_g,trophy_g,blue_trophy_g) VALUES('` + lureLengthFishKey + `',1000,5000,8000)`,
		`INSERT INTO item_def(numeric_id,item_id,category,attrs_json) VALUES
			(999941,'ll_lure_3',17,'{"mbemakijdeh":6,"hkgndoipdlc":1077936128}'),
			(999942,'ll_lure_16',17,'{"mbemakijdeh":6,"hkgndoipdlc":1098907648}'),
			(999943,'ll_lure_38',17,'{"mbemakijdeh":6,"hkgndoipdlc":1108869120}')`,
		`INSERT INTO item_catalog(item_id,name_zh) VALUES('ll_lure_3','三厘米拟饵'),('ll_lure_16','十六厘米拟饵'),('ll_lure_38','三十八厘米拟饵')`,
	} {
		if _, err := db.SQL.Exec(query); err != nil {
			t.Fatalf("准备拟饵长度夹具失败: %v", err)
		}
	}
	return srv, db
}

func TestLureLengthFloorFactor(t *testing.T) {
	if got := lureLengthFloorFactor(2.9); got != 0 {
		t.Fatalf("3cm 以下应为 0, 实得 %v", got)
	}
	if got := lureLengthFloorFactor(3); got != 0 {
		t.Fatalf("3cm 应为 0, 实得 %v", got)
	}
	if got := lureLengthFloorFactor(38); got != 1 {
		t.Fatalf("38cm 应为 1, 实得 %v", got)
	}
	if got := lureLengthFloorFactor(50); got != 1 {
		t.Fatalf("38cm 以上应钳到 1, 实得 %v", got)
	}
	if got := lureLengthFloorFactor(16); math.Abs(got-0.95) > 1e-3 {
		t.Fatalf("16cm 应约 0.95, 实得 %v", got)
	}
	// 两段线性：3-16cm 斜率 0.95/13，16-38cm 斜率 0.05/22。
	if got := lureLengthFloorFactor(9.5); math.Abs(got-0.475) > 1e-9 {
		t.Fatalf("9.5cm 应线性插值到 0.475, 实得 %v", got)
	}
	if got := lureLengthFloorFactor(27); math.Abs(got-0.975) > 1e-9 {
		t.Fatalf("27cm 应线性插值到 0.975, 实得 %v", got)
	}
	prev := 0.0
	for l := 3.0; l <= 38; l += 0.5 {
		got := lureLengthFloorFactor(l)
		if got < prev-1e-9 {
			t.Fatalf("长度因子应单调递增: %.1fcm=%v < 前一档 %v", l, got, prev)
		}
		prev = got
	}
}

func TestLureLengthCMFiltersRigsAndBaits(t *testing.T) {
	lure := &fishRollRuntime{lureKnown: true, lure: lureAttributes{SizeCM: 16}}
	if got := lureLengthCM(fishRollContext{}); got != 0 {
		t.Fatalf("无 runtime 应为 0, 实得 %v", got)
	}
	if got := lureLengthCM(fishRollContext{runtime: &fishRollRuntime{lure: lureAttributes{SizeCM: 16}}}); got != 0 {
		t.Fatalf("未识别拟饵应为 0, 实得 %v", got)
	}
	if got := lureLengthCM(fishRollContext{runtime: lure, rigType: 1}); got != 0 {
		t.Fatalf("非路亚/海钓钓组应为 0, 实得 %v", got)
	}
	if got := lureLengthCM(fishRollContext{runtime: lure, rigType: 5}); got != 16 {
		t.Fatalf("路亚钓组应取拟饵长度 16, 实得 %v", got)
	}
	if got := lureLengthCM(fishRollContext{runtime: lure, rigType: 50}); got != 16 {
		t.Fatalf("海钓钓组应取拟饵长度 16, 实得 %v", got)
	}
	if got := lureLengthCM(fishRollContext{runtime: lure, lureBait: true}); got != 0 {
		t.Fatalf("仅有拟饵标记, 无路亚/海钓钓组时不应启用, 实得 %v", got)
	}
}

func TestGradeRatioLureLengthRaisesFloorAndCutsBelow(t *testing.T) {
	srv, db := newDetachTestServer(t)
	enableGradeRatio(t, srv, db)

	lines := cachedGradeLines{
		val: ptrI64(1000), trophy: ptrI64(5000), blue: ptrI64(8000), minG: ptrI64(120),
	}
	baseBelow := srv.tunableF("grade_pct_below", 3)
	plain, handled := srv.gradeRatioModel(lines, 1, 1, 0)
	if !handled {
		t.Fatal("档位模型不可用")
	}
	plainBelow, plainWeight, ok := bandOfGrade(plain, 1)
	if !ok || math.Abs(plainBelow.lo-120) > 1e-9 {
		t.Fatalf("无拟饵时未达标档下界应为 min_g=120, 实得 %+v", plainBelow)
	}
	if math.Abs(plainWeight-baseBelow) > 1e-9 {
		t.Fatalf("无拟饵时未达标权重应保持配置值 %v, 实得 %v", baseBelow, plainWeight)
	}

	lines.lureSizeCM = 16
	mid, handled := srv.gradeRatioModel(lines, 1, 1, 0)
	if !handled {
		t.Fatal("档位模型不可用")
	}
	midBand, midWeight, ok := bandOfGrade(mid, 1)
	if !ok {
		t.Fatal("16cm 应保留未达标档")
	}
	wantLo := 120 + (1000-120)*0.95
	if math.Abs(midBand.lo-wantLo) > 1 {
		t.Fatalf("16cm 未达标档下界应约 %.0f, 实得 %.0f", wantLo, midBand.lo)
	}
	if math.Abs(midWeight-baseBelow*0.05) > 1e-9 {
		t.Fatalf("16cm 未达标权重应为配置值的 5%%=%.4f, 实得 %v", baseBelow*0.05, midWeight)
	}
	below := 0
	for i := 0; i < 4000; i++ {
		w, ok := srv.sampleWeightByGradeRatio(lines, 1, 1, 0)
		if !ok {
			t.Fatalf("第 %d 次抽样没有结果", i)
		}
		if w < int64(math.Floor(wantLo)) {
			t.Fatalf("16cm 生成了低于抬升后下界的鱼: %d < %.0f", w, wantLo)
		}
		if gradeFromLines(lines.val, lines.trophy, lines.blue, w) == 1 {
			below++
		}
	}
	qualified := srv.tunableF("grade_pct_qualified", 87.5)
	trophy := srv.tunableF("grade_pct_trophy", 9)
	super := srv.tunableF("grade_pct_super", 0.5)
	pBelow := baseBelow * 0.05 / (baseBelow*0.05 + qualified + trophy + super)
	limit := int(4000*pBelow*4) + 5
	if below > limit {
		t.Fatalf("16cm 未达标概率应很小 (配置值 5%%), 实得 %d/4000, 上限 %d", below, limit)
	}

	lines.lureSizeCM = 38
	long, handled := srv.gradeRatioModel(lines, 1, 1, 0)
	if !handled {
		t.Fatal("档位模型不可用")
	}
	if _, _, ok := bandOfGrade(long, 1); ok {
		t.Fatalf("38cm 不应再有未达标档: %+v", long.bands)
	}
	for i := 0; i < 2000; i++ {
		w, ok := srv.sampleWeightByGradeRatio(lines, 1, 1, 0)
		if !ok {
			t.Fatalf("第 %d 次抽样没有结果", i)
		}
		if w < 1000 {
			t.Fatalf("38cm 生成了未达标鱼: %d", w)
		}
	}
}

func TestWeightModelDBLureLengthRaisesFloor(t *testing.T) {
	srv, db := newDetachTestServer(t)
	const key = "lure_len_probe"
	if _, err := db.SQL.Exec(`INSERT INTO species_weight(fish_key,min_g,max_g,trophy_g,trophy_line_g,super_trophy_line_g) VALUES(?,?,?,?,?,?)`,
		key, 120, 10000, 1000, 5000, 8000); err != nil {
		t.Fatal(err)
	}
	c := fishRollContext{
		runtime: &fishRollRuntime{lureKnown: true, lure: lureAttributes{SizeCM: 16}},
		rigType: 5,
	}
	model := srv.weightModelDB(context.Background(), key, 1, 1, 0, c)
	if model.lower < 900 {
		t.Fatalf("16cm 拟饵的最小鱼重量应被抬到接近达标线, 实得 %.0f", model.lower)
	}
}

// 主判鱼路径必须把拟饵长度传进 sampleWeightDB；只测 gradeRatioModel 无法发现接线回退。
func TestRollFishWithRulesAppliesLureLengthFloor(t *testing.T) {
	srv, db := seedLureLengthFixture(t)
	setGradeRatioTunables(t, srv, db, map[string]string{
		"grade_pct_below":     "100",
		"grade_pct_qualified": "0",
		"grade_pct_trophy":    "0",
		"grade_pct_super":     "0",
	})
	ctx := t.Context()
	val := srv.cachedSettleStatics(ctx, fishRollContext{cache: newFishingRollCache()}, lureLengthFishKey)[0]
	wantFloor := math.Floor(120 + (float64(val)-120)*0.95)
	for i := 0; i < 200; i++ {
		c := fishRollContext{
			loc: "level_900_rules", rigType: 5, baits: []string{"ll_lure_16"},
			cache: newFishingRollCache(),
		}
		f := srv.rollFishWithRules("level_900_rules", "ll_lure_16", 0, neutralFishingSkillBonus(), c)
		if f == nil || f.Species != lureLengthFishKey {
			t.Fatalf("第 %d 次判鱼结果异常: %+v", i, f)
		}
		if f.WeightG < int64(wantFloor) {
			t.Fatalf("16cm 拟饵经真实判鱼仍产出未达标小鱼 %d g, 抬升后下界应为 %.0f g", f.WeightG, wantFloor)
		}
	}
}

// 查鱼的达标占比必须经过 weightLawDB 跟随拟饵长度变化。
func TestFishQueryGradeShareTracksLureLength(t *testing.T) {
	srv, _ := seedLureLengthFixture(t)
	gradeShare := func(bait string) float64 {
		t.Helper()
		q := &fishQueryCapture{fish: lureLengthFishKey, grade: 2}
		c := fishRollContext{
			loc: "level_900_rules", rigType: 5, baits: []string{bait},
			cache: newFishingRollCache(), query: q,
		}
		if f := srv.rollFishWithRules("level_900_rules", bait, 0, neutralFishingSkillBonus(), c); f != nil {
			t.Fatalf("查鱼路径不应生成鱼: %+v", f)
		}
		return q.gradeShare
	}
	short := gradeShare("ll_lure_3")
	mid := gradeShare("ll_lure_16")
	long := gradeShare("ll_lure_38")
	if !(short < mid && mid < long && math.Abs(long-1) < 1e-9) {
		t.Fatalf("查鱼达标占比应随拟饵长度单调上升并在 38cm 达到 1: 3cm=%g 16cm=%g 38cm=%g", short, mid, long)
	}
}

// 声呐预览必须通过 rosterSonarSchools 同步压缩未达标档权重。
func TestSonarGradeWeightsTrackLureLength(t *testing.T) {
	srv, _ := seedLureLengthFixture(t)
	grids, err := loadSonarGrids()
	if err != nil {
		t.Fatal(err)
	}
	grid := grids["loc12_215"]
	belowWeight := func(bait string) float64 {
		t.Helper()
		c := fishRollContext{
			uid: 1000009, loc: "loc12_215", x: 2260, z: -460, hasPos: true, spot: 7,
			rigType: 5, baits: []string{bait}, cache: newFishingRollCache(),
			now: time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC),
			weather: fishingWeather{
				known: true, kind: fishingWeatherClear, airTemp: 18, previousAirTemp: 17, wind: 3,
			},
		}
		schools := srv.rosterSonarSchools(t.Context(), "loc12_215", grid, nil, c, rand.New(rand.NewSource(41)))
		if len(schools) == 0 {
			t.Fatal("声呐没有生成鱼群, 用例无效")
		}
		return schools[0].gradeWeights[0]
	}
	short := belowWeight("ll_lure_3")
	mid := belowWeight("ll_lure_16")
	long := belowWeight("ll_lure_38")
	if !(short > mid && mid > long && math.Abs(long) < 1e-9) {
		t.Fatalf("声呐未达标权重应随拟饵长度单调下降并在 38cm 归零: 3cm=%g 16cm=%g 38cm=%g", short, mid, long)
	}
}

func bandOfGrade(model fishGradeRatioModel, grade int64) (gradeRatioBand, float64, bool) {
	for i, b := range model.bands {
		if b.grade == grade {
			return b, model.weights[i], true
		}
	}
	return gradeRatioBand{}, 0, false
}
