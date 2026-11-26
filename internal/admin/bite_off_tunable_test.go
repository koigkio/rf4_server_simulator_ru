package admin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"rf4server/internal/config"
	"rf4server/internal/logging"
)

// 咬断线组参数走通用 tunable 写入路径，越界必须被拒，合法值必须落库。
func TestBiteOffTunableValidation(t *testing.T) {
	db := testDB(t)
	if err := db.EnsureAdmin(context.Background(), "admin", "admin123"); err != nil {
		t.Fatal(err)
	}
	s := NewServer(config.Admin{JWTSecret: "bite-off-test"}, db, logging.Discard(), WebFS())
	call := func(method, path, token, body string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		s.mux.ServeHTTP(w, r)
		return w
	}
	login := call(http.MethodPost, "/api/login", "", `{"username":"admin","password":"admin123"}`)
	var auth struct {
		Token string `json:"token"`
	}
	if login.Code != http.StatusOK || json.Unmarshal(login.Body.Bytes(), &auth) != nil || auth.Token == "" {
		t.Fatalf("login: %d %s", login.Code, login.Body)
	}
	set := func(key, value string) int {
		return call(http.MethodPost, "/api/tunables", auth.Token,
			`{"key":"`+key+`","value":"`+value+`"}`).Code
	}

	// 合法值落库。
	for _, kv := range [][2]string{
		{"bite_off_enabled", "1"},
		{"bite_off_over_pct", "20"},
		{"bite_off_under_pct", "4"},
		{"bite_off_sprint_seconds", "10"},
		{"bite_off_species", "n.pike,taimen"},
	} {
		if code := set(kv[0], kv[1]); code != http.StatusOK {
			t.Fatalf("%s=%s code=%d, want 200", kv[0], kv[1], code)
		}
	}
	values, err := db.TunableList(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if values["bite_off_enabled"] != "1" || values["bite_off_over_pct"] != "20" ||
		values["bite_off_species"] != "n.pike,taimen" {
		t.Fatalf("写入后回读不符: %+v", values)
	}

	// 开关只接受 0/1。
	for _, bad := range []string{"2", "on", "-1"} {
		if code := set("bite_off_enabled", bad); code != http.StatusBadRequest {
			t.Fatalf("开关 %q code=%d, want 400", bad, code)
		}
	}
	// 概率 0~100。
	for _, bad := range []string{"-1", "101", "abc", "NaN"} {
		if code := set("bite_off_over_pct", bad); code != http.StatusBadRequest {
			t.Fatalf("概率 %q code=%d, want 400", bad, code)
		}
	}
	// 冲刺间隔 1~120 秒。
	for _, bad := range []string{"0", "0.5", "121", "-10"} {
		if code := set("bite_off_sprint_seconds", bad); code != http.StatusBadRequest {
			t.Fatalf("间隔 %q code=%d, want 400", bad, code)
		}
	}
	// 鱼种表不校验内容，但必须能存任意字符串（含空串=关闭）。
	if code := set("bite_off_species", ""); code != http.StatusOK {
		t.Fatalf("空鱼种表 code=%d, want 200", code)
	}
}
