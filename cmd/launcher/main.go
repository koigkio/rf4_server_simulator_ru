// launcher —— 图形化常驻监督器：一键初始化并管理 gameserver/gateway，
// 并在同一 HTTP 入口内直接挂载 admin 管理 handler。
//
// 系统托盘常驻（getlantern/systray，纯 Go 无 CGO）+ 本地统一 Web 控制中心
// （默认 http://127.0.0.1:9500）。管理后台不再单独监听端口。能力：
//   - 首次运行自动初始化数据库（迁移 + 静态配置导入 + 默认管理员）
//   - 按序启动两个游戏服务并做健康检查；崩溃指数退避自动重启
//   - 托盘菜单：控制面板 / 打开管理后台 / 启停全部 / 退出
//   - 面板：状态卡片、启停按钮、双进程日志实时尾巴
package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/getlantern/systray"

	"rf4server/internal/admin"
	"rf4server/internal/buildinfo"
	"rf4server/internal/config"
	"rf4server/internal/seed"
	"rf4server/internal/store"
	"rf4server/internal/supervisor"
	"rf4server/internal/updatecheck"
)

//go:embed panel.html
var panelHTML []byte

// 应用状态（托盘/面板共享）。
type app struct {
	cfg      *config.Config
	cfgPath  string
	sup      *supervisor.Supervisor
	log      logger
	panelURL string

	ctx    context.Context
	cancel context.CancelFunc

	adminInitMu sync.Mutex
	adminMu     sync.RWMutex
	adminSrv    *admin.Server
	adminDB     *store.DB
	adminErr    string

	gameMu    sync.RWMutex
	startGame func(*exec.Cmd) error

	// 版本更新检测（周期后台任务，结论供 /api/status 与管理后台横幅）
	updates *updatecheck.Checker
	// 检测健康状态只供面板展示；网络失败不会进入启停/日志等操作链路。
	updateHealthMu    sync.RWMutex
	updateHealthState updateHealth

	// 托盘状态：systray 在 Run 之前内部句柄为 nil，提前调用 SetIcon/
	// SetTooltip 会 panic。这里先记录期望状态，托盘就绪后再应用。
	trayMu    sync.Mutex
	trayReady bool
	trayColor int
	trayTip   string
}

type logger interface {
	Info(string)
	Warn(string)
	Error(string)
}

// adminLogger 将 launcher 的简单 logger 适配为 admin 的键值日志接口。
type adminLogger struct{ l logger }

func (l adminLogger) Info(msg string, args ...any)  { l.l.Info(logMessage(msg, args...)) }
func (l adminLogger) Warn(msg string, args ...any)  { l.l.Warn(logMessage(msg, args...)) }
func (l adminLogger) Error(msg string, args ...any) { l.l.Error(logMessage(msg, args...)) }

func main() {
	configPath := flag.String("config", "config.yaml", "Путь к файлу конфигурации")
	panelAddr := flag.String("panel-addr", "127.0.0.1:9500", "Адрес панели управления (только локально)")
	adminUser := flag.String("admin-user", "admin", "Имя первого администратора (действует, если таблица пуста)")
	adminPass := flag.String("admin-pass", "admin123", "Пароль первого администратора (действует, если таблица пуста)")
	staticDB := flag.String("static-db", "", "Путь к статической базе (по умолчанию sqlite.static_path)")
	flag.Parse()

	// ---- 工作目录解析：依次在 CWD、exe 目录和 exe 上级目录寻找 config.yaml。
	// 找到后切换工作目录，使 config、server_data、data、logs 等相对路径统一
	// 以仓库根为基准（双击启动时 CWD 通常是 bin/）。
	workDir := resolveWorkDir(*configPath)
	if workDir != "" {
		if err := os.Chdir(workDir); err != nil {
			showFatal("Не удалось сменить рабочую папку", err)
			return
		}
	}
	cfg, err := config.Load(*configPath)
	if err != nil {
		showFatal("Не удалось загрузить конфигурацию", err)
		return
	}
	if *staticDB == "" {
		*staticDB = cfg.SQLite.StaticPath
	} else {
		cfg.SQLite.StaticPath = *staticDB
		_ = os.Setenv("RF4_SQLITE_STATIC_PATH", *staticDB)
	}
	appCtx, appCancel := context.WithCancel(context.Background())
	app := &app{
		cfg: cfg, cfgPath: *configPath, log: panelLogger{}, ctx: appCtx, cancel: appCancel,
		trayColor: 3, trayTip: "fish-localserver Локальный сервер", // 3=灰 (初始化中)
		updates: updatecheck.New(updatecheck.DefaultSources, updateStateFile),
	}
	defer app.closeAdmin()

	// ---- Web 控制面板（先于首跑 seed 起来：GUI 无控制台，seed 可能耗时
	// 一分钟，浏览器面板是唯一可视化入口，须立即出现）----
	mux := http.NewServeMux()
	// admin 不再单独监听端口，其 handler 直接挂载到统一入口。
	mux.HandleFunc("/admin/", app.handleAdmin)
	mux.HandleFunc("/admin", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/admin/", http.StatusTemporaryRedirect)
	})
	mux.HandleFunc("/api/admin/retry", app.handleAdminRetry)
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(panelHTML)
	})
	mux.HandleFunc("/api/status", app.handleStatus)
	mux.HandleFunc("/api/overview", app.handleOverview)
	mux.HandleFunc("/api/logs", app.handleLogs)
	mux.HandleFunc("/api/start", app.actionHandler("start"))
	mux.HandleFunc("/api/stop", app.actionHandler("stop"))
	mux.HandleFunc("/api/restart", app.actionHandler("restart"))
	mux.HandleFunc("/api/game/config", app.handleGameConfig)
	mux.HandleFunc("/api/game/launch", app.handleGameLaunch)
	mux.HandleFunc("/api/hosts", app.handleHosts)
	mux.HandleFunc("POST /api/update/dismiss", app.handleUpdateDismiss)
	mux.HandleFunc("/api/open-admin", func(w http.ResponseWriter, r *http.Request) {
		openBrowser(app.panelURL + "#admin")
		_ = r
		w.WriteHeader(204)
	})
	ln, err := net.Listen("tcp", *panelAddr)
	if err != nil {
		showFatal("Панель управления не смогла открыть порт", err)
		return
	}
	app.panelURL = "http://" + normalizeLocal(ln.Addr().String())
	go func() { _ = http.Serve(ln, mux) }()
	go app.runUpdateChecks()
	// 启动即用默认浏览器打开统一控制中心
	openBrowser(app.panelURL)

	// ---- 首次初始化（幂等）----
	if seed.NeedsSeed(cfg, *staticDB) {
		app.log.Info("Инициализация базы данных (при первом запуске импортируются статические данные, подождите)…")
		res, err := seed.Ensure(context.Background(), cfg, *staticDB, *adminUser, *adminPass, app.log)
		if err != nil {
			showFatal("Ошибка инициализации базы данных", err)
			return
		}
		app.log.Info(fmt.Sprintf("Инициализация завершена seeded=%v tables=%d admin_created=%v elapsed=%s",
			res.Seeded, res.Tables, res.AdminCreated, res.Elapsed.Round(time.Millisecond)))
		if res.AdminCreated {
			app.log.Warn("Создан администратор по умолчанию admin/" + *adminPass + ", смените пароль в админ-панели как можно скорее")
		}
	}

	// ---- 内嵌管理后台 ----
	if err := app.initAdmin(app.ctx); err != nil {
		app.log.Error("Ошибка инициализации админ-панели: " + err.Error())
	}
	updateTrayIcon(app)

	// ---- 监督器 ----
	binDir := filepath.Dir(mustExePath())
	app.sup = supervisor.New(binDir, *configPath, "logs")
	// 状态回调可能在托盘初始化之前（甚至并发）触发，必须自吞异常，
	// 否则一次托盘调用失败就会带走整个 launcher 及其子进程管理。
	app.sup.SetStateCallback(func() {
		defer func() {
			if r := recover(); r != nil {
				app.log.Error(fmt.Sprintf("Ошибка обновления значка в трее: %v", r))
			}
		}()
		updateTrayIcon(app)
	})

	// 上次异常退出可能遗留 launcher 管理的 hosts 行；先按归属状态恢复官方解析。
	if err := hostsRestore(hostsFilePath()); err != nil {
		app.log.Warn("Не удалось очистить остатки hosts с прошлого запуска: " + err.Error())
	}

	// 后台周期刷新子进程自报的构建身份。必须早于 StartAll 启动：
	// 进程一起观测端口就可用，晚一步面板会先闪一段「未知」。
	go app.trackBuildIdentity()

	// ---- 按序拉起游戏服务 ----
	go func() {
		if err := app.sup.StartAll(); err != nil {
			app.log.Error("Не удалось запустить процесс: " + err.Error())
			return
		}
		if app.cfg.Launcher.HostsSwitch {
			if err := hostsSetLocal(hostsFilePath(), loginDomains(app.cfg)); err != nil {
				app.log.Warn("hosts Автопереключение не удалось (запустите лаунчер от имени администратора): " + err.Error() +
					"; можно вручную направить api.rf4game.ru/com на 127.0.0.1 или выполнить в PowerShell от администратора tools/hosts.ps1 local")
			} else {
				app.log.Info("hosts направлен на локальный сервер, при выходе лаунчера будет восстановлен")
			}
		}
	}()

	// ---- 托盘常驻 ----
	systray.Run(app.onTrayReady, func() {
		app.sup.StopAll()
		if app.cfg.Launcher.HostsSwitch {
			if err := hostsRestore(hostsFilePath()); err != nil {
				app.log.Error("hosts Не удалось восстановить: " + err.Error() +
					"; hosts всё ещё указывает на локальный сервер — чтобы вернуться на официальный, удалите в hosts строки rf4s-local или выполните в PowerShell от администратора tools/hosts.ps1 official")
			} else {
				app.log.Info("hosts Восстановлено на официальные адреса")
			}
		}
	})
}

// ---- 托盘 ----

var (
	mItemPanel   *systray.MenuItem
	mItemAdmin   *systray.MenuItem
	mItemStart   *systray.MenuItem
	mItemStop    *systray.MenuItem
	mItemRestart *systray.MenuItem
	mItemQuit    *systray.MenuItem
)

func (a *app) onTrayReady() {
	systray.SetIcon(iconColor(3)) // 初始灰色由状态回调刷新
	systray.SetTitle("fish-localserver")
	systray.SetTooltip("fish-localserver Локальный сервер")

	mItemPanel = systray.AddMenuItem("Открыть центр управления", "Состояние процессов, журналы и запуск игры")
	mItemAdmin = systray.AddMenuItem("Открыть админ-панель", "Сразу перейти в админ-панель центра управления")
	systray.AddSeparator()
	mItemStart = systray.AddMenuItem("Запустить всё", "Запустить оба игровых сервиса по порядку")
	mItemStop = systray.AddMenuItem("Остановить всё", "Остановить все игровые сервисы")
	mItemRestart = systray.AddMenuItem("Перезапустить всё", "Перезапустить все игровые сервисы")
	systray.AddSeparator()
	mItemQuit = systray.AddMenuItem("Выход", "Остановить сервисы и выйти")

	go func() {
		for range mItemPanel.ClickedCh {
			openBrowser(a.panelURL)
		}
	}()
	go func() {
		for range mItemAdmin.ClickedCh {
			openBrowser(a.panelURL + "#admin")
		}
	}()
	go func() {
		for range mItemStart.ClickedCh {
			go func() { _ = a.sup.StartAll() }()
		}
	}()
	go func() {
		for range mItemStop.ClickedCh {
			a.sup.StopAll()
		}
	}()
	go func() {
		for range mItemRestart.ClickedCh {
			a.sup.StopAll()
			time.Sleep(500 * time.Millisecond)
			go func() { _ = a.sup.StartAll() }()
		}
	}()
	go func() {
		for range mItemQuit.ClickedCh {
			systray.Quit()
		}
	}()

	// 托盘句柄此时才可用：标记就绪并补应用初始化期间记录的状态。
	a.trayMu.Lock()
	a.trayReady = true
	applyTrayLocked(a.trayColor, a.trayTip)
	a.trayMu.Unlock()
}

// updateTrayIcon 按运行中进程数切换托盘颜色（绿=全部 / 黄=部分 / 红=无）。
func updateTrayIcon(a *app) {
	if a.sup == nil {
		return
	}
	running := 0
	for _, p := range a.sup.Status() {
		if p.State == supervisor.StateRunning {
			running++
		}
	}
	a.adminMu.RLock()
	adminReady := a.adminSrv != nil
	a.adminMu.RUnlock()
	switch {
	case running == 2 && adminReady:
		a.setTray(0, "fish-localserver: всё готово") // 绿
	case running > 0 || adminReady:
		a.setTray(1, fmt.Sprintf("fish-localserver: игровых сервисов %d/2, админ-панель=%v", running, adminReady)) // 黄
	default:
		a.setTray(2, "fish-localserver: остановлено") // 红
	}
}

// setTray 记录并应用托盘图标/提示。systray 未就绪时只记录状态，
// 避免在 systray.Run 初始化前访问 nil 的 Win32 托盘句柄导致 panic。
func (a *app) setTray(color int, tip string) {
	a.trayMu.Lock()
	defer a.trayMu.Unlock()
	a.trayColor, a.trayTip = color, tip
	if !a.trayReady {
		return
	}
	applyTrayLocked(color, tip)
}

// applyTrayLocked 实际写入托盘（调用方须持有 trayMu）。
func applyTrayLocked(color int, tip string) {
	systray.SetIcon(iconColor(color))
	systray.SetTooltip(tip)
}

// ---- Web 面板 API ----

func (a *app) handleStatus(w http.ResponseWriter, _ *http.Request) {
	// sup 为 nil = 首跑 seed 尚未结束
	procs := []supervisor.ProcInfo{}
	lastErr := ""
	if a.sup != nil {
		procs = a.sup.Status()
		lastErr = a.sup.LastError()
	}
	a.adminMu.RLock()
	adminReady := a.adminSrv != nil
	adminErr := a.adminErr
	a.adminMu.RUnlock()
	gamePath, gameRegion := a.gameState()
	launchVia, steamAppID := a.launchState()
	var update *updatecheck.Result
	if a.updates != nil {
		update = a.updates.Result()
	}
	writeJSON(w, map[string]any{
		"procs":           procs,
		"last_error":      lastErr,
		"launcher_build":  launcherBuild(),
		"admin":           "/admin/",
		"admin_ready":     adminReady,
		"admin_error":     adminErr,
		"game_path":       gamePath,
		"game_region":     gameRegion,
		"launch_via":      launchVia,
		"steam_app_id":    steamAppID,
		"hosts":           hostsMode(hostsFilePath()),
		"current_version": buildinfo.Version,
		"update":          update,
		"update_status":   a.updateHealthSnapshot(),
	})
}

// handleOverview 控制中心首页的「后台信息」：只读统计，不需要登录管理后台。
// 直接读的是管理后台同一个库（WAL 只读 COUNT，不写），读不到就留空由前端显示「未上报」。
func (a *app) handleOverview(w http.ResponseWriter, r *http.Request) {
	user := a.cfg.Admin.Username
	if user == "" {
		user = "admin"
	}
	out := map[string]any{
		"admin":      "/admin/",
		"admin_user": user,
		"host":       r.Host,
	}
	a.adminMu.RLock()
	db := a.adminDB
	a.adminMu.RUnlock()
	if db == nil {
		out["ready"] = false
		writeJSON(w, out)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	var players, items, mails, audits int64
	if err := db.SQL.QueryRowContext(ctx, `SELECT COUNT(*) FROM profile`).Scan(&players); err != nil {
		out["ready"] = false
		writeJSON(w, out)
		return
	}
	_ = db.SQL.QueryRowContext(ctx, `SELECT COUNT(*) FROM item`).Scan(&items)
	_ = db.SQL.QueryRowContext(ctx, `SELECT COUNT(*) FROM mail`).Scan(&mails)
	_ = db.SQL.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log`).Scan(&audits)
	tunables, _ := db.TunableList(ctx)
	out["ready"] = true
	out["players"] = players
	out["items"] = items
	out["mails"] = mails
	out["audits"] = audits
	out["tunables"] = len(tunables)
	out["db"] = "up"
	writeJSON(w, out)
}

// handleHosts 面板 hosts 指向开关：GET 返回当前指向，POST ?mode=local|official 切换。
func (a *app) handleHosts(w http.ResponseWriter, r *http.Request) {
	path := hostsFilePath()
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, map[string]any{"mode": hostsMode(path)})
	case http.MethodPost:
		mode := r.URL.Query().Get("mode")
		var err error
		switch mode {
		case "local":
			err = hostsSetLocal(path, loginDomains(a.cfg))
		case "official":
			err = hostsRestore(path)
		default:
			httpError(w, "mode должен быть local или official")
			return
		}
		if err != nil {
			httpError(w, "hosts Ошибка записи (запустите лаунчер от имени администратора): "+err.Error()+
				"; можно вручную направить api.rf4game.ru/com на 127.0.0.1 или выполнить в PowerShell от администратора tools/hosts.ps1 local")
			return
		}
		a.log.Info("hosts переключён на " + map[string]string{"local": "Локальный сервер", "official": "Официальный сервер"}[mode])
		w.WriteHeader(204)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *app) handleLogs(w http.ResponseWriter, r *http.Request) {
	if a.sup == nil { // 首跑 seed 阶段
		writeJSON(w, map[string]any{"lines": []string{}, "next": 0})
		return
	}
	name := r.URL.Query().Get("name")
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	lines, next := a.sup.Logs(name, since)
	writeJSON(w, map[string]any{"lines": lines, "next": next})
}

func (a *app) actionHandler(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.sup == nil {
			httpError(w, "Сервисы инициализируются, подождите")
			return
		}
		name := r.URL.Query().Get("name")
		var err error
		switch action {
		case "start":
			if name == "" {
				err = a.sup.StartAll()
			} else {
				err = a.sup.StartOne(name)
			}
		case "stop":
			if name == "" {
				a.sup.StopAll()
			} else {
				a.sup.StopOne(name)
			}
		case "restart":
			if name == "" {
				a.sup.StopAll()
				time.Sleep(500 * time.Millisecond)
				err = a.sup.StartAll()
			} else {
				err = a.sup.RestartOne(name)
			}
		}
		if err != nil {
			httpError(w, err.Error())
			return
		}
		w.WriteHeader(204)
	}
}

func (a *app) initAdmin(ctx context.Context) error {
	a.adminInitMu.Lock()
	defer a.adminInitMu.Unlock()

	a.adminMu.RLock()
	ready := a.adminSrv != nil
	a.adminMu.RUnlock()
	if ready {
		return nil
	}

	db, err := store.OpenWithStatic(a.cfg.SQLite.Path, a.cfg.SQLite.StaticPath)
	if err != nil {
		a.setAdminError(err)
		return err
	}
	if err := db.Migrate(); err != nil {
		_ = db.Close()
		a.setAdminError(err)
		return err
	}
	user, pass := a.cfg.Admin.Username, a.cfg.Admin.Password
	if user == "" {
		user, pass = "admin", "admin123"
	}
	if _, err := db.UpsertAdminPassword(ctx, user, pass); err != nil {
		_ = db.Close()
		a.setAdminError(err)
		return err
	}
	srv := admin.NewServer(a.cfg.Admin, db, adminLogger{a.log}, admin.WebFS())
	// 更新检测可能先于管理后台就绪已有结论，补推一次。
	var update *updatecheck.Result
	if a.updates != nil {
		update = a.updates.Result()
	}
	srv.SetUpdateInfo(adminUpdateInfo(update))
	a.adminMu.Lock()
	a.adminDB = db
	a.adminSrv = srv
	a.adminErr = ""
	a.adminMu.Unlock()
	go a.trackAdminSessions(a.ctx, db, srv)
	a.log.Info("Админ-панель подключена по адресу /admin/")
	return nil
}

func (a *app) setAdminError(err error) {
	a.adminMu.Lock()
	a.adminErr = err.Error()
	a.adminMu.Unlock()
}

func (a *app) handleAdmin(w http.ResponseWriter, r *http.Request) {
	a.adminMu.RLock()
	srv := a.adminSrv
	a.adminMu.RUnlock()
	if srv == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = fmt.Fprint(w, `<!doctype html><meta charset="utf-8"><title>Админ-панель не готова</title><style>body{background:#09111d;color:#e8f0f8;font:15px/1.7 "Segoe UI",sans-serif;padding:48px}</style><h2>Админ-панель ещё не готова</h2><p>Вернитесь в центр управления, проверьте состояние инициализации и повторите.</p>`)
		return
	}
	http.StripPrefix("/admin", srv.Handler()).ServeHTTP(w, r)
}

func (a *app) handleAdminRetry(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := a.initAdmin(ctx); err != nil {
		httpError(w, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// launcherBuild 返回 launcher 自身的构建身份。
//
// /api/status 原有的 current_version 也是 launcher 的版本，但它不带
// commit/buildts/source，排查时容易被误读成「子进程的版本」。这里单独
// 开一组字段，与 procs[].running_build（子进程自报）并排，一眼能分清谁是谁。
func launcherBuild() map[string]string {
	version, buildts, commit, source := buildinfo.MetricLabels()
	return map[string]string{
		"version": version,
		"buildts": buildts,
		"commit":  commit,
		"source":  source,
	}
}

// trackBuildIdentity 周期刷新子进程自报的构建身份，并在发现磁盘上的
// 可执行文件被替换时记一条警告。
//
// 为什么需要它：bin/ 被别的构建覆盖后，运行中的进程仍是旧代码，而所有
// 可见信息（/healthz、日志里的启动版本行、面板的「当前运行版本」）都看不出
// 异常。让进程自己吐版本，才可能发现「跑的不是你以为的那份」。
func (a *app) trackBuildIdentity() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	warned := map[string]bool{}
	for {
		select {
		case <-a.ctx.Done():
			return
		case <-ticker.C:
		}
		if a.sup == nil {
			continue
		}
		a.sup.RefreshBuilds()
		for _, p := range a.sup.Status() {
			if p.ExeChanged && !warned[p.Name] {
				a.log.Warn(fmt.Sprintf(
					"%s.exe заменён на диске, но работает ещё версия со старта (pid=%d, версия %s); новая сборка заработает после перезапуска",
					p.Name, p.PID, buildVersionOf(p.RunningBuild)))
			}
			warned[p.Name] = p.ExeChanged
		}
	}
}

// buildVersionOf 取子进程自报版本；读不到时返回「未知」而不是空串——
// 「读不到」本身就是要暴露的信息。
func buildVersionOf(b *supervisor.BuildInfo) string {
	if b == nil || b.Version == "" {
		return "Неизвестно"
	}
	return b.Version
}

func (a *app) trackAdminSessions(ctx context.Context, db *store.DB, srv *admin.Server) {
	update := func() {
		if n, ok, _ := db.KVGet(ctx, "stats:sessions"); ok {
			var v int64
			_, _ = fmt.Sscanf(n, "%d", &v)
			srv.SetSessionCount(v)
		}
	}
	update()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			update()
		}
	}
}

func (a *app) closeAdmin() {
	if a.cancel != nil {
		a.cancel()
	}
	a.adminMu.Lock()
	db := a.adminDB
	a.adminDB = nil
	a.adminSrv = nil
	a.adminMu.Unlock()
	if db != nil {
		_ = db.Close()
	}
}

// ---- 辅助 ----

type panelLogger struct{}

func (panelLogger) Info(m string)  { fmt.Println("launcher:", m) }
func (panelLogger) Warn(m string)  { fmt.Println("launcher WARN:", m) }
func (panelLogger) Error(m string) { fmt.Println("launcher ERROR:", m) }

func logMessage(msg string, args ...any) string {
	if len(args) == 0 {
		return msg
	}
	return msg + " " + fmt.Sprint(args...)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(500)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// normalizeLocal ":9500"/"9500" → "127.0.0.1:9500"；host:port 原样返回。
func normalizeLocal(addr string) string {
	switch {
	case addr == "":
		return "127.0.0.1"
	case strings.HasPrefix(addr, ":"):
		return "127.0.0.1" + addr
	case !strings.Contains(addr, ":"):
		return "127.0.0.1:" + addr
	}
	return addr
}

func mustExePath() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return exe
}

func openBrowser(url string) {
	_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

func showFatal(msg string, err error) {
	panelLogger{}.Error(msg + ": " + err.Error())
	// 无控制台（windowsgui）场景至少把错误写进面板可达的日志文件
	_ = os.WriteFile("launcher_error.log", []byte(msg+": "+err.Error()+"\n"), 0o644)
}

func showTrayTip(_ string) {}

// resolveWorkDir 定位包含 config.yaml 的工作目录（CWD → exe 目录 → exe 上级）。
func resolveWorkDir(configPath string) string {
	candidates := []string{"."}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates, dir, filepath.Dir(dir))
	}
	for _, dir := range candidates {
		full := configPath
		if dir != "." {
			full = filepath.Join(dir, configPath)
		}
		if _, err := os.Stat(full); err == nil {
			if dir == "." {
				return "" // 已在正确目录
			}
			return dir
		}
	}
	return "" // 找不到就留在 CWD (config.Load 会给出明确报错)
}
