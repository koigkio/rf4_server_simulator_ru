package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"

	"gopkg.in/yaml.v3"
)

const (
	defaultGameRegion = "RU"
	defaultSteamAppID = 766570

	launchDirect = "direct"
	launchSteam  = "steam"
)

type gameConfigRequest struct {
	Path      string  `json:"path"`
	LaunchVia *string `json:"launch_via,omitempty"`
}

// launchState возвращает способ запуска (direct/steam) и AppID игры в Steam.
func (a *app) launchState() (string, int) {
	a.gameMu.RLock()
	defer a.gameMu.RUnlock()
	via := normalizeLaunchVia(a.cfg.Launcher.LaunchVia)
	appID := a.cfg.Launcher.SteamAppID
	if appID <= 0 {
		appID = defaultSteamAppID
	}
	return via, appID
}

func normalizeLaunchVia(raw string) string {
	if strings.EqualFold(strings.TrimSpace(raw), launchSteam) {
		return launchSteam
	}
	return launchDirect
}

func (a *app) gameState() (string, string) {
	a.gameMu.RLock()
	defer a.gameMu.RUnlock()
	region := strings.TrimSpace(a.cfg.Launcher.GameRegion)
	if region == "" {
		region = defaultGameRegion
	}
	return a.cfg.Launcher.GamePath, region
}

func (a *app) handleGameConfig(w http.ResponseWriter, r *http.Request) {
	if !requireLocalJSONPost(w, r) {
		return
	}
	defer r.Body.Close()
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var req gameConfigRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]string{"error": "Неверные параметры: " + err.Error()})
		return
	}
	if req.LaunchVia != nil {
		if err := a.saveLaunchVia(*req.LaunchVia); err != nil {
			writeJSONStatus(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	gamePath, region := a.gameState()
	if req.LaunchVia == nil || strings.TrimSpace(req.Path) != "" {
		var err error
		gamePath, region, err = a.saveGamePath(req.Path)
		if err != nil {
			writeJSONStatus(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	via, _ := a.launchState()
	writeJSON(w, map[string]any{"path": gamePath, "region": region, "launch_via": via})
}

func (a *app) handleGameLaunch(w http.ResponseWriter, r *http.Request) {
	if !requireLocalJSONPost(w, r) {
		return
	}
	gamePath, region := a.gameState()
	via, appID := a.launchState()
	var (
		cmd *exec.Cmd
		err error
	)
	if via == launchSteam {
		cmd, err = buildSteamCommand(gamePath, region, appID)
	} else {
		cmd, err = buildGameCommand(gamePath, region)
	}
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := a.startGameProcess(cmd); err != nil {
		writeJSONStatus(w, http.StatusInternalServerError, map[string]string{"error": "Не удалось запустить игру: " + err.Error()})
		return
	}
	a.log.Info("Игра запущена: " + strings.Join(cmd.Args, " "))
	writeJSON(w, map[string]any{"ok": true, "path": gamePath, "region": region, "launch_via": via})
}

func (a *app) saveGamePath(rawPath string) (string, string, error) {
	gamePath, err := normalizeGameExecutable(rawPath)
	if err != nil {
		return "", "", err
	}
	_, region := a.gameState()
	region, err = normalizeGameRegion(region)
	if err != nil {
		return "", "", err
	}
	if a.cfgPath == "" {
		return "", "", fmt.Errorf("Не указан путь к файлу конфигурации")
	}
	if err := persistLauncherConfig(a.cfgPath, gamePath, region); err != nil {
		return "", "", fmt.Errorf("Не удалось записать конфигурацию: %w", err)
	}
	a.gameMu.Lock()
	a.cfg.Launcher.GamePath = gamePath
	a.cfg.Launcher.GameRegion = region
	a.gameMu.Unlock()
	return gamePath, region, nil
}

func (a *app) saveLaunchVia(raw string) error {
	v := strings.ToLower(strings.TrimSpace(raw))
	if v != launchDirect && v != launchSteam {
		return fmt.Errorf("launch_via должен быть %q или %q", launchDirect, launchSteam)
	}
	if a.cfgPath == "" {
		return fmt.Errorf("Не указан путь к файлу конфигурации")
	}
	if err := persistLauncherValues(a.cfgPath, map[string]string{"launch_via": v}); err != nil {
		return fmt.Errorf("Не удалось записать конфигурацию: %w", err)
	}
	a.gameMu.Lock()
	a.cfg.Launcher.LaunchVia = v
	a.gameMu.Unlock()
	return nil
}

func (a *app) startGameProcess(cmd *exec.Cmd) error {
	if a.startGame != nil {
		return a.startGame(cmd)
	}
	return cmd.Start()
}

func buildGameCommand(rawPath, rawRegion string) (*exec.Cmd, error) {
	gamePath, err := normalizeGameExecutable(rawPath)
	if err != nil {
		return nil, err
	}
	region, err := normalizeGameRegion(rawRegion)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(gamePath, "-region", region)
	cmd.Dir = filepath.Dir(gamePath)
	return cmd, nil
}

// buildSteamCommand запускает игру через клиент Steam:
//
//	steam.exe -applaunch <appid> -region <region>
//
// Так игра стартует с авторизацией Steam (оверлей, время в игре и т.д.),
// а вход всё равно идёт на локальный сервер через hosts. Если steam.exe не
// найден, используется протокол steam://run/<appid>//-region <region>/.
func buildSteamCommand(rawGamePath, rawRegion string, appID int) (*exec.Cmd, error) {
	region, err := normalizeGameRegion(rawRegion)
	if err != nil {
		return nil, err
	}
	if appID <= 0 {
		appID = defaultSteamAppID
	}
	if steamExe := findSteamExe(sanitizeGamePath(rawGamePath)); steamExe != "" {
		cmd := exec.Command(steamExe, "-applaunch", strconv.Itoa(appID), "-region", region)
		cmd.Dir = filepath.Dir(steamExe)
		return cmd, nil
	}
	uri := fmt.Sprintf("steam://run/%d//-region%%20%s/", appID, region)
	return exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", uri), nil
}

// findSteamExe ищет steam.exe: сначала в реестре (HKCU\Software\Valve\Steam),
// затем по пути игры (…\steamapps\common\<игра>\rf4_x64.exe → …\steam.exe).
func findSteamExe(gamePath string) string {
	candidates := []string{steamExeFromRegistry()}
	if gamePath != "" {
		dir := filepath.Dir(gamePath)
		for i := 0; i < 6 && dir != filepath.Dir(dir); i++ {
			if strings.EqualFold(filepath.Base(dir), "steamapps") {
				candidates = append(candidates, filepath.Join(filepath.Dir(dir), "steam.exe"))
				break
			}
			dir = filepath.Dir(dir)
		}
	}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if info, err := os.Stat(c); err == nil && info.Mode().IsRegular() {
			return filepath.Clean(c)
		}
	}
	return ""
}

// sanitizeGamePath 清理粘贴路径里的干扰字符：Unicode 格式字符（BOM、
// 零宽空格、LTR/RTL 方向标记等，常见于从聊天窗口/资源管理器“复制为路径”
// 之后）以及中日韩输入法打出的全角冒号、反斜杠。残留一个方向标记就会让
// filepath.IsAbs 判定为相对路径，报“必须填写绝对路径”。
func sanitizeGamePath(rawPath string) string {
	cleaned := strings.Map(func(r rune) rune {
		switch {
		case r == '\uFEFF', unicode.Is(unicode.Cf, r):
			return -1
		case r == '：': // 全角冒号
			return ':'
		case r == '＼' || r == '／': // 全角反斜杠 / 斜杠
			return '\\'
		}
		return r
	}, rawPath)
	// 去掉两端空白与配对/半残的引号（资源管理器“复制为路径”会带双引号）。
	return strings.Trim(cleaned, " \t\r\n\"'")
}

func normalizeGameExecutable(rawPath string) (string, error) {
	gamePath := sanitizeGamePath(rawPath)
	if gamePath == "" {
		return "", fmt.Errorf("Укажите полный путь к rf4_x64.exe")
	}
	if !filepath.IsAbs(gamePath) {
		return "", fmt.Errorf("Нужен абсолютный путь (распознано как %q — проверьте, нет ли в начале или конце пробелов, кавычек или невидимых символов)", gamePath)
	}
	gamePath = filepath.Clean(gamePath)
	if !strings.EqualFold(filepath.Base(gamePath), "rf4_x64.exe") {
		return "", fmt.Errorf("Имя файла должно быть rf4_x64.exe")
	}
	info, err := os.Stat(gamePath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("Файл не существует: %s", gamePath)
		}
		return "", fmt.Errorf("Не удалось проверить файл: %w", err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("Путь указывает не на обычный файл: %s", gamePath)
	}
	return gamePath, nil
}

func normalizeGameRegion(rawRegion string) (string, error) {
	region := strings.TrimSpace(rawRegion)
	if region == "" {
		return defaultGameRegion, nil
	}
	for _, ch := range region {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-' {
			continue
		}
		return "", fmt.Errorf("game_region может содержать только буквы, цифры, подчёркивание или дефис")
	}
	return region, nil
}

func persistLauncherConfig(configPath, gamePath, region string) error {
	return persistLauncherValues(configPath, map[string]string{"game_path": gamePath, "game_region": region})
}

func persistLauncherValues(configPath string, values map[string]string) error {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return err
	}
	info, err := os.Stat(configPath)
	if err != nil {
		return err
	}
	var doc yaml.Node
	if strings.TrimSpace(string(data)) != "" {
		if err := yaml.Unmarshal(data, &doc); err != nil {
			return err
		}
	}
	if doc.Kind == 0 {
		doc.Kind = yaml.DocumentNode
	}
	if len(doc.Content) == 0 {
		doc.Content = append(doc.Content, &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"})
	}
	root := doc.Content[0]
	if root.Kind != yaml.MappingNode {
		return fmt.Errorf("Корень конфигурации не является YAML-картой")
	}
	launcher := mappingValue(root, "launcher")
	if launcher == nil {
		root.Content = append(root.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "launcher"},
			&yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"},
		)
		launcher = root.Content[len(root.Content)-1]
	}
	if launcher.Kind != yaml.MappingNode {
		return fmt.Errorf("Раздел launcher не является YAML-картой")
	}
	for _, key := range []string{"game_path", "game_region", "launch_via"} {
		if v, ok := values[key]; ok {
			setMappingValue(launcher, key, v)
		}
	}
	out, err := yaml.Marshal(&doc)
	if err != nil {
		return err
	}
	return os.WriteFile(configPath, out, info.Mode().Perm())
}

func mappingValue(mapping *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			return mapping.Content[i+1]
		}
	}
	return nil
}

func setMappingValue(mapping *yaml.Node, key, value string) {
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value != key {
			continue
		}
		node := mapping.Content[i+1]
		node.Kind = yaml.ScalarNode
		node.Tag = "!!str"
		node.Value = value
		return
	}
	mapping.Content = append(mapping.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key},
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value},
	)
}

func requireLocalJSONPost(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSONStatus(w, http.StatusMethodNotAllowed, map[string]string{"error": "Поддерживается только POST"})
		return false
	}
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		writeJSONStatus(w, http.StatusUnsupportedMediaType, map[string]string{"error": "Content-Type должен быть application/json"})
		return false
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || !net.ParseIP(host).IsLoopback() {
		writeJSONStatus(w, http.StatusForbidden, map[string]string{"error": "Разрешены вызовы только из локального центра управления"})
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || !strings.EqualFold(u.Host, r.Host) {
			writeJSONStatus(w, http.StatusForbidden, map[string]string{"error": "Межсайтовый запрос отклонён"})
			return false
		}
	}
	return true
}

func writeJSONStatus(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
