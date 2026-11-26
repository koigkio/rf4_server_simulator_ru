// admin —— Web 管理后台进程。
//
// JWT 登录 + 玩家管理（改数据/发物品/发测试包/踢人/封禁）+ 运行参数热更 +
// 审计日志；前端为内嵌 SPA（internal/admin/web，无外部依赖）。
// 运行时指令写入共享 SQLite 队列，由 gameserver 轮询消费。
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"rf4server/internal/admin"
	"rf4server/internal/buildinfo"
	"rf4server/internal/config"
	"rf4server/internal/logging"
	"rf4server/internal/metrics"
	"rf4server/internal/store"
)

func main() {
	configPath := flag.String("config", "config.yaml", "Путь к файлу конфигурации")
	initAdmin := flag.String("init-admin", "", "Создать администратора: -init-admin user:password (действует, если таблица пуста)")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "admin:", err)
		os.Exit(2)
	}
	log := logging.New(cfg.Log.Level, cfg.Log.Format)
	log.Info("admin Запуск",
		"version", buildinfo.Version, "commit", buildinfo.GitCommit,
		"env", cfg.Env, "http", cfg.Admin.HTTPAddr)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	obs := metrics.NewServer(cfg.Admin.ObsAddr, "admin")
	obsErrCh := obs.Start()

	db, err := store.OpenWithStatic(cfg.SQLite.Path, cfg.SQLite.StaticPath)
	if err != nil {
		log.Error("SQLite Не удалось открыть", "path", cfg.SQLite.Path, "static", cfg.SQLite.StaticPath, "err", err)
		os.Exit(1)
	}
	defer db.Close()
	if err := db.Migrate(); err != nil {
		log.Error("Ошибка миграции", "err", err)
		os.Exit(1)
	}
	// 管理员凭据以配置为准：账号不存在则创建，密码哈希不一致则更新。
	// -init-admin 仅用于首次初始化，优先级低于配置。
	if *initAdmin != "" {
		user, pass, ok := splitColon(*initAdmin)
		if !ok {
			log.Error("init-admin Ожидаемый формат user:password")
			os.Exit(2)
		}
		if err := db.EnsureAdmin(ctx, user, pass); err != nil {
			log.Error("Не удалось создать администратора", "err", err)
			os.Exit(1)
		}
		log.Info("Администратор существует (создаётся только при пустой таблице)", "user", user)
	}
	adminUser := cfg.Admin.Username
	adminPass := cfg.Admin.Password
	if adminUser == "" {
		adminUser, adminPass = "admin", "admin123" // 配置缺省时兜底默认
	}
	created, err := db.UpsertAdminPassword(ctx, adminUser, adminPass)
	if err != nil {
		log.Error("Не удалось синхронизировать учётные данные администратора", "err", err)
		os.Exit(1)
	}
	if created {
		log.Info("Администратор создан", "user", adminUser)
	} else {
		log.Info("Учётные данные администратора синхронизированы", "user", adminUser)
	}

	srv := admin.NewServer(cfg.Admin, db, log, admin.WebFS())
	adminErrCh, err := srv.Start()
	if err != nil {
		log.Error("Админ-панель не смогла открыть порт", "err", err)
		os.Exit(1)
	}
	log.Info("admin Готово", "addr", srv.Addr())
	obs.SetReady(true)

	// 在线会话数：读共享 KV（gameserver 每 5s 刷新）
	go func() {
		for {
			if n, ok, _ := db.KVGet(ctx, "stats:sessions"); ok {
				var v int64
				fmt.Sscanf(n, "%d", &v)
				srv.SetSessionCount(v)
			}
			time.Sleep(5 * time.Second)
		}
	}()

	select {
	case <-ctx.Done():
	case err := <-obsErrCh:
		log.Error("Порт наблюдения неожиданно завершился", "err", err)
	case err := <-adminErrCh:
		log.Error("Админ-панель неожиданно завершилась", "err", err)
	}

	obs.SetReady(false)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	_ = obs.Shutdown(shutdownCtx)
	db.Close()
	log.Info("admin Завершено")
}

func splitColon(s string) (string, string, bool) {
	for i := 0; i < len(s); i++ {
		if s[i] == ':' {
			return s[:i], s[i+1:], true
		}
	}
	return "", "", false
}
