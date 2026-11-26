package gameserver

import "testing"

// Карты находятся по русскому названию: целиком, без «озеро/река» и по началу
// слова; неоднозначный запрос не угадывается.
func TestFishQueryMapRussianNames(t *testing.T) {
	s, db := seedBaitWeightTest(t)
	if _, err := db.SQL.Exec(`INSERT OR REPLACE INTO loc_alias(alias,loc,note) VALUES
		('level_015_tunguska','下通古斯卡河',''),('level_006_ladoga','拉多加湖',''),('level_011_ladoga_02','拉多加湖群岛','')`); err != nil {
		t.Fatal(err)
	}
	for query, want := range map[string]string{
		"Река Нижняя Тунгуска": "level_015_tunguska",
		"нижняя тунгуска":      "level_015_tunguska",
		"тунг":                 "level_015_tunguska",
		"Ладожское озеро":      "level_006_ladoga",
		"архипелаг":            "level_011_ladoga_02",
	} {
		if got, err := s.resolveFishQueryMap(t.Context(), query); err != nil || got != want {
			t.Errorf("map %q = %q, %v; want %q", query, got, err, want)
		}
	}
	if got, err := s.resolveFishQueryMap(t.Context(), "ладож"); err == nil {
		t.Errorf("ambiguous map resolved to %q", got)
	}
}
