package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"rf4server/internal/config"
)

func TestNormalizeGameExecutable(t *testing.T) {
	dir := t.TempDir()
	game := filepath.Join(dir, "rf4_x64.exe")
	if err := os.WriteFile(game, []byte("stub"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := normalizeGameExecutable(`"` + game + `"`)
	if err != nil {
		t.Fatal(err)
	}
	if got != game {
		t.Fatalf("path=%q, want %q", got, game)
	}
	if _, err := normalizeGameExecutable("rf4_x64.exe"); err == nil {
		t.Fatal("relative path should fail")
	}
	wrong := filepath.Join(dir, "other.exe")
	if err := os.WriteFile(wrong, []byte("stub"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := normalizeGameExecutable(wrong); err == nil {
		t.Fatal("wrong executable name should fail")
	}
}

// 从聊天窗口/资源管理器粘贴路径时常混入方向标记、零宽字符或全角冒号，
// 这些不可见字符会让 filepath.IsAbs 判成相对路径，必须自动清理。
func TestNormalizeGameExecutableStripsInvisibleChars(t *testing.T) {
	dir := t.TempDir()
	game := filepath.Join(dir, "rf4_x64.exe")
	if err := os.WriteFile(game, []byte("stub"), 0o644); err != nil {
		t.Fatal(err)
	}
	// filepath.Join 在 Windows 下用反斜杠，实测路径形如 C:\...\rf4_x64.exe。
	raw := game
	half := len(raw) / 2
	noisy := []string{
		"\u202a" + raw,                     // LTR 嵌入标记
		"\u200b" + raw + "\u200b",          // 零宽空格
		"\uFEFF" + raw,                     // BOM
		"\"" + raw + "\"",                  // 复制为路径带引号
		"  " + raw + " \r\n",               // 首尾空白
		raw[:half] + "\u202c" + raw[half:], // 路径中间的格式字符
		strings.Replace(raw, ":", "：", 1),  // 全角冒号
	}
	for _, in := range noisy {
		got, err := normalizeGameExecutable(in)
		if err != nil {
			t.Fatalf("input=%q err=%v", in, err)
		}
		if got != game {
			t.Fatalf("input=%q got=%q, want %q", in, got, game)
		}
	}
}

func TestBuildGameCommand(t *testing.T) {
	dir := t.TempDir()
	game := filepath.Join(dir, "rf4_x64.exe")
	if err := os.WriteFile(game, []byte("stub"), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd, err := buildGameCommand(game, "CN")
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Dir != dir {
		t.Fatalf("dir=%q, want %q", cmd.Dir, dir)
	}
	wantArgs := []string{game, "-region", "CN"}
	if strings.Join(cmd.Args, "|") != strings.Join(wantArgs, "|") {
		t.Fatalf("args=%q, want %q", cmd.Args, wantArgs)
	}
}

func TestPersistLauncherConfigPreservesExistingSections(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	original := "# keep this comment\nenv: dev\ngateway:\n  advertise_port: 9341\n"
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	gamePath := filepath.Join(dir, "rf4_x64.exe")
	if err := persistLauncherConfig(path, gamePath, "CN"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "# keep this comment") {
		t.Fatalf("comment was lost:\n%s", data)
	}
	var cfg config.Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Launcher.GamePath != gamePath || cfg.Launcher.GameRegion != "CN" {
		t.Fatalf("launcher config=%+v", cfg.Launcher)
	}
}

func TestGameConfigAndLaunchHandlers(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(cfgPath, []byte("env: dev\ngateway:\n  advertise_port: 9341\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gamePath := filepath.Join(dir, "rf4_x64.exe")
	if err := os.WriteFile(gamePath, []byte("stub"), 0o644); err != nil {
		t.Fatal(err)
	}

	var launched *exec.Cmd
	a := &app{
		cfg:     &config.Config{Launcher: config.Launcher{GameRegion: "CN"}},
		cfgPath: cfgPath,
		log:     panelLogger{},
		startGame: func(cmd *exec.Cmd) error {
			launched = cmd
			return nil
		},
	}
	body, _ := json.Marshal(gameConfigRequest{Path: gamePath})
	req := panelPOSTRequest("/api/game/config", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	a.handleGameConfig(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("save code=%d body=%s", rr.Code, rr.Body.String())
	}
	if a.cfg.Launcher.GamePath != gamePath {
		t.Fatalf("in-memory path=%q", a.cfg.Launcher.GamePath)
	}

	rr = httptest.NewRecorder()
	a.handleGameLaunch(rr, panelPOSTRequest("/api/game/launch", bytes.NewBufferString("{}")))
	if rr.Code != http.StatusOK {
		t.Fatalf("launch code=%d body=%s", rr.Code, rr.Body.String())
	}
	if launched == nil || strings.Join(launched.Args, "|") != strings.Join([]string{gamePath, "-region", "CN"}, "|") {
		t.Fatalf("launched command=%v", launched)
	}
}

func TestGameLaunchRejectsCrossOrigin(t *testing.T) {
	a := &app{cfg: &config.Config{Launcher: config.Launcher{GameRegion: "CN"}}}
	req := panelPOSTRequest("/api/game/launch", bytes.NewBufferString("{}"))
	req.Header.Set("Origin", "http://evil.example")
	rr := httptest.NewRecorder()
	a.handleGameLaunch(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("code=%d body=%s", rr.Code, rr.Body.String())
	}
}

func panelPOSTRequest(path string, body io.Reader) *http.Request {
	req := httptest.NewRequest(http.MethodPost, path, body)
	req.RemoteAddr = "127.0.0.1:12345"
	req.Host = "127.0.0.1:9500"
	req.Header.Set("Origin", "http://127.0.0.1:9500")
	req.Header.Set("Content-Type", "application/json")
	return req
}

func TestBuildSteamCommandFindsSteamExeFromGamePath(t *testing.T) {
	root := t.TempDir()
	steamExe := filepath.Join(root, "steam.exe")
	if err := os.WriteFile(steamExe, []byte("stub"), 0o644); err != nil {
		t.Fatal(err)
	}
	gameDir := filepath.Join(root, "steamapps", "common", "Russian Fishing 4")
	if err := os.MkdirAll(gameDir, 0o755); err != nil {
		t.Fatal(err)
	}
	game := filepath.Join(gameDir, "rf4_x64.exe")
	cmd, err := buildSteamCommand(game, "RU", 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(cmd.Args[1:], " "); got != "-applaunch 766570 -region RU" {
		// В реестре мог найтись настоящий Steam — проверяем только аргументы.
		t.Fatalf("args=%q", got)
	}
}

func TestBuildSteamCommandFallsBackToProtocol(t *testing.T) {
	if steamExeFromRegistry() != "" {
		t.Skip("на машине установлен Steam")
	}
	cmd, err := buildSteamCommand("", "RU", 766570)
	if err != nil {
		t.Fatal(err)
	}
	if got := cmd.Args[len(cmd.Args)-1]; got != "steam://run/766570//-region%20RU/" {
		t.Fatalf("uri=%q", got)
	}
}

func TestNormalizeLaunchVia(t *testing.T) {
	for in, want := range map[string]string{"": launchDirect, "direct": launchDirect, "Steam": launchSteam, " steam ": launchSteam, "x": launchDirect} {
		if got := normalizeLaunchVia(in); got != want {
			t.Fatalf("normalizeLaunchVia(%q)=%q, want %q", in, got, want)
		}
	}
}

func TestGameLaunchViaSteamDoesNotRequireGamePath(t *testing.T) {
	var launched *exec.Cmd
	a := &app{
		cfg:       &config.Config{Launcher: config.Launcher{GameRegion: "RU", LaunchVia: "steam", SteamAppID: 766570}},
		startGame: func(cmd *exec.Cmd) error { launched = cmd; return nil },
		log:       panelLogger{},
	}
	rr := httptest.NewRecorder()
	a.handleGameLaunch(rr, panelPOSTRequest("/api/game/launch", bytes.NewBufferString("{}")))
	if rr.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rr.Code, rr.Body.String())
	}
	args := strings.Join(launched.Args, " ")
	if !strings.Contains(args, "766570") || !strings.Contains(args, "RU") {
		t.Fatalf("args=%q", args)
	}
}
