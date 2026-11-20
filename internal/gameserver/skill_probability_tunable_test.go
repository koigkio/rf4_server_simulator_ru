package gameserver

import (
	"testing"
	"time"
)

func TestSkillProficiencyFixedPercent(t *testing.T) {
	const cat = int64(2)
	const current = 60.0

	s := &Server{
		tunCache: map[string]float64{"skill_gain_pct_2": 50},
		tunText:  map[string]string{},
		tunAt:    time.Now(),
	}
	// 固定 50%：0.49 应命中，0.51 应失败；不再受原版 60% 熟练度概率影响。
	if got := s.skillProficiencyGainForRoll(cat, current, 0.49, 0); got <= 0 {
		t.Fatalf("50%% 概率下 0.49 应命中，实际 gain=%.2f", got)
	}
	if got := s.skillProficiencyGainForRoll(cat, current, 0.51, 0); got != 0 {
		t.Fatalf("50%% 概率下 0.51 不应命中，实际 gain=%.2f", got)
	}

	// 0 = 原版概率：随机数 0 应命中。
	s.tunCache["skill_gain_pct_2"] = 0
	if got := s.skillProficiencyGainForRoll(cat, current, 0, 0); got <= 0 {
		t.Fatalf("0 应回退原版概率并命中，实际 gain=%.2f", got)
	}

	// 100 = 必定命中，即使随机数接近 1。
	s.tunCache["skill_gain_pct_2"] = 100
	if got := s.skillProficiencyGainForRoll(cat, current, 0.9999, 0); got <= 0 {
		t.Fatalf("100%% 概率应必定命中，实际 gain=%.2f", got)
	}

	// 未配置的大类回退原版公式。
	s.tunCache = map[string]float64{}
	if got := s.skillProficiencyGainForRoll(99, current, 0, 0); got <= 0 {
		t.Fatalf("未配置大类应回退原版并命中，实际 gain=%.2f", got)
	}
}
