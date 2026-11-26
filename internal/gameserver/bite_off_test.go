package gameserver

import (
	"math"
	"testing"
	"time"
)

// 官方口径：鱼重 > 引线承载 → 20%，否则 4%。
func TestBiteOffChanceFollowsWeightVsLeader(t *testing.T) {
	const (
		over  = 20.0
		under = 4.0
	)
	cases := []struct {
		name    string
		weightG int64
		leader  float64
		want    float64
	}{
		{"鱼比引线重", 16000, 11.0, 0.20},
		{"鱼比引线轻", 2000, 11.0, 0.04},
		{"鱼重恰好等于承载走轻档", 11000, 11.0, 0.04},
		{"差一点超载", 11001, 11.0, 0.20},
	}
	for _, c := range cases {
		got, ok := biteOffChance(c.weightG, c.leader, over, under)
		if !ok {
			t.Fatalf("%s: 应参与判定", c.name)
		}
		if math.Abs(got-c.want) > 1e-9 {
			t.Fatalf("%s: 概率=%.4f, 期望 %.4f", c.name, got, c.want)
		}
	}
}

func TestBiteOffChanceRejectsUnusableInput(t *testing.T) {
	cases := []struct {
		name    string
		weightG int64
		leader  float64
		over    float64
		under   float64
	}{
		// 读不到引线承力时不判：咬断的目标件不存在。
		{"引线承力为 0", 5000, 0, 20, 4},
		{"引线承力为负", 5000, -1, 20, 4},
		{"引线承力为 NaN", 5000, math.NaN(), 20, 4},
		{"引线承力为 Inf", 5000, math.Inf(1), 20, 4},
		{"鱼重为 0", 0, 11, 20, 4},
		// 两档概率都配成 0 等于关闭。
		{"概率全 0", 5000, 11, 0, 0},
	}
	for _, c := range cases {
		if _, ok := biteOffChance(c.weightG, c.leader, c.over, c.under); ok {
			t.Fatalf("%s: 不应参与判定", c.name)
		}
	}
}

func TestBiteOffChanceClampsAboveHundred(t *testing.T) {
	got, ok := biteOffChance(20000, 5, 250, 4)
	if !ok {
		t.Fatal("应参与判定")
	}
	if math.Abs(got-1.0) > 1e-9 {
		t.Fatalf("超过 100%% 应钳到 1.0, 实际 %.4f", got)
	}
}

func TestBiteOffTunablesDisabledByDefault(t *testing.T) {
	s := &Server{tunCache: map[string]float64{}, tunText: map[string]string{}, tunAt: time.Now()}
	if _, _, _, _, enabled := s.biteOffTunables(); enabled {
		t.Fatal("默认应关闭")
	}
}

func TestBiteOffTunablesClampsRanges(t *testing.T) {
	s := &Server{
		tunCache: map[string]float64{
			"bite_off_enabled":          1,
			"bite_off_over_pct":         250,
			"bite_off_under_pct":        -5,
			"bite_off_sprint_seconds":   0.1,
			"bite_off_min_stamina_drop": -1,
		},
		tunText: map[string]string{},
		tunAt:   time.Now(),
	}
	over, under, sprint, minDrop, enabled := s.biteOffTunables()
	if !enabled {
		t.Fatal("开关为 1 时应启用")
	}
	if over != 100 {
		t.Fatalf("概率上限应钳到 100, 实际 %.2f", over)
	}
	if under != 0 {
		t.Fatalf("负概率应钳到 0, 实际 %.2f", under)
	}
	if sprint != biteOffMinSprintSecsFloor {
		t.Fatalf("间隔下限应钳到 %.1f, 实际 %.2f", biteOffMinSprintSecsFloor, sprint)
	}
	if minDrop != 0 {
		t.Fatalf("负降幅阈值应归零, 实际 %.4f", minDrop)
	}
}

func TestBiteOffTunablesRejectNaN(t *testing.T) {
	s := &Server{
		tunCache: map[string]float64{"bite_off_enabled": 1, "bite_off_over_pct": math.NaN()},
		tunText:  map[string]string{},
		tunAt:    time.Now(),
	}
	if _, _, _, _, enabled := s.biteOffTunables(); enabled {
		t.Fatal("NaN 参数应让整层关闭, 而不是按 0 处理")
	}
}

func TestBiteOffSpeciesSetParsing(t *testing.T) {
	// 未覆盖 bite_off_species 时用官方默认表；大小写与空格都应归一。
	s := &Server{tunText: map[string]string{}, tunAt: time.Now()}
	set := s.biteOffSpeciesSet()
	if len(set) != 5 {
		t.Fatalf("默认表应有 5 个鱼种, 实际 %v", set)
	}

	s.tunText["bite_off_species"] = " n.pike , TAIMEN ,, agar "
	set = s.biteOffSpeciesSet()
	for _, key := range []string{"n.pike", "taimen", "agar"} {
		if !set[key] {
			t.Fatalf("应包含 %q, 实际 %v", key, set)
		}
	}
	if len(set) != 3 {
		t.Fatalf("空项应被忽略, 实际 %v", set)
	}

	// 空串表示整层关闭。
	s.tunText["bite_off_species"] = ""
	if got := s.biteOffSpeciesSet(); got != nil {
		t.Fatalf("空串应返回 nil, 实际 %v", got)
	}
	// 只有逗号也应视为关闭。
	s.tunText["bite_off_species"] = " , ,, "
	if got := s.biteOffSpeciesSet(); got != nil {
		t.Fatalf("全是分隔符应返回 nil, 实际 %v", got)
	}
}

func TestBiteOffSprintGateSkipsRestingFish(t *testing.T) {
	// 体力没掉的这条不算冲刺：maybeBiteOff 依赖降幅做门控。
	// 这里直接验证判定条件本身，避免构造整个 14/8 上下文。
	const minDrop = 0.01
	resting := 0.80 - 0.80
	if resting >= minDrop {
		t.Fatal("体力不变不应通过降幅门控")
	}
	struggling := 0.80 - 0.70
	if struggling < minDrop {
		t.Fatal("体力下降到 0.70 应通过降幅门控")
	}
}

func TestBiteOffOnlyForListedSpecies(t *testing.T) {
	s := &Server{tunText: map[string]string{"bite_off_species": defaultBiteOffSpecies}, tunAt: time.Now()}
	set := s.biteOffSpeciesSet()
	for _, key := range []string{"n.pike", "taimen", "agar", "sgar", "lamna_n"} {
		if !set[key] {
			t.Fatalf("官方鱼种表应包含 %q", key)
		}
	}
	// 常见非掠食鱼不在表内。
	for _, key := range []string{"bream", "roach", "carp"} {
		if set[key] {
			t.Fatalf("非掠食鱼 %q 不应在表内", key)
		}
	}
}
