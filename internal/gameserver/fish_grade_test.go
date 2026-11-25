package gameserver

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"rf4server/internal/config"
	"rf4server/internal/logging"
	"rf4server/internal/proto"
	"rf4server/internal/store"
)

func TestFishGradeRulerBoundariesAndWire(t *testing.T) {
	s, _ := newProgressSrv(t)
	ctx := context.Background()
	for _, tc := range []struct {
		species string
		lines   [3]int64
	}{
		{"perch", [3]int64{280, 1600, 2700}},
		{"c.roach", [3]int64{220, 1200, 2000}},
		{"crucian", [3]int64{300, 1900, 3200}},
		{"s.bream", [3]int64{140, 800, 1200}},
	} {
		for i, line := range tc.lines {
			for _, delta := range []int64{-1, 0, 1} {
				weight := line + delta
				want := int64(i + 2)
				if delta < 0 {
					want--
				}
				grade := s.rollGradeDB(ctx, tc.species, weight)
				if grade != want {
					t.Fatalf("%s %dg: grade=%d want=%d", tc.species, weight, grade, want)
				}
				f := &RolledFish{FishGUID: newFishGUID(), Species: tc.species, WeightG: weight, Grade: grade}
				if got := u32Of(s.buildFish27(f, "", "", 24).Field(2).Num); got != uint32(want) {
					t.Fatalf("27 grade=%d want=%d", got, want)
				}
				for _, obj := range []*proto.Value{
					s.build813(ctx, 1000001, f, 0, 0, 0),
					s.buildSettle813(ctx, 1000001, f, &settleXpResult{}),
				} {
					for j, threshold := range tc.lines {
						if got := u32Of(obj.Field(j).Num); got != uint32(threshold) {
							t.Fatalf("ruler %s line%d=%d want=%d", tc.species, j, got, threshold)
						}
					}
					fish := obj.Field(9).Val
					if u32Of(fish.Field(1).Num) != uint32(weight) || u32Of(fish.Field(3).Num) != uint32(want) {
						t.Fatalf("settlement fish differs: %+v", fish)
					}
				}
			}
		}
	}
}

func TestFishGradeAllStaticSpecies(t *testing.T) {
	db, err := store.OpenWithStatic(filepath.Join(t.TempDir(), "grade.db"), filepath.Join("..", "..", "server_data", "static.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Migrate(); err != nil {
		t.Fatal(err)
	}
	s := NewServer(config.Game{Tunnel: config.Tunnel{PSK: "grade-test"}}, logging.Discard(), nil)
	s.SetDB(db)
	ctx := context.Background()
	rows, err := db.SQL.QueryContext(ctx, `SELECT fish_key FROM species_weight`)
	if err != nil {
		t.Fatal(err)
	}
	var species []string
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			t.Fatal(err)
		}
		species = append(species, key)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	if len(species) == 0 {
		t.Fatal("static fish roster is empty")
	}
	for _, key := range species {
		lines := s.settleStatics(ctx, key)
		if lines[0] <= 0 || lines[0] >= lines[1] || lines[1] >= lines[2] {
			t.Fatalf("invalid ruler %s: %v", key, lines)
		}
		for i, line := range lines[:3] {
			next := int64(0)
			if i+1 < len(lines) {
				next = lines[i+1]
			}
			for _, delta := range []int64{-1, 0, 1} {
				// 相邻档位线只差 1g（如 bs_salmon 的 13999/14000）时，
				// line+1 已经是下一档，不能按本档边界断言。
				if delta > 0 && next > 0 && line+delta >= next {
					continue
				}
				want := int64(i + 2)
				if delta < 0 {
					want--
				}
				if got := s.rollGradeDB(ctx, key, line+delta); got != want {
					t.Fatalf("%s %dg: grade=%d want=%d ruler=%v", key, line+delta, got, want, lines)
				}
			}
		}
	}
	t.Logf("checked %d species at all three ruler boundaries", len(species))
}

func TestFishGradeSourcesStayInSync(t *testing.T) {
	db, err := store.OpenWithStatic(filepath.Join(t.TempDir(), "grade-sync.db"), filepath.Join("..", "..", "server_data", "static.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Migrate(); err != nil {
		t.Fatal(err)
	}
	s := NewServer(config.Game{Tunnel: config.Tunnel{PSK: "grade-sync"}}, logging.Discard(), nil)
	s.SetDB(db)
	ctx := context.Background()

	recordWeights := map[string]int64{}
	if err := json.Unmarshal(fishRecordWeightsJSON, &recordWeights); err != nil {
		t.Fatal(err)
	}
	if len(recordWeights) != 252 {
		t.Fatalf("fish_record_weights.json 记录数=%d，期望252", len(recordWeights))
	}

	rows, err := db.SQL.QueryContext(ctx, `
		SELECT g.fish_key, g.qualified_g, g.trophy_g, g.blue_trophy_g,
		       w.trophy_g, w.trophy_line_g, w.super_trophy_line_g
		FROM fish_grade_lines g
		JOIN species_weight w ON w.fish_key = g.fish_key
		WHERE g.source = 'external-thresholds@2026-11-25'
		ORDER BY g.fish_key`)
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for rows.Next() {
		var key string
		var qualified, trophy, blue int64
		var staticQualified, staticTrophy, staticBlue int64
		if err := rows.Scan(&key, &qualified, &trophy, &blue, &staticQualified, &staticTrophy, &staticBlue); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		record, ok := recordWeights[key]
		if !ok {
			rows.Close()
			t.Fatalf("迁移有 %s，但 fish_record_weights.json 未收录", key)
		}
		if record != qualified || qualified != staticQualified {
			rows.Close()
			t.Fatalf("%s 达标线不一致: json=%d grade_lines=%d species_weight=%d", key, record, qualified, staticQualified)
		}
		if trophy != staticTrophy || blue != staticBlue {
			rows.Close()
			t.Fatalf("%s 奖杯/蓝冠线不一致: grade_lines=%d/%d species_weight=%d/%d", key, trophy, blue, staticTrophy, staticBlue)
		}
		delete(recordWeights, key)
		checked++
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatal(err)
	}
	rows.Close()
	if checked != 252 {
		t.Fatalf("external-thresholds 迁移记录数=%d，期望252", checked)
	}
	if len(recordWeights) != 0 {
		t.Fatalf("fish_record_weights.json 有 %d 个键未被 external-thresholds 迁移覆盖", len(recordWeights))
	}

	wantSalmon := [3]int64{13999, 14000, 20000}
	q, y, b := db.GradeLines(ctx, "bs_salmon")
	if q == nil || y == nil || b == nil || *q != wantSalmon[0] || *y != wantSalmon[1] || *b != wantSalmon[2] {
		t.Fatalf("bs_salmon grade_lines=(%v,%v,%v)，期望%v", q, y, b, wantSalmon)
	}
	if got := s.settleStatics(ctx, "bs_salmon"); got != [6]int64{13999, 14000, 20000, 25000, 22000, 24000} {
		t.Fatalf("bs_salmon settleStatics=%v", got)
	}
	f := &RolledFish{FishGUID: newFishGUID(), Species: "bs_salmon", WeightG: 13999, Grade: 2}
	settle := s.buildSettle813(ctx, 1000001, f, &settleXpResult{})
	for i, line := range wantSalmon {
		if got := u32Of(settle.Field(i).Num); got != uint32(line) {
			t.Fatalf("bs_salmon 结算 f%d=%d，期望%d", i, got, line)
		}
	}
	t.Logf("checked %d species across json, grade_lines and species_weight", checked)
}

func TestAdminFishUsesRealWeightAndSurvivesRestart(t *testing.T) {
	s, db := newProgressSrv(t)
	const uid = int64(1000001)
	for _, weight := range []int64{279, 280, 1599, 1600, 2699, 2700} {
		s.execAdminCmd(&AdminCommand{Op: "arm_fish", UID: uid, Species: "perch", WeightG: weight, Grade: 4})
		armed := s.stateFor(uid).Armed
		want := s.rollGradeDB(context.Background(), "perch", weight)
		if armed == nil || armed.WeightG != weight || armed.Grade != want {
			t.Fatalf("armed fish=%+v want weight=%d grade=%d", armed, weight, want)
		}
		s.execAdminCmd(&AdminCommand{Op: "add_keepnet", UID: uid, Keepnet: &store.KeepnetEntry{
			Species: "perch", WeightG: weight, Cat: 4,
		}})
	}
	entries, err := db.KeepnetList(context.Background(), uid)
	if err != nil || len(entries) != 6 {
		t.Fatalf("keepnet count=%d err=%v", len(entries), err)
	}
	for _, e := range entries {
		want := s.rollGradeDB(context.Background(), e.Species, e.WeightG)
		if e.Cat != want || u32Of(buildKeepnet25(e, "", 0, "").Field(3).Num) != uint32(want) {
			t.Fatalf("keepnet fish=%+v want grade=%d", e, want)
		}
	}
	restarted := newFishingRecoveryServer(t, db)
	if got := restarted.stateFor(uid).Armed; got == nil || *got != *s.stateFor(uid).Armed {
		t.Fatalf("restart changed armed fish: %+v", got)
	}
}

func TestLuckyRollGradeUsesCappedWeight(t *testing.T) {
	s, db := newProgressSrv(t)
	if err := db.TunableSet(t.Context(), "grade_ratio_enabled", "0", "test"); err != nil {
		t.Fatal(err)
	}
	s.execAdminCmd(&AdminCommand{Op: "reload_tunables"})
	for i := 0; i < 100; i++ {
		f := s.rollFishPoolsWithRules("loc1_02", 0.45, fishingSkillBonus{BiteSpeed: 1, TrophyLuck: 2})
		if f == nil || f.WeightG > 450 || f.Grade != s.rollGradeDB(t.Context(), f.Species, f.WeightG) {
			t.Fatalf("luck bypassed cap or ruler: %+v", f)
		}
	}
	for _, query := range []string{
		`INSERT INTO loc_alias(alias,loc) VALUES('level_grade','grade_area')`,
		`INSERT INTO loc_fish(loc,fish_key,catches) VALUES('grade_area','perch',1)`,
	} {
		if _, err := db.SQL.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 100; i++ {
		f := s.rollFishFromDBWithRules("level_grade", "", 0.1, fishingSkillBonus{BiteSpeed: 1, TrophyLuck: 2})
		if f == nil || f.Species != "perch" || f.WeightG > 100 || f.Grade != 1 {
			t.Fatalf("static roll luck bypassed cap or ruler: %+v", f)
		}
	}
}
