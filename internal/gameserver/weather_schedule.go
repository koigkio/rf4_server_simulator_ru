package gameserver

import (
	crand "crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math"
	"math/rand"
	"sort"
	"sync"
)

const (
	defaultWeatherCycleDays = 64
	minWeatherCycleDays     = 8
	weatherKindCount        = 6
)

// weatherKindWeights 是随机天气 kind 的抽取权重，顺序为晴、少云、多云、
// 雨、暴雨、雷暴。总权重 9：晴天约 1/3，少云约 2/9，其余四类各约 1/9。
var weatherKindWeights = [weatherKindCount]int{3, 2, 1, 1, 1, 1}

// WeatherScheduleOptions 控制进程启动时生成的逐日天气 kind 序列。
// 序列在进程内固定；关闭随机时沿用地图模板的固定顺序。
type WeatherScheduleOptions struct {
	Randomize bool // true=按天气权重重抽 kind; false=沿用模板顺序
	CycleDays int  // 每图序列长度; <=0 用默认 64, 小于 8 时按 8 处理
}

// weatherDaySlot 是序列中的一天：kind 决定晴雨，template 指向该图模板中
// 距离该 kind 最近的模板日，用来继承风速和水位；随机模式下 high 是该日
// 独立生成并做过日间限幅的最高温。
type weatherDaySlot struct {
	kind     int64
	template int
	high     float64
}

// 地图原有预报提供气候差异；绝对游戏日决定天气，不随玩家进入时间重抽。
type mapWeatherProfile struct {
	days   []irNode
	hours  [24]irNode
	rangeC float64
	seed   uint64 // 图 key 的稳定哈希, 用于降雨过程中心
	offset int64  // 关闭随机时保留模板的日偏移
	random bool   // true=kind 与最高温由启动随机序列提供
	slots  []weatherDaySlot
}

var (
	weatherProfilesMu     sync.RWMutex
	weatherProfiles       map[string]*mapWeatherProfile
	weatherProfilesLoaded bool
	weatherScheduleOpts   WeatherScheduleOptions
)

func mapWeatherProfiles() map[string]*mapWeatherProfile {
	weatherProfilesMu.RLock()
	loaded, profiles := weatherProfilesLoaded, weatherProfiles
	weatherProfilesMu.RUnlock()
	if loaded {
		return profiles
	}
	weatherProfilesMu.Lock()
	defer weatherProfilesMu.Unlock()
	if !weatherProfilesLoaded {
		weatherProfiles = buildWeatherProfiles(weatherScheduleOpts)
		weatherProfilesLoaded = true
	}
	return weatherProfiles
}

// InitWeatherSchedule 在进程启动时生成一次天气序列；之后只读。
// 返回本次启动实际使用的 seed，便于日志排查。
func InitWeatherSchedule(opts WeatherScheduleOptions) (uint64, error) {
	return initWeatherSchedule(opts, 0)
}

// initWeatherSchedule 允许测试注入固定 seed；seed=0 时按启动随机。
func initWeatherSchedule(opts WeatherScheduleOptions, seed uint64) (uint64, error) {
	opts.CycleDays = normalizeWeatherCycleDays(opts.CycleDays)
	if opts.Randomize && seed == 0 {
		var err error
		seed, err = randomWeatherSeed()
		if err != nil {
			return 0, fmt.Errorf("Генерация погоды seed: %w", err)
		}
	}
	profiles := buildWeatherProfilesWithSeed(opts, seed)
	if len(profiles) == 0 {
		return 0, fmt.Errorf("Шаблон погоды карты недоступен")
	}
	weatherProfilesMu.Lock()
	weatherProfiles = profiles
	weatherProfilesLoaded = true
	weatherScheduleOpts = opts
	weatherProfilesMu.Unlock()
	return seed, nil
}

// resetWeatherSchedule 清除启动时生成的序列，后续读取回到模板默认顺序。
func resetWeatherSchedule() {
	weatherProfilesMu.Lock()
	weatherProfiles = nil
	weatherProfilesLoaded = false
	weatherScheduleOpts = WeatherScheduleOptions{}
	weatherProfilesMu.Unlock()
}

// clearRandomWeatherSchedule 在配置切回模板天气时清掉同进程中先前生成
// 的随机序列，避免 false 配置继续复用旧 schedule。
func clearRandomWeatherSchedule() {
	weatherProfilesMu.Lock()
	if weatherScheduleOpts.Randomize {
		weatherProfiles = nil
		weatherProfilesLoaded = false
		weatherScheduleOpts = WeatherScheduleOptions{}
	}
	weatherProfilesMu.Unlock()
}

func normalizeWeatherCycleDays(n int) int {
	if n <= 0 {
		return defaultWeatherCycleDays
	}
	if n < minWeatherCycleDays {
		return minWeatherCycleDays
	}
	return n
}

func randomWeatherSeed() (uint64, error) {
	var b [8]byte
	if _, err := crand.Read(b[:]); err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint64(b[:]), nil
}

func buildWeatherProfiles(opts WeatherScheduleOptions) map[string]*mapWeatherProfile {
	return buildWeatherProfilesWithSeed(opts, 0)
}

func buildWeatherProfilesWithSeed(opts WeatherScheduleOptions, seed uint64) map[string]*mapWeatherProfile {
	profiles := make(map[string]*mapWeatherProfile)
	maps, err := loadMapDefs()
	if err != nil {
		return profiles
	}
	cycle := normalizeWeatherCycleDays(opts.CycleDays)
	for key, raw := range maps {
		var root irNode
		if json.Unmarshal(raw, &root) != nil || materializeIR(&root) != nil {
			continue
		}
		p := &mapWeatherProfile{}
		hash := fnv.New64a()
		_, _ = hash.Write([]byte(key))
		p.seed = hash.Sum64()
		low, high := math.Inf(1), math.Inf(-1)
		irWalkObj(&root, func(n *irNode) {
			switch n.Class {
			case forecastClass:
				p.days = append(p.days, *n)
			case hourPlanClass:
				h, ok := irFieldInt(n, 1)
				temp, valid := fishingWeatherFloat(n, 2)
				if ok && valid && h >= 0 && h < 24 {
					p.hours[h] = *n
					low, high = math.Min(low, temp), math.Max(high, temp)
				}
			}
		})
		sort.Slice(p.days, func(i, j int) bool {
			a, _ := irFieldInt(&p.days[i], 0)
			b, _ := irFieldInt(&p.days[j], 0)
			return a < b
		})
		complete := len(p.days) > 0
		for _, h := range p.hours {
			complete = complete && len(h.Fields) == 10
		}
		if !complete {
			continue
		}
		p.rangeC = high - low
		if opts.Randomize {
			p.random = true
			p.slots = randomWeatherSlots(p.days, cycle, seed^p.seed)
			assignRandomTemperatures(p.days, p.slots, seed^p.seed)
		} else {
			p.offset = int64(p.seed % uint64(len(p.days)))
			p.slots = templateWeatherSlots(p.days)
		}
		profiles[key] = p
	}
	return profiles
}

func templateWeatherSlots(days []irNode) []weatherDaySlot {
	slots := make([]weatherDaySlot, len(days))
	for i := range days {
		kind, _ := irFieldInt(&days[i], 1)
		slots[i] = weatherDaySlot{kind: kind, template: i}
	}
	return slots
}

// randomWeatherSlots 为每张图独立按权重抽取天气 kind。
// 温度、风和水位取模板中距离该 kind 最近的模板日，避免晴天继承暴雨日的参数。
func randomWeatherSlots(days []irNode, cycle int, seed uint64) []weatherDaySlot {
	rng := rand.New(rand.NewSource(int64(seed)))
	slots := make([]weatherDaySlot, cycle)
	for i := range slots {
		kind := int64(randomWeatherKind(rng))
		slots[i] = weatherDaySlot{kind: kind, template: nearestWeatherTemplate(days, kind)}
	}
	return slots
}

func randomWeatherKind(rng *rand.Rand) int {
	total := 0
	for _, weight := range weatherKindWeights {
		total += weight
	}
	r := rng.Intn(total)
	for kind, weight := range weatherKindWeights {
		if r < weight {
			return kind
		}
		r -= weight
	}
	return weatherKindCount - 1
}

func nearestWeatherTemplate(days []irNode, kind int64) int {
	best, bestDist := 0, int64(math.MaxInt64)
	for i := range days {
		k, ok := irFieldInt(&days[i], 1)
		if !ok {
			continue
		}
		dist := k - kind
		if dist < 0 {
			dist = -dist
		}
		if dist < bestDist {
			best, bestDist = i, dist
		}
	}
	return best
}

// maxDailyTempSwing 限制相邻两天最高温的变化幅度（°C）。每日温度在
// 模板区间附近随机游走，靠该上限避免逐日大幅震荡；日内昼夜曲线仍由
// hour() 按模板温差生成。
const maxDailyTempSwing = 3.0

// assignRandomTemperatures 为随机序列生成逐日最高温：在模板最高温区间
// 附近做有界随机游走，并向区间均值轻微回归。每天按当前温度限制步长，
// 同时预留返回起始日所需的步数，保证包含首尾的相邻日变化不超过
// maxDailyTempSwing，也不会长期漂出模板气候。
func assignRandomTemperatures(days []irNode, slots []weatherDaySlot, seed uint64) {
	low, high, ok := weatherTemplateHighRange(days)
	if !ok || len(slots) == 0 {
		return
	}
	n := len(slots)
	mean := (low + high) / 2
	margin := maxDailyTempSwing
	minHigh, maxHigh := low-margin, high+margin
	rng := rand.New(rand.NewSource(int64(seed)))
	cur := clampFloat(mean+(rng.Float64()*2-1)*margin, minHigh, maxHigh)
	first := cur
	slots[0].high = cur
	for i := 1; i < n; i++ {
		step := (rng.Float64()*2 - 1) * maxDailyTempSwing
		next := cur + step + (mean-cur)*0.18
		next = clampFloat(next, cur-maxDailyTempSwing, cur+maxDailyTempSwing)
		// 从第 i 天还要走 n-i 步回到第 0 天；把当前值限制在能按时
		// 返回 first 的窗口内，最后一日的首尾相邻差也自然不超过 3°C。
		closeWindow := maxDailyTempSwing * float64(n-i)
		next = clampFloat(next, math.Max(minHigh, first-closeWindow), math.Min(maxHigh, first+closeWindow))
		// 闭环窗口每步收紧 3°C；若当前值正好落在旧窗口边缘，再叠加本次
		// 随机步长会产生 6°C 跳变。窗口收紧后再约束一次相邻日步长。
		next = clampFloat(next, cur-maxDailyTempSwing, cur+maxDailyTempSwing)

		slots[i].high = next
		cur = next
	}
}

func weatherTemplateHighRange(days []irNode) (low, high float64, ok bool) {
	low, high = math.Inf(1), math.Inf(-1)
	for i := range days {
		temp, valid := fishingWeatherFloat(&days[i], 2)
		if !valid {
			continue
		}
		low, high = math.Min(low, temp), math.Max(high, temp)
	}
	return low, high, !math.IsInf(low, 1) && !math.IsInf(high, -1)
}

func copyWeatherNode(n irNode) irNode {
	n.Fields = append([]irField(nil), n.Fields...)
	return n
}

func setWeatherInt(n *irNode, idx int, value int64) {
	n.Fields[idx].V, _ = json.Marshal(value)
}

func setWeatherFloat(n *irNode, idx int, value float64) {
	setWeatherInt(n, idx, int64(math.Float32bits(float32(value))))
}

func (p *mapWeatherProfile) day(day int64) irNode {
	if len(p.slots) == 0 {
		return copyWeatherNode(p.days[0])
	}
	idx := (day + p.offset) % int64(len(p.slots))
	if idx < 0 {
		idx += int64(len(p.slots))
	}
	slot := p.slots[idx]
	n := copyWeatherNode(p.days[slot.template])
	setWeatherInt(&n, 0, day)
	setWeatherInt(&n, 1, slot.kind)
	if p.random {
		setWeatherFloat(&n, 2, slot.high)
	}
	return n
}

func (p *mapWeatherProfile) hour(day, hour int64) irNode {
	daily, next := p.day(day), p.day(day+1)
	kind, _ := irFieldInt(&daily, 1)
	high, _ := fishingWeatherFloat(&daily, 2)
	nextHigh, _ := fishingWeatherFloat(&next, 2)
	wind, _ := fishingWeatherFloat(&daily, 3)
	nextWind, _ := fishingWeatherFloat(&next, 3)
	water, _ := irFieldInt(&daily, 4)
	n := copyWeatherNode(p.hours[hour])
	setWeatherInt(&n, 0, day)
	setWeatherInt(&n, 1, hour)
	// 日出前低温、午后高温；日际温差在一天内缓慢衔接。
	fraction := float64(hour) / 24
	cycle := (1 - math.Cos((float64(hour)-4)*math.Pi/12)) / 2
	temp := high + (nextHigh-high)*fraction - p.rangeC*(1-cycle)
	cloud, rain, thunder := .02, 0.0, 0.0
	switch int(kind) {
	case fishingWeatherFewClouds:
		cloud = .2
	case fishingWeatherCloudy:
		cloud = .6
	case fishingWeatherRain, fishingWeatherHeavyRain, fishingWeatherThunderstorm:
		cloud = .7
		// 每日一次连续天气过程，强度逐小时升降，预报的类型必定达到。
		center := 6 + int((uint64(day)^p.seed)%13)
		distance := math.Abs(float64(hour) - float64(center))
		if distance < 4 {
			envelope := (1 + math.Cos(distance*math.Pi/4)) / 2
			cloud += .25 * envelope
			rain = .4 * envelope
			if int(kind) >= fishingWeatherHeavyRain {
				rain = .9 * envelope
			}
			if int(kind) == fishingWeatherThunderstorm {
				thunder = .8 * envelope
			}
			temp -= 1.5 * envelope
		}
	}
	if p.random {
		// 随机模式把 16 时定为当日峰值，其他小时不高于该值，确保客户端
		// 发布的每日最高温与平滑后的 slot.high 完全一致。
		temp = math.Min(temp, high)
		if hour == 16 {
			temp = high
		}
	}
	setWeatherFloat(&n, 2, temp)
	setWeatherFloat(&n, 3, cloud)
	setWeatherFloat(&n, 4, rain)
	setWeatherFloat(&n, 5, thunder)
	// 预报与小时计划都使用 km/h；吃口入口再换算为 m/s。
	setWeatherFloat(&n, 6, math.Max(0, wind+(nextWind-wind)*fraction))
	setWeatherInt(&n, 9, water)
	return n
}

// reanchorWeather 沿用地图协议容器，填入昨天至未来六天的统一天气计划。
func reanchorWeather(root *irNode, nowUnix int64) {
	if root == nil || len(root.Fields) == 0 {
		return
	}
	var key string
	if json.Unmarshal(root.Fields[0].V, &key) != nil {
		return
	}
	p := mapWeatherProfiles()[key]
	if p == nil {
		return
	}
	day, _ := worldDayAndHour(nowUnix)
	var forecasts []*irNode
	var hours *irNode
	irWalkObj(root, func(n *irNode) {
		if n.Class == forecastClass {
			forecasts = append(forecasts, n)
		}
		if len(n.Items) > 0 && n.Items[0].Class == hourPlanClass {
			hours = n
		}
	})
	if hours == nil || len(forecasts) != len(p.days) {
		return
	}
	start, end := day-1, day+int64(len(forecasts))-1
	items := make([]irNode, 0, (end-start)*24+1)
	for d := start; d <= end; d++ {
		forecast := p.day(d)
		maxTemp, maxWind := math.Inf(-1), 0.0
		for h := int64(0); h < 24; h++ {
			n := p.hour(d, h)
			temp, _ := fishingWeatherFloat(&n, 2)
			wind, _ := fishingWeatherFloat(&n, 6)
			maxTemp, maxWind = math.Max(maxTemp, temp), math.Max(maxWind, wind)
			if d < end || h == 0 {
				items = append(items, n)
			}
		}
		if d < end {
			setWeatherFloat(&forecast, 2, maxTemp)
			setWeatherFloat(&forecast, 3, maxWind)
			*forecasts[d-start] = forecast
		}
	}
	hours.Items = items
}
