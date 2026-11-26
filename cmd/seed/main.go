// seed —— 一次性初始化命令行工具（launcher 亦内置同一逻辑）。
//
// 步骤：迁移 → 静态配置导入（幂等）→ 默认档案 → 默认管理员。
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"rf4server/internal/config"
	"rf4server/internal/logging"
	"rf4server/internal/seed"
)

func main() {
	configPath := flag.String("config", "config.yaml", "Путь к файлу конфигурации")
	staticDB := flag.String("static-db", "", "Путь к статической базе (по умолчанию sqlite.static_path)")
	adminUser := flag.String("init-admin", "", "Создать администратора (действует, если таблица пуста)")
	adminPass := flag.String("init-admin-pass", "", "Пароль первого администратора (вместе с -init-admin)")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "seed:", err)
		os.Exit(2)
	}
	if *staticDB == "" {
		*staticDB = cfg.SQLite.StaticPath
	}
	sl := logging.New("info", "text")
	log := slogAdapter{sl}
	ctx := context.Background()
	res, err := seed.Ensure(ctx, cfg, *staticDB, *adminUser, *adminPass, log)
	if err != nil {
		log.Error("Ошибка инициализации: " + err.Error())
		os.Exit(1)
	}
	log.Info(fmt.Sprintf("seed Готово seeded=%v tables=%d admin_created=%v elapsed=%s",
		res.Seeded, res.Tables, res.AdminCreated, res.Elapsed.Round(time.Millisecond)))
}

// slogAdapter 把 slog.Logger 适配成 seed 包的窄日志接口。
type slogAdapter struct{ l *slog.Logger }

func (a slogAdapter) Info(m string)  { a.l.Info(m) }
func (a slogAdapter) Warn(m string)  { a.l.Warn(m) }
func (a slogAdapter) Error(m string) { a.l.Error(m) }
