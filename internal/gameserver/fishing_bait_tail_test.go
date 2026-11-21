package gameserver

import (
	"fmt"
	"testing"
	"time"
)

// 长尾闸：官方纪录里这款饵对这条鱼占比过低（或样本不足）时，不能靠
// companion 证据或本图历史记录兜底进判鱼池；规则明确点名的饵不受影响。
func TestBaitShareTailGate(t *testing.T) {
	s, db := seedBaitRuleTest(t)
	for _, q := range []string{
		`INSERT INTO item_def(numeric_id,item_id,category,attrs_json) VALUES
			(999821,'rule_potato',27,'{"fopbhlmkcpe":9}')`,
		`INSERT INTO item_catalog(item_id,name_zh) VALUES('rule_potato','马铃薯块')`,
		// companion 证据给足，验证证据兜底不能再绕过长尾闸
		`INSERT INTO companion_bait_fish(bait_id,fish_key,tier,evidence) VALUES
			('rule_potato','c.roach',3,900),('rule_potato','frog',3,900)`,
	} {
		if _, err := db.SQL.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	seq := 0
	ins := func(fish, bait string) {
		t.Helper()
		seq++
		if _, err := db.SQL.Exec(`INSERT INTO rf4records_catch(fish_name_en,fish_key,bait_name,bait_id,weight_g,waterbody,region,categories,trophy_class,catch_date,fetched_at) VALUES('x','` + fish + `','n','` + bait + `',` + fmt.Sprintf("%d", seq) + `,'','','','','',1)`); err != nil {
			t.Fatal(err)
		}
	}
	// 常见拟鲤 601 条纪录：rule_other 599、rule_worm 1（规则点名）、rule_potato 1（0.17%）
	for i := 0; i < 599; i++ {
		ins("c.roach", "rule_other")
	}
	ins("c.roach", "rule_worm")
	ins("c.roach", "rule_potato")
	// 青蛙只有 40 条纪录（< 100），长尾闸不生效
	for i := 0; i < 40; i++ {
		ins("frog", "rule_other")
	}
	s.tunMu.Lock()
	delete(s.tunCache, "bait_share_strong")
	s.tunCache["bait_share_min_count"] = 1
	s.tunAt = time.Now()
	s.tunMu.Unlock()
	s.loadRf4Share()

	cache := newFishingRollCache()
	now := time.Unix(worldDayEpochUnix+1500, 0)
	weight := func(fish, bait string) float64 {
		t.Helper()
		keys, w := s.filterFishBaitSet("rules-test", []string{bait}, []string{fish}, []float64{1}, now, fishRollContext{cache: cache})
		if len(keys) == 0 {
			return 0
		}
		return w[0]
	}

	// 1) 占比 99.7% 的饵正常满分
	if w := weight("c.roach", "rule_other"); w < 1 {
		t.Fatalf("高占比饵应满分: %f", w)
	}
	// 2) 规则点名但官方只有 1 条：规则优先，仍然可以咬
	if w := weight("c.roach", "rule_worm"); w <= 0 {
		t.Fatalf("规则点名的饵不应被长尾闸排除: %f", w)
	}
	// 3) 未被规则点名、官方 0.17%、companion tier3：必须出池
	if w := weight("c.roach", "rule_potato"); w != 0 {
		t.Fatalf("低占比且未被规则点名的饵必须出池: %f", w)
	}
	// 4) 纪录不足 100 条的鱼不受长尾闸影响
	if w := weight("frog", "rule_potato"); w <= 0 {
		t.Fatalf("证据不足的鱼不应被长尾闸清空: %f", w)
	}
}
