package gameserver

import (
	"math"
	"testing"
	"time"

	"rf4server/internal/config"
	"rf4server/internal/logging"
)

func initRandomWeather(t *testing.T, seed uint64, cycle int) map[string]*mapWeatherProfile {
	t.Helper()
	resetWeatherSchedule()
	t.Cleanup(resetWeatherSchedule)
	if _, err := initWeatherSchedule(WeatherScheduleOptions{
		Randomize: true,
		CycleDays: cycle,
	}, seed); err != nil {
		t.Fatalf("InitWeatherSchedule: %v", err)
	}
	return mapWeatherProfiles()
}

func weatherKinds(profiles map[string]*mapWeatherProfile) map[string][]int64 {
	out := make(map[string][]int64, len(profiles))
	for loc, p := range profiles {
		seq := make([]int64, len(p.slots))
		for i := range p.slots {
			seq[i] = p.slots[i].kind
		}
		out[loc] = seq
	}
	return out
}

func equalWeatherKinds(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestWeatherScheduleRandomSeedReproducible(t *testing.T) {
	first := weatherKinds(initRandomWeather(t, 4242, 32))
	second := weatherKinds(initRandomWeather(t, 4242, 32))
	for loc, kinds := range first {
		if !equalWeatherKinds(kinds, second[loc]) {
			t.Fatalf("map %s: same seed produced different sequences", loc)
		}
	}

	other := weatherKinds(initRandomWeather(t, 4243, 32))
	identical := true
	for loc, kinds := range first {
		if !equalWeatherKinds(kinds, other[loc]) {
			identical = false
			break
		}
	}
	if identical {
		t.Fatal("different seeds produced identical sequences")
	}
}

func TestWeatherScheduleRandomKindsWeightedAndTemplateMatched(t *testing.T) {
	profiles := initRandomWeather(t, 99, 64)
	counts := [weatherKindCount]int{}
	total := 0
	for _, p := range profiles {
		for _, slot := range p.slots {
			if slot.kind < 0 || slot.kind >= weatherKindCount {
				t.Fatalf("kind %d out of range", slot.kind)
			}
			if slot.template < 0 || slot.template >= len(p.days) {
				t.Fatalf("template index %d out of range", slot.template)
			}
			counts[slot.kind]++
			total++
		}
	}
	if total < 1000 {
		t.Fatalf("sample size %d too small", total)
	}
	wantWeights := [weatherKindCount]float64{3, 2, 1, 1, 1, 1}
	for kind, n := range counts {
		got := float64(n) / float64(total)
		want := wantWeights[kind] / 9
		if math.Abs(got-want) > 0.05 {
			t.Fatalf("kind %d share = %.3f, want %.3f", kind, got, want)
		}
	}
	for loc, p := range profiles {
		hasKind := [weatherKindCount]bool{}
		for i := range p.days {
			kind, _ := irFieldInt(&p.days[i], 1)
			if kind >= 0 && kind < weatherKindCount {
				hasKind[kind] = true
			}
		}
		for _, slot := range p.slots {
			if !hasKind[slot.kind] {
				continue
			}
			kind, _ := irFieldInt(&p.days[slot.template], 1)
			if kind != slot.kind {
				t.Fatalf("map %s: kind %d borrowed template kind %d", loc, slot.kind, kind)
			}
		}
	}
}

func TestWeatherScheduleRandomForecastWindowStable(t *testing.T) {
	initRandomWeather(t, 20261125, minWeatherCycleDays)
	maps, err := loadMapDefs()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(worldDayEpochUnix+100*24*realSecPerGameHour+12*realSecPerGameHour, 0)
	for loc := range maps {
		root := scheduledMapWeather(t, loc, now.Unix())
		plan := fishingWeatherPlanFromIR(&root)
		if len(plan.forecasts) != 8 || len(plan.hours) != 193 {
			t.Fatalf("map %s: window = %d forecasts, %d hours", loc, len(plan.forecasts), len(plan.hours))
		}
		irWalkObj(&root, func(n *irNode) {
			if n.Class != forecastClass {
				return
			}
			day, _ := irFieldInt(n, 0)
			kind, _ := irFieldInt(n, 1)
			occurred := false
			for hour := int64(0); hour < 24; hour++ {
				if w, ok := plan.at(float64(day*24 + hour)); ok && w.kind() == int(kind) {
					occurred = true
					break
				}
			}
			if !occurred {
				t.Fatalf("map %s day %d forecast %d never occurred", loc, day, kind)
			}
		})

		later := scheduledMapWeather(t, loc, now.Add(6*time.Hour).Unix())
		laterPlan := fishingWeatherPlanFromIR(&later)
		for _, w := range plan.hours {
			if other, ok := laterPlan.at(float64(w.at)); ok && other != w {
				t.Fatalf("map %s: published weather changed at hour %d", loc, w.at)
			}
		}
	}
}

func TestWeatherScheduleDisabledKeepsTemplateOrder(t *testing.T) {
	resetWeatherSchedule()
	t.Cleanup(resetWeatherSchedule)
	p := mapWeatherProfiles()["level_012_north_sea"]
	if p == nil {
		t.Fatal("missing north sea weather profile")
	}
	if len(p.slots) != len(p.days) {
		t.Fatalf("slots = %d, days = %d", len(p.slots), len(p.days))
	}
	for i := range p.days {
		kind, _ := irFieldInt(&p.days[i], 1)
		if p.slots[i].kind != kind || p.slots[i].template != i {
			t.Fatalf("slot %d = %+v, template kind %d", i, p.slots[i], kind)
		}
	}
	day := int64(97000)
	idx := (day + p.offset) % int64(len(p.days))
	wantKind, _ := irFieldInt(&p.days[idx], 1)
	got := p.day(day)
	gotKind, _ := irFieldInt(&got, 1)
	if gotKind != wantKind {
		t.Fatalf("day %d kind = %d, want %d", day, gotKind, wantKind)
	}
}

func TestWeatherScheduleCycleBounds(t *testing.T) {
	if got := normalizeWeatherCycleDays(0); got != defaultWeatherCycleDays {
		t.Fatalf("default cycle = %d", got)
	}
	if got := normalizeWeatherCycleDays(3); got != minWeatherCycleDays {
		t.Fatalf("short cycle = %d", got)
	}
}

func TestNewServerRandomizesWeatherWhenEnabled(t *testing.T) {
	resetWeatherSchedule()
	t.Cleanup(resetWeatherSchedule)
	srv := NewServer(config.Game{
		Weather: config.Weather{Randomize: true, CycleDays: minWeatherCycleDays},
	}, logging.Discard(), nil)
	if srv == nil {
		t.Fatal("NewServer returned nil")
	}
	p := mapWeatherProfiles()["level_012_north_sea"]
	if p == nil {
		t.Fatal("missing north sea weather profile")
	}
	if len(p.slots) != minWeatherCycleDays {
		t.Fatalf("cycle = %d", len(p.slots))
	}
}

func TestWeatherScheduleRandomTemperatureSmooth(t *testing.T) {
	profiles := initRandomWeather(t, 777, 64)
	for loc, p := range profiles {
		if len(p.slots) < 2 {
			t.Fatalf("map %s: slots = %d", loc, len(p.slots))
		}
		low, high, ok := weatherTemplateHighRange(p.days)
		if !ok {
			t.Fatalf("map %s: no template temperature", loc)
		}
		changed := false
		maxSwingSeen := 0.0
		for i := range p.slots {
			j := (i + 1) % len(p.slots)
			swing := math.Abs(p.slots[j].high - p.slots[i].high)
			if swing > maxDailyTempSwing+1e-9 {
				t.Fatalf("map %s day %d->%d swing %.3f", loc, i, j, swing)
			}
			if swing > maxSwingSeen {
				maxSwingSeen = swing
			}
			if swing > 1e-6 {
				changed = true
			}
			if p.slots[i].high < low-maxDailyTempSwing || p.slots[i].high > high+maxDailyTempSwing {
				t.Fatalf("map %s day %d temp %.2f outside [%.2f,%.2f]", loc, i, p.slots[i].high, low-maxDailyTempSwing, high+maxDailyTempSwing)
			}
		}
		if !changed {
			t.Fatalf("map %s temperature is constant", loc)
		}
		if maxSwingSeen < maxDailyTempSwing*0.6 {
			t.Fatalf("map %s max daily swing %.2f too small", loc, maxSwingSeen)
		}
	}
}

func TestWeatherScheduleRandomTemperatureReachesDay(t *testing.T) {
	profiles := initRandomWeather(t, 778, minWeatherCycleDays)
	p := profiles["level_012_north_sea"]
	if p == nil {
		t.Fatal("missing north sea weather profile")
	}
	day := int64(97000)
	slot := p.slots[(day+p.offset)%int64(len(p.slots))]
	node := p.day(day)
	got, ok := fishingWeatherFloat(&node, 2)
	if !ok || math.Abs(got-slot.high) > 1e-4 {
		t.Fatalf("day %d temperature = %.3f, want %.3f", day, got, slot.high)
	}
}
