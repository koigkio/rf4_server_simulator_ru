package gameserver

import (
	"context"
	"fmt"
	"math"
	"sort"
	"time"
)

type FishQueryRequest struct {
	UID     int64    `json:"uid"`
	Fish    string   `json:"fish"`
	Map     string   `json:"map"`
	Bait    string   `json:"bait"`
	Gear    string   `json:"gear"`
	Grade   int64    `json:"grade"`
	RigType int64    `json:"rig_type"`
	DepthCM int64    `json:"depth_cm"`
	X       *float64 `json:"x"`
	Z       *float64 `json:"z"`
}

type FishQueryReference struct {
	Coordinate string `json:"coordinate"`
	Catches    int64  `json:"catches"`
}

type FishQueryPlan struct {
	Map                  string               `json:"map"`
	MapName              string               `json:"map_name"`
	Scene                string               `json:"scene"`
	Bait                 string               `json:"bait"`
	BaitName             string               `json:"bait_name"`
	EquivalentBaits      int                  `json:"equivalent_baits"`
	RigType              int64                `json:"rig_type"`
	RigName              string               `json:"rig_name"`
	DepthCM              int64                `json:"depth_cm"`
	LureLayer            float64              `json:"lure_layer"`
	Action               string               `json:"action"`
	OnBoat               bool                 `json:"on_boat"`
	At                   string               `json:"at"`
	GameHour             int64                `json:"game_hour"`
	GameMinute           int64                `json:"game_minute"`
	WaitSeconds          int64                `json:"wait_seconds"`
	X                    *float64             `json:"x"`
	Z                    *float64             `json:"z"`
	Zone                 int                  `json:"zone"`
	CoordinateKind       string               `json:"coordinate_kind"`
	Region               *FishQueryRegion     `json:"region,omitempty"`
	References           []FishQueryReference `json:"references"`
	Chance               float64              `json:"chance"`
	MeanDelaySeconds     float64              `json:"mean_delay_seconds"`
	TheoreticalPerMinute float64              `json:"theoretical_per_minute"`
	TheoreticalPerHour   float64              `json:"theoretical_per_hour"`
	FishShare            float64              `json:"fish_share"`
	Selection            float64              `json:"selection"`
	Acceptance           float64              `json:"acceptance"`
	GradeShare           float64              `json:"grade_share"`
	BaitTier             int64                `json:"bait_tier"`
	WeightMode           float64              `json:"weight_mode"`
	CapKg                float64              `json:"cap_kg"`
	Weather              map[string]any       `json:"weather"`
}

type FishQueryResponse struct {
	Fish             string             `json:"fish"`
	Grade            int64              `json:"grade"`
	AsOf             string             `json:"as_of"`
	Flags            map[string]float64 `json:"flags"`
	Plans            []FishQueryPlan    `json:"plans"`
	Evaluated        int                `json:"evaluated"`
	Regions          int                `json:"regions"`
	CandidateRegions int                `json:"candidate_regions"`
	WaterFiltered    bool               `json:"water_filtered"`
	BaitItems        int                `json:"bait_items"`
	BaitGroups       int                `json:"bait_groups"`
	Maps             int                `json:"maps"`
	Complete         bool               `json:"complete"`
	Elapsed          float64            `json:"elapsed_seconds"`
	Notes            []string           `json:"notes"`
}

type fishQueryMap struct {
	id, name, scene string
	points          []fishQueryPoint
	references      []FishQueryReference
	regions         *fishQueryRegions
}
type fishQueryPoint struct {
	x, z *float64
	zone int
	kind string
}
type fishQueryBait struct {
	id, name    string
	category    int64
	equivalents int
}

// QueryFish reads candidate weights without rolling fish or modifying player data.
func (s *Server) QueryFish(ctx context.Context, req FishQueryRequest) (*FishQueryResponse, error) {
	started := time.Now()
	if s.DB == nil || req.UID <= 0 || req.Fish == "" {
		return nil, fmt.Errorf("Выберите игрока и целевой вид рыбы")
	}
	if req.Map == "" {
		return nil, fmt.Errorf("Укажите карту; быстрый запрос считается только для текущего времени суток")
	}
	if req.RigType != 0 && rigTypeNames[req.RigType] == "" {
		return nil, fmt.Errorf("Неподдерживаемая оснастка")
	}
	if req.Grade == 0 {
		req.Grade = 1
	}
	if req.Grade < 1 || req.Grade > 4 || req.DepthCM < 0 || req.DepthCM > 30000 {
		return nil, fmt.Errorf("Неверный уровень или глубина ловли")
	}
	if (req.X == nil) != (req.Z == nil) || req.X != nil && (req.Map == "" || !finiteSonarNumber(*req.X) || !finiteSonarNumber(*req.Z) || math.Abs(*req.X) > 1e7 || math.Abs(*req.Z) > 1e7) {
		return nil, fmt.Errorf("Для ручных координат нужно указать карту, X и Z")
	}
	var exists int
	if err := s.DB.SQL.QueryRowContext(ctx, `SELECT COUNT(*) FROM profile WHERE uid=?`, req.UID).Scan(&exists); err != nil {
		return nil, err
	}
	if exists != 1 {
		return nil, fmt.Errorf("Игрок не существует")
	}
	cache := newFishingRollCache()
	base := fishRollContext{cache: cache, now: started}
	response := &FishQueryResponse{Fish: req.Fish, Grade: req.Grade, AsOf: started.UTC().Format(time.RFC3339), Flags: map[string]float64{}, Plans: []FishQueryPlan{}, Complete: true}
	for key, def := range map[string]float64{"fish_bait_rules_enabled": 0, "fish_distribution_enabled": 0, "fish_weather_enabled": 0, "fish_ecology_enabled": 0, "bait_pref_scale": 1, "bait_pref_weight_shift": 1, "fish_weight_scale": 1, "fish_weight_cap": 0, "hook_entry_cap": 0, "bite_probability": 1} {
		response.Flags[key] = s.tunableF(key, def)
	}
	maps, err := s.fishQueryMaps(ctx, req, base)
	if err != nil {
		return nil, err
	}
	response.Maps = len(maps)
	if len(maps) == 0 {
		response.Elapsed = time.Since(started).Seconds()
		response.Notes = []string{"В серверном списке видов текущей карты нет этой рыбы; можно указать другую карту."}
		return response, nil
	}
	capKg := 0.0
	var allowedRigs []int64
	if req.Gear != "" {
		gear, err := s.DB.GetItemByGUID(ctx, req.Gear)
		if err != nil || gear == nil || gear.UID != req.UID {
			return nil, fmt.Errorf("Удилище не принадлежит выбранному игроку")
		}
		def, err := s.DB.GetItemDef(ctx, gear.NumericID)
		if err != nil || def == nil || def.Category != gearCatRod {
			return nil, fmt.Errorf("Выберите подходящее удилище")
		}
		allowedRigs = rodRigAllowed[rodDefRodType(def)]
		if req.RigType != 0 && len(allowedRigs) > 0 && !allowedContains(allowedRigs, req.RigType) {
			return nil, fmt.Errorf("Выбранное удилище не поддерживает эту оснастку")
		}
		capKg, _, _ = s.gearWeightCapForRig(ctx, req.UID, req.Gear)
	} else if response.Flags["fish_weight_cap"] > 0 || response.Flags["hook_entry_cap"] > 0 {
		return nil, fmt.Errorf("Ограничение нагрузки снастей включено, сначала выберите удилище")
	}
	baits, count, err := s.fishQueryBaits(ctx, req, base, response.Flags)
	if err != nil {
		return nil, err
	}
	response.BaitItems, response.BaitGroups = count, len(baits)
	bonuses := map[int64]fishingSkillBonus{}
	weatherSession := &Session{Srv: s}
	for _, loc := range maps {
		weatherSession.rememberWeather(loc.id, started.Unix())
		if loc.regions != nil {
			response.Regions += loc.regions.scanned
			response.CandidateRegions += len(loc.regions.areas)
			response.WaterFiltered = response.WaterFiltered || loc.regions.waterFiltered
		}
	}
	happy, err := s.DB.GetHappyHourStatus(ctx, req.UID, started)
	if err != nil {
		return nil, err
	}
	type weatherKey struct {
		loc string
		at  int64
	}
	weatherCache := map[weatherKey]fishingWeather{}
	names, _ := s.cachedFishNames(ctx, base)
	rule, _ := lookupFishBaitRule(names[req.Fish])
	evaluate := func(loc fishQueryMap, bait fishQueryBait, point fishQueryPoint, at time.Time, rig int64, depth int64, layer float64, action string, mask uint32) (FishQueryPlan, error) {
		c := base
		c.loc, c.baits, c.now, c.rigType, c.depthCM, c.lureLayer, c.lureAction, c.lureMask = loc.scene, []string{bait.id}, at, rig, depth, layer, action, mask
		c.onBoat, c.boatKnown = sonarChartLevel(loc.id), true
		if point.x != nil {
			c.x, c.z, c.hasPos = *point.x, *point.z, true
		}
		if _, ok := bonuses[rig]; !ok {
			bonuses[rig] = s.fishingBonus(ctx, req.UID, rig, req.Gear)
		}
		bonus := bonuses[rig]
		c.skill = bonus
		if at.Equal(started) {
			c.happyBite = happy.BiteBonus
		}
		c.forRig = response.Flags["fish_bait_rules_enabled"] == 1 || response.Flags["fish_weather_enabled"] == 1 || c.happyBite > 0
		wk := weatherKey{loc.id, at.Unix()}
		w, ok := weatherCache[wk]
		if !ok {
			w = weatherSession.weatherAt(loc.id, at)
			weatherCache[wk] = w
		}
		c.weather = w
		c.query = &fishQueryCapture{fish: req.Fish, grade: req.Grade, regional: loc.regions != nil}
		s.rollFishWithRules(loc.scene, bait.id, capKg, bonus, c)
		response.Evaluated++
		var region *FishQueryRegion
		if loc.regions != nil {
			var err error
			region, err = loc.regions.best(ctx, c.query)
			if err != nil {
				return FishQueryPlan{}, err
			}
			response.Evaluated += max(0, len(loc.regions.areas)-1)
		}
		_, hour := worldDayAndHour(at.Unix())
		minute := ((at.Unix() - worldDayEpochUnix) % realSecPerGameHour) * 60 / realSecPerGameHour
		plan := FishQueryPlan{Map: loc.id, MapName: loc.name, Scene: loc.scene, Bait: bait.id, BaitName: bait.name, EquivalentBaits: bait.equivalents, RigType: rig, RigName: rigNameForType(rig), DepthCM: depth, LureLayer: layer, Action: action, OnBoat: c.onBoat, At: at.UTC().Format(time.RFC3339), GameHour: hour, GameMinute: minute, WaitSeconds: int64(at.Sub(started).Seconds()), X: point.x, Z: point.z, Zone: point.zone, CoordinateKind: point.kind, Region: region, References: loc.references, Chance: c.query.chance, FishShare: c.query.fishShare, Selection: c.query.selection, Acceptance: c.query.acceptance, GradeShare: c.query.gradeShare, BaitTier: s.cachedBaitTiers(ctx, base, bait.id)[req.Fish], WeightMode: s.baitWeightModeForRoll(req.Fish, []string{bait.id}, base), CapKg: capKg, Weather: map[string]any{"known": w.known, "kind": w.kind, "air_temp": roundTo(w.airTemp, 1), "wind": roundTo(w.wind, 2)}}
		// Candidate bait, not the selected rod's currently equipped bait.
		state := &FishState{Loc: loc.scene, Bait: bait.id, RigType: rig, DepthCM: depth, LureLayer: layer, LureAction: action, Bonus: bonus}
		// 饵效控速：候选饵的对口分决定单轮判定概率（乘进 Chance）与
		// 底层杆（非路亚族）的平均间隔；路亚窗口在 pace 模式下不动。
		pace := s.fishQueryPaceState(ctx, base, state)
		if pace.Known {
			plan.Chance = clampFloat(plan.Chance*pace.probForRig(rig), 0, 1)
		}
		delay := s.fishQueryMeanDelay(state, w, at, pace)
		if pace.Known && !rigTypeLureFamily[rig] {
			if cfg := s.effectiveBiteDelaySettings(state); cfg.fixed <= 0 {
				delay = s.meanPaceStandardDelay(cfg, s.weatherBiteDelayFactor(state, w, at),
					bonus.BiteSpeed, pace.Factor, pace.Tier, pace.Ground, marineRigType(rig))
			}
		}
		plan.setTheoreticalRate(delay)
		return plan, nil
	}
	var candidates []FishQueryPlan
	for _, loc := range maps {
		for _, bait := range baits {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			rigs := []int64{1, 12}
			if sonarChartLevel(loc.id) {
				rigs = []int64{55}
				if b, ok := s.cachedBaitDefinition(ctx, base, bait.id); ok && b.matches("鱼肉类") {
					rigs = append(rigs, 52)
				}
			}
			if bait.category == 17 {
				rigs = []int64{5}
				if sonarChartLevel(loc.id) {
					rigs = []int64{50, 51}
				}
			}
			if req.RigType > 0 {
				rigs = []int64{req.RigType}
			}
			for _, rig := range rigs {
				if len(allowedRigs) > 0 && !allowedContains(allowedRigs, rig) {
					continue
				}
				if !fishQueryBaitFitsRig(bait.category, rig) {
					continue
				}
				depth := req.DepthCM
				if depth == 0 {
					depth = 150
				}
				layer, action, mask := fishQueryMotion(rig, rule)
				var best FishQueryPlan
				// Every shortlisted bait sees every candidate point, including
				// points where the first chart zone has zero target probability.
				for _, point := range loc.points {
					plan, err := evaluate(loc, bait, point, started, rig, depth, layer, action, mask)
					if err != nil {
						return nil, err
					}
					if fishQueryPlanBetter(plan, best) {
						best = plan
					}
				}
				if best.TheoreticalPerHour > 0 {
					candidates = append(candidates, best)
				}
			}
		}
	}
	response.Plans = selectFishQueryPlans(candidates)
	response.Elapsed = time.Since(started).Seconds()
	response.Notes = []string{"теор. рыб/час = 3600 × Вероятность целевой рыбы за раз ÷ Средний интервал выбора рыбы; одна снасть, одна наживка без прикормки, пересчитано по текущим условиям — это не вероятность офиц. сервера и не прогноз на час. Не учитывает ожидание клиента, занятость снасти, вываживание, вытаскивание, перезаброс и защиту при погружении; это не реальный улов.", "Только указанная карта и текущее время суток; сравниваются до 24 вариантов натуральных насадок и приманок и основные способы ловли — это не лучший вариант по всем наживкам и погоде.", "Для морской карты сравниваются до 6 обоснованных точек, предполагается ловля с лодки; на внутренних водоёмах по умолчанию — с берега."}
	if maps[0].regions != nil {
		response.Notes = append(response.Notes, "Зоны указаны в игровых координатах, левая граница включена, правая нет; это зона падения наживки, а не место персонажа или точка заброса. Местная глубина, дно, течение и рельеф не учитываются, реальная вероятность может отличаться.")
		if response.WaterFiltered {
			response.Notes = append(response.Notes, "Выполнен грубый отбор вода/суша по центру и четырём углам; если вода есть хотя бы в одной точке, зона остаётся — смешанные клетки могут содержать сушу, достижимость не гарантирована.")
		} else if maps[0].regions.enabled {
			response.Notes = append(response.Notes, "Нет данных вода/суша для этой карты, суша не исключена, достижимость не гарантирована.")
		}
		if !maps[0].regions.enabled {
			response.Notes = append(response.Notes, "Распределение стай выключено, зоны не рекомендуются; сравниваются только наживки и способы ловли.")
		} else {
			response.Notes = append(response.Notes, fmt.Sprintf("Сначала без учёта наживки отбирается до %d зон, затем сравниваются наживки и способы ловли; сортировка по теор. рыб/час, лучшая комбинация на всей карте не гарантируется.", fishQueryCoarseRegionLimit))
		}
	}
	return response, nil
}

const (
	fishQueryPlansPerFamily = 3
	fishQueryPlansLimit     = 12
)

type fishQueryFamily int

const (
	fishQueryFamilyOther fishQueryFamily = iota
	fishQueryFamilyLure
	fishQueryFamilyFloat
	fishQueryFamilyBottom
)

// fishQueryFamilyRenderOrder 是回复里的固定分组顺序。海图 52（海钓鱼肉）
// 属于收索族，归入路亚组，行内仍显示具体钓法。
var fishQueryFamilyRenderOrder = []fishQueryFamily{
	fishQueryFamilyLure,
	fishQueryFamilyFloat,
	fishQueryFamilyBottom,
	fishQueryFamilyOther,
}

func fishQueryFamilyForRig(rig int64) fishQueryFamily {
	switch {
	case rigTypeLureFamily[rig]:
		return fishQueryFamilyLure
	case floatRigTypes[rig]:
		return fishQueryFamilyFloat
	case bottomRigTypes[rig]:
		return fishQueryFamilyBottom
	default:
		return fishQueryFamilyOther
	}
}

func (f fishQueryFamily) label() string {
	switch f {
	case fishQueryFamilyLure:
		return "Спиннинг"
	case fishQueryFamilyFloat:
		return "Поплавок"
	case fishQueryFamilyBottom:
		return "Донка"
	default:
		return "Прочее"
	}
}

// selectFishQueryPlans 先按理论条/小时排序，再在每个钓法族内保留最多
// fishQueryPlansPerFamily 条。全局截断会把低产钓法整组挤掉，所以必须先
// 分组再截断；总条数仍受 fishQueryPlansLimit 约束。
func selectFishQueryPlans(candidates []FishQueryPlan) []FishQueryPlan {
	sort.SliceStable(candidates, func(i, j int) bool {
		return fishQueryPlanBetter(candidates[i], candidates[j])
	})
	selected := make([]FishQueryPlan, 0, fishQueryPlansLimit)
	seen := map[string]bool{}
	perFamily := map[fishQueryFamily]int{}
	for _, plan := range candidates {
		key := fmt.Sprintf("%s/%s/%d", plan.Map, plan.Bait, plan.RigType)
		if seen[key] {
			continue
		}
		family := fishQueryFamilyForRig(plan.RigType)
		if perFamily[family] >= fishQueryPlansPerFamily {
			continue
		}
		seen[key] = true
		perFamily[family]++
		selected = append(selected, plan)
		if len(selected) >= fishQueryPlansLimit {
			break
		}
	}
	return selected
}

func fishQueryBaitFitsRig(category, rig int64) bool {
	if rig == 52 || rig == 54 {
		return category == 27
	}
	if rigTypeLureFamily[rig] {
		return category == 17
	}
	return category == 27
}

func fishQueryMotion(rig int64, rule fishBaitRule) (float64, string, uint32) {
	if !rigTypeLureFamily[rig] {
		return 0, "", 0
	}
	if rule.needDrift {
		return .5, "drift", lureMotionDriftBit
	}
	return .5, "jig", lureMotionJigBit
}
