package store

import "testing"

// 官方鱼汛现在由六个开关组成：旧库只有前五个 "1" 时应显示 mixed，
// 直到管理员重新选择一次 realistic，避免升级后静默开启海钓水层。
func TestBiteModeForIncludesMarineLayer(t *testing.T) {
	allOn := map[string]string{}
	for _, key := range biteModeKeys {
		allOn[key] = "1"
	}
	if got := BiteModeFor(allOn); got != "realistic" {
		t.Fatalf("六开应为 realistic，得到 %q", got)
	}

	allOn["marine_layer_enabled"] = "0"
	if got := BiteModeFor(allOn); got != "mixed" {
		t.Fatalf("海钓水层关闭后应为 mixed，得到 %q", got)
	}

	allOff := map[string]string{}
	for _, key := range biteModeKeys {
		allOff[key] = "0"
	}
	if got := BiteModeFor(allOff); got != "legacy" {
		t.Fatalf("六关应为 legacy，得到 %q", got)
	}

	// 旧库五开：新 key 缺失，既不是全开也不是全关。
	oldFiveOn := map[string]string{}
	for _, key := range biteModeKeys {
		if key == "marine_layer_enabled" {
			continue
		}
		oldFiveOn[key] = "1"
	}
	if got := BiteModeFor(oldFiveOn); got != "mixed" {
		t.Fatalf("旧库五开应升级为 mixed，得到 %q", got)
	}

	// 旧库五关：marine_layer_enabled 这一行还不存在（读出来是空串），
	// 不能因为新键缺失就把原本的 legacy 错报成 mixed。
	oldFiveOff := map[string]string{}
	for _, key := range biteModeLegacyKeys {
		oldFiveOff[key] = "0"
	}
	if got := BiteModeFor(oldFiveOff); got != "legacy" {
		t.Fatalf("旧库五关应仍为 legacy，得到 %q", got)
	}

	// 只开了海钓水层、旧五关：这是管理员显式自定义，应显示 mixed。
	oldFiveOff["marine_layer_enabled"] = "1"
	if got := BiteModeFor(oldFiveOff); got != "mixed" {
		t.Fatalf("只开海钓水层应为 mixed，得到 %q", got)
	}
}
