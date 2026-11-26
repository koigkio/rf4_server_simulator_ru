package gameserver

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestFishQueryReplyCompactReference(t *testing.T) {
	result := &FishQueryResponse{AsOf: "2026-11-08T05:38:00Z", Plans: []FishQueryPlan{
		{MapName: "旧奥斯特罗格湖", BaitName: "亮片", RigType: 5, RigName: "路亚", Chance: .1, TheoreticalPerHour: 80,
			References: []FishQueryReference{{Coordinate: "45:12", Catches: 100}}},
		{MapName: "旧奥斯特罗格湖", BaitName: "蚯蚓", RigType: 1, RigName: "浮钓", Chance: .183, TheoreticalPerHour: 65.88,
			EquivalentBaits: 3, References: []FishQueryReference{{Coordinate: "45:12", Catches: 100}}},
		{MapName: "旧奥斯特罗格湖", BaitName: "蛆", RigType: 12, RigName: "底钓", Chance: .125, TheoreticalPerHour: 45,
			References: []FishQueryReference{{Coordinate: "45:12", Catches: 100}}},
	}}
	want := "Озеро Старый Острог · 河鲈\n" +
		"[Спиннинг]\n1. Блесна · Спиннинг · теор. 80.00 рыб/час\n" +
		"[Поплавок]\n1. Червь (равноценных наживок: 3) · Поплавок · теор. 65.88 рыб/час\n" +
		"[Донка]\n1. 蛆 · Донка · теор. 45.00 рыб/час\n" +
		"Ориентир из гайдов: 45:12 (не участвует в расчёте вероятности)\n" +
		"Теоретическая скорость не учитывает время вываживания и вытаскивания."
	if got := formatFishQueryReply("河鲈", result); got != want {
		t.Fatalf("reply = %q; want %q", got, want)
	}
}

func TestFishQueryReplyKeepsCalculatedLocationsSeparate(t *testing.T) {
	x, z := 425.0, 495.0
	result := &FishQueryResponse{Plans: []FishQueryPlan{
		{MapName: "测试湖", BaitName: "饵一", RigType: 5, RigName: "路亚", Action: "jig", Chance: .1, X: &x, Z: &z,
			CoordinateKind: "manual", References: []FishQueryReference{{Coordinate: "99:99"}}},
	}}
	reply := formatFishQueryReply("河鲈", result)
	if !strings.Contains(reply, "Спиннинг · ступенька") || !strings.Contains(reply, "Точка в мире X 425.0 / Z 495.0") ||
		strings.Contains(reply, "эхолот") || strings.Contains(reply, "(точка") || strings.Contains(reply, "99:99") {
		t.Fatalf("manual position mixed with a chart zone or reference: %s", reply)
	}
	result.Plans[0].MapName, result.Plans[0].Zone, result.Plans[0].CoordinateKind = "挪威海", 7, "sea_grid"
	if reply := formatFishQueryReply("鳕鱼", result); !strings.Contains(reply, "(зона эхолота 7)") || strings.Contains(reply, "(точка") {
		t.Fatalf("missing chart zone: %s", reply)
	}
	x, z = 3282, -925
	result.Plans[0].Map, result.Plans[0].Zone = "level_012_north_sea", 252
	if reply := formatFishQueryReply("剑鱼", result); !strings.Contains(reply, "(точка 80 м)") {
		t.Errorf("未展示玩家在海图上看到的钓点：%s", reply)
	}
}

func TestFishQueryReplyLimitedAndNoInventedCoordinate(t *testing.T) {
	result := &FishQueryResponse{}
	if got := formatFishQueryReply("河鲈", result); got != "河鲈\nНа текущей карте при текущих условиях подходящих вариантов нет, можно указать другую карту." {
		t.Fatalf("empty reply = %s", got)
	}
	for range 4 {
		result.Plans = append(result.Plans, FishQueryPlan{MapName: "测试湖", BaitName: "饵", RigType: 1, RigName: "浮钓", Chance: .001, TheoreticalPerHour: .36, Action: "drift"})
	}
	got := formatFishQueryReply("河鲈", result)
	if strings.Contains(got, "4.") || !strings.Contains(got, "3. 饵 · Поплавок · сплав по течению · теор. 0.36 рыб/час") ||
		!strings.Contains(got, "Показаны только способы ловли, для которых при текущих условиях есть варианты.") ||
		strings.Contains(got, "Ориентир") || strings.Contains(got, "Точка") || strings.Contains(got, "глубин") {
		t.Fatalf("too many plans, unnecessary fields or invented position: %s", got)
	}
}

func TestFishQueryHelpWaitNotice(t *testing.T) {
	if !strings.Contains(fishQueryHelp, "около 3 секунд") || !strings.Contains(fishQueryHelp, "личным сообщением") {
		t.Fatalf("help does not explain query wait: %s", fishQueryHelp)
	}
}

func TestFishQueryReplyExplanationsMovedToHelp(t *testing.T) {
	result := &FishQueryResponse{WaterFiltered: true, Plans: []FishQueryPlan{{MapName: "铜湖", BaitName: "饵", RigType: 5, CoordinateKind: "inland_region", Region: &FishQueryRegion{MinX: 40, MinZ: 48, MaxX: 48, MaxZ: 56}}}}
	got := formatFishQueryReply("绯写锦鲤", result)
	for _, detail := range []string{"грубый отбор", "не гарантир", "четыре угла", "смешанные клетки", "прогноз", "одна снасть"} {
		if strings.Contains(got, detail) || !strings.Contains(fishQueryHelp, detail) {
			t.Fatalf("detail %q should be help-only: reply=%s help=%s", detail, got, fishQueryHelp)
		}
	}
	if !strings.HasSuffix(got, "Теоретическая скорость не учитывает время вываживания и вытаскивания.") {
		t.Fatalf("missing short rate explanation: %s", got)
	}
}

func TestFishQuerySpeciesOnlyHelp(t *testing.T) {
	if !strings.HasPrefix(fishQueryHelp, "Отправьте: название рыбы [карта]\n") {
		t.Fatalf("help does not describe species-only syntax: %s", fishQueryHelp)
	}
	for _, removed := range []string{"обычная", "зачётн", "звёзд", "трофе", "синяя", "категори"} {
		if strings.Contains(fishQueryHelp, removed) {
			t.Fatalf("help still advertises grade %q: %s", removed, fishQueryHelp)
		}
	}
}

func TestFishQuerySpeciesOnlyCommands(t *testing.T) {
	s, db := seedBaitWeightTest(t)
	const uid int64 = 1000001
	const mapKey = "level_015_tunguska"
	if _, err := db.SQL.Exec(`UPDATE loc_alias SET alias=? WHERE alias='level_900_rules'`, mapKey); err != nil {
		t.Fatal(err)
	}
	if _, err := db.EnsureProfile(t.Context(), uid); err != nil {
		t.Fatal(err)
	}
	s.setLevel(uid, mapKey)
	sess := &Session{Srv: s, Userid: uid}
	for _, text := range []string{"常见拟鲤", "常见拟鲤 rules-test", "查鱼 常见拟鲤", "查询 常见拟鲤 " + mapKey,
		"плотва обыкновенная", "рыба плотва", "Плотва обыкновенная rules-test", "поиск плотва " + mapKey} {
		t.Run(text, func(t *testing.T) {
			got := s.fishQueryReply(t.Context(), sess, text)
			if !strings.HasPrefix(got, "rules-test · Плотва обыкновенная\n[") || !strings.Contains(got, "\n1. ") || strings.Contains(got, "及以上") {
				t.Fatalf("species-only query returned %q", got)
			}
		})
	}
	for _, grade := range []string{"普通", "达标", "星", "奖杯", "蓝", "蓝冠"} {
		t.Run("removed/"+grade, func(t *testing.T) {
			if got := s.fishQueryReply(t.Context(), sess, "常见拟鲤 "+grade); got != "Карта не распознана, используйте полное название карты или номер level" {
				t.Fatalf("grade suffix is still interpreted as a filter: %q", got)
			}
			if got := s.fishQueryReply(t.Context(), sess, "常见拟鲤 "+mapKey+" "+grade); strings.HasPrefix(got, "rules-test · ") {
				t.Fatalf("extra grade argument is still accepted: %q", got)
			}
		})
	}
}

func TestFishQueryReplyExpiredDeadline(t *testing.T) {
	s, _ := seedBaitWeightTest(t)
	ctx, cancel := context.WithDeadline(t.Context(), time.Now().Add(-time.Second))
	defer cancel()
	// A timeout during name resolution must not be reported as unavailable data.
	got := s.fishQueryReply(ctx, &Session{Srv: s, Userid: 1000001}, "常见拟鲤")
	if want := "Время запроса истекло (лимит расчёта 3 секунды), попробуйте позже."; got != want {
		t.Fatalf("timeout reply=%q, want %q", got, want)
	}
}
