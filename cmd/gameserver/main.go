// gameserver —— 主服务器（游戏逻辑）进程。
//
// 职责：隧道服务端、会话核、RPC 处理器和运行时存储。
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"rf4server/internal/buildinfo"
	"rf4server/internal/config"
	"rf4server/internal/gameserver"
	"rf4server/internal/logging"
	"rf4server/internal/metrics"
	"rf4server/internal/store"
)

func main() {
	configPath := flag.String("config", "config.yaml", "Путь к файлу конфигурации")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "gameserver:", err)
		os.Exit(2)
	}
	log := logging.New(cfg.Log.Level, cfg.Log.Format)
	log.Info("gameserver Запуск",
		"version", buildinfo.Version, "commit", buildinfo.GitCommit,
		"env", cfg.Env, "tunnel", cfg.Game.Tunnel.Addr)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	obs := metrics.NewServer(cfg.Game.ObsAddr, "gameserver")
	obsErrCh := obs.Start()

	srv := gameserver.NewServer(cfg.Game, log, obs)
	// 共享 SQLite（fail-fast）
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
	srv.SetDB(db)
	log.Info("SQLite Подключено", "path", cfg.SQLite.Path, "static", cfg.SQLite.StaticPath)
	if n, err := srv.SyncHookBiteProfiles(ctx); err != nil {
		log.Warn("Не удалось инициализировать профили засечки крючков", "profiles", n, "err", err)
	} else {
		log.Info("Профили засечки крючков синхронизированы", "profiles", n)
	}
	if err := srv.RepairItemPhysics(ctx); err != nil {
		log.Error("Не удалось исправить физическое состояние предметов", "err", err)
		os.Exit(1)
	}
	if n, err := srv.BackfillRigProjections(ctx); err != nil {
		log.Warn("Не удалось заполнить проекцию оснасток", "rods", n, "err", err)
	} else {
		log.Info("Проекция оснасток заполнена", "rods", n)
	}
	if n, err := srv.RecoverStorePurchases(ctx); err != nil {
		log.Warn("Не удалось восстановить старые квитанции покупок", "restored", n, "err", err)
	} else {
		log.Info("Старые квитанции покупок восстановлены", "restored", n)
	}
	if n, err := srv.ConsolidateNonReturnableItemStacks(ctx); err != nil {
		log.Warn("Не удалось упорядочить старые стопки предметов, изменения откатаны", "removed", n, "err", err)
	} else if n > 0 {
		log.Info("Старые стопки предметов упорядочены", "duplicates_removed", n)
	}
	if n, path, err := srv.LoadCompatTable(); err != nil {
		log.Info("Таблица совместимости мастерской не загружена", "err", err)
	} else {
		log.Info("Таблица совместимости мастерской загружена", "alternatives", n, "path", path)
	}
	if n, err := srv.RepairReelComponents(ctx); err != nil {
		log.Warn("Не удалось пересобрать детали катушек", "reels", n, "err", err)
	} else {
		log.Info("Детали катушек пересобраны", "reels", n)
	}
	if n, err := srv.RepairReelEnginePower(ctx); err != nil {
		log.Warn("Не удалось дописать параметры моторов катушек", "reels", n, "err", err)
	} else if n > 0 {
		log.Info("Параметры моторов катушек дописаны", "reels", n)
	}
	if n, err := srv.RebuildReelPerformance(ctx); err != nil {
		log.Warn("Не удалось пересобрать физические параметры катушек", "reels", n, "err", err)
	} else {
		log.Info("Физические параметры катушек синхронизированы", "reels", n)
	}

	ln, err := net.Listen("tcp", cfg.Game.Tunnel.Addr)
	if err != nil {
		log.Error("Туннель не смог открыть порт", "addr", cfg.Game.Tunnel.Addr, "err", err)
		os.Exit(1)
	}
	srvErrCh := make(chan error, 1)
	go func() { srvErrCh <- srv.Serve(ln) }()

	// 管理指令订阅（共享 SQLite 队列）+ 在线会话统计键（共享 KV）
	srvStop := make(chan struct{})
	srv.StartAdminSubscriber(db, srvStop)
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				close(srvStop)
				// 停服即清空在线名单，避免管理后台继续显示已下线的玩家。
				_ = db.KVSet(context.Background(), "stats:online_uids", "")
				return
			case <-t.C:
				_ = db.KVSet(ctx, "stats:sessions", fmt.Sprintf("%d", srv.SessionCount()))
				_ = db.KVSet(ctx, "stats:online_uids", onlineUIDsValue(srv))
			}
		}
	}()

	log.Info("gameserver Готово, ожидание подключения шлюза")
	obs.SetReady(true)

	select {
	case <-ctx.Done():
	case err := <-obsErrCh:
		log.Error("Порт наблюдения неожиданно завершился", "err", err)
	case err := <-srvErrCh:
		log.Error("Сервис туннеля неожиданно завершился", "err", err)
	}

	obs.SetReady(false)
	srv.CloseAll()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = obs.Shutdown(shutdownCtx)
	log.Info("gameserver Завершено")
}

// onlineUIDsSnapshot 是 stats:online_uids 的带发布时间快照。时间戳和管理端
// 共同提供过期保护，避免 gameserver 异常退出后陈旧名单长期显示在线。
type onlineUIDsSnapshot struct {
	UpdatedAt int64   `json:"updated_at"`
	UIDs      []int64 `json:"uids"`
}

func onlineUIDsValue(srv *gameserver.Server) string {
	data, err := json.Marshal(onlineUIDsSnapshot{
		UpdatedAt: time.Now().Unix(),
		UIDs:      srv.OnlineUIDs(),
	})
	if err != nil {
		return ""
	}
	return string(data)
}
