package gameserver

import (
	"encoding/json"
	"fmt"
	"math"
	"testing"
)

// 官服 f5 锚点（A 级 14/14 样本，specs/changes/fish-official-data-tables/spec.md）。
// tolPct = 该种种内散布带（官方随机因子，grade 检验证实与档位无关）。
var officialStaminaAnchors = []struct {
	species string
	weightG int64
	f5      float64
	tolPct  float64
}{
	{"merlang", 252, 2646.53, 3},
	{"piksha", 2975, 19010.5, 3},
	{"s.bream", 359, 2105.9785, 3},
	{"b_gill", 113, 459.556, 3},
	{"taran", 611, 2171.68, 3},
	{"din_l_carp", 1715, 4745.5, 3},
	{"n.pike", 4305, 11859.9, 3},
	{"carp", 1063, 2235.09, 3},
	{"b_carp", 7828, 16335.8, 3},
	{"perch", 642, 1586.1823, 19},
	{"perch", 1070, 2739.0903, 19},
	{"crucian", 611, 1604.2435, 25},
	{"c.carp", 655, 1587.5297, 6},
	{"g_carp", 10307, 30384.6, 60},
}

// TestFishStaminaMatchesOfficialAnchors 防回归：实测种 f5 必须落在官方散布带内。
func TestFishStaminaMatchesOfficialAnchors(t *testing.T) {
	srv, _ := newRigTestServer(t)
	for _, a := range officialStaminaAnchors {
		f := &RolledFish{Species: a.species, WeightG: a.weightG, Grade: 2}
		profile := srv.fishFightProfileFor(f)
		got := srv.fishStaminaForProfile(f, profile)
		tol := a.f5 * a.tolPct / 100
		if math.Abs(got-a.f5) > tol {
			t.Errorf("%s %dg f5=%.1f，官服=%.1f（±%v%%）", a.species, a.weightG, got, a.f5, a.tolPct)
		}
	}
}

// TestFishF6MatchesOfficialTable 验证 f6 量化表、体重台阶与 fallback。
func TestFishF6MatchesOfficialTable(t *testing.T) {
	srv2, _ := newRigTestServer(t)
	cases := []struct {
		species string
		weightG int64
		want    float64
	}{
		{"perch", 342, 0.70},
		{"perch", 642, 0.80},
		{"crucian", 293, 0.55},
		{"crucian", 743, 0.60},
		{"c.roach", 680, 0.50},
		{"s.bream", 359, 0.30},
		{"n.pike", 4305, 0.80},
		{"g_carp", 21742, 0.70},
		{"not_in_calib", 500, defaultFishInitialStaminaRatio},
	}
	for _, c := range cases {
		f := &RolledFish{Species: c.species, WeightG: c.weightG}
		if got := srv2.fishF6For(f); math.Abs(got-c.want) > 1e-9 {
			t.Errorf("%s %dg f6=%f，期望 %f", c.species, c.weightG, got, c.want)
		}
	}
}

// TestFightCurvesSpeciesPoolsLoaded 验证官方池按鱼种键直配（行数 = 官方抓包）。
func TestFightCurvesSpeciesPoolsLoaded(t *testing.T) {
	srv, _ := newRigTestServer(t)
	cases := []struct {
		species string
		rows    int
	}{
		{"taran", 13},
		{"b_gill", 13},
		{"n.pike", 12},
		{"merlang", 8},
		{"piksha", 9},
		{"din_l_carp", 24},
		{"g_carp", 13},
		{"carp", 16},
		{"c.roach", 18},
	}
	for _, c := range cases {
		curves := srv.buildFightCurves(c.species, 10)
		if curves == nil || len(curves.Items) != c.rows {
			t.Fatalf("%s 池行数=%d，期望直配官方 %d 行", c.species, len(curves.Items), c.rows)
		}
	}
	// 未入库种仍走 archetype 借池兜底。
	fallback := srv.buildFightCurves("not_in_calib", 10)
	if fallback == nil || len(fallback.Items) == 0 {
		t.Fatal("未入库种借池兜底失效")
	}
}

// TestFightCurvesMarineFallbackUsesOfficialMerlang 防回归：marine 组借官方
// merlang 真池（39a1085 官服 14/14 抓包直配入库）。此前借 perch 池是淡水
// 小杂鱼剧本（主搏 105 仅 4.5~8s、逃窜权重 1~2%、98% 时间碎潜水），实测
// 84.2kg meagre 全程 19s 被匀速拖回、14/8 遥测零负步（2026-11-16 搏鱼秒起
// 调查）。词表命中 marine 的未入库种（menek）必须与 merlang 拿到同一池：
// 同 pull 同池 uniform 缩放，全部 19 列应逐行一致。
func TestFightCurvesMarineFallbackUsesOfficialMerlang(t *testing.T) {
	if pool := fishFightArchetypes["marine"].CurvePool; pool != "merlang" {
		t.Fatalf("marine 组曲线池=%q，应为官方 merlang 池", pool)
	}
	srv, _ := newRigTestServer(t)
	const pull = 100.0
	menek := srv.buildFightCurves("menek", pull)
	merlang := srv.buildFightCurves("merlang", pull)
	if len(menek.Items) == 0 || len(menek.Items) != len(merlang.Items) {
		t.Fatalf("menek 借池行数=%d，merlang 池=%d", len(menek.Items), len(merlang.Items))
	}
	for i, row := range menek.Items {
		for col := 0; col < 19; col++ {
			if got, want := protoF32Field(row, col), protoF32Field(merlang.Items[i], col); got != want {
				t.Fatalf("menek 行 %d 列 %d=%f，merlang 池=%f（借池应为官方 merlang 真池）", i, col, got, want)
			}
		}
	}
}

// TestFightCurvesEveryPoolHasPhase100Base 防回归：原始资产里每个池必须恰含
// 1 条 f0=100 基准行，且 loader 把它钉到首位——buildFightCurves 用
// selected[0][8] 作 uniform 缩放锚，池缺基准行时 loader 静默保持导出器原序，
// 缩放会锚到恰好排首的错误行，±3% 容差发现不了这种错位。
func TestFightCurvesEveryPoolHasPhase100Base(t *testing.T) {
	var parsed struct {
		Pools map[string]struct {
			Rows [][19]any `json:"rows"`
		} `json:"pools"`
	}
	if err := json.Unmarshal(fightCurvesJSON, &parsed); err != nil {
		t.Fatalf("解析 fight_curves_sets.json: %v", err)
	}
	if len(parsed.Pools) == 0 {
		t.Fatal("fight_curves_sets.json 没有任何池")
	}
	srv, _ := newRigTestServer(t)
	for sp, pool := range parsed.Pools {
		base := 0
		for _, r := range pool.Rows {
			var f0 float64
			switch tv := r[0].(type) {
			case float64:
				f0 = tv
			case string:
				fmt.Sscanf(tv, "%g", &f0)
			}
			if int(f0) == 100 {
				base++
			}
		}
		if base != 1 {
			t.Errorf("%s 池 f0=100 基准行数=%d，期望恰 1 条", sp, base)
			continue
		}
		srv.curveMu.Lock()
		loaded := srv.curves[sp]
		srv.curveMu.Unlock()
		if len(loaded) == 0 {
			t.Errorf("%s 池加载后为空", sp)
			continue
		}
		if int(loaded[0][0]) != 100 {
			t.Errorf("%s 池加载后首位 f0=%v，期望 100（缩放锚必须是基准行）", sp, loaded[0][0])
		}
	}
}
