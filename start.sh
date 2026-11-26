#!/bin/sh
set -eu

fail() {
    echo "[ERROR] $*" >&2
    exit 1
}

require_env() {
    eval "value=\${$1:-}"
    [ -n "$value" ] || fail "Переменная окружения $1 не задана или пуста"
}

require_env RF4_GATEWAY_ADVERTISE_HOST
require_env RF4_ADMIN_PASSWORD
require_env RF4_ADMIN_JWT_SECRET
require_env RF4_TUNNEL_PSK
require_env RF4_GAME_TUNNEL_PSK

if [ "$RF4_TUNNEL_PSK" != "$RF4_GAME_TUNNEL_PSK" ]; then
    fail "RF4_TUNNEL_PSK и RF4_GAME_TUNNEL_PSK должны совпадать"
fi

if ! printf '%s\n' "$RF4_GATEWAY_ADVERTISE_HOST" | awk -F. '
  NF != 4 { exit 1 }
  { for (i = 1; i <= NF; i++) if ($i !~ /^(0|[1-9][0-9]{0,2})$/ || $i + 0 > 255) exit 1 }
'; then
    fail "RF4_GATEWAY_ADVERTISE_HOST='$RF4_GATEWAY_ADVERTISE_HOST' — недопустимый IPv4"
fi

CONFIG=/app/config.yaml
[ -f "$CONFIG" ] || fail "$CONFIG не существует"

PID_GS=
PID_GW=
PID_ADM=

cleanup() {
    status=${1:-0}
    echo "Получен сигнал остановки, корректно завершаем все сервисы..."
    for pid in "$PID_GS" "$PID_GW" "$PID_ADM"; do
        if [ -n "$pid" ]; then
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done
    for pid in "$PID_GS" "$PID_GW" "$PID_ADM"; do
        if [ -n "$pid" ]; then
            wait "$pid" 2>/dev/null || true
        fi
    done
    echo "Все сервисы безопасно остановлены."
    exit "$status"
}
trap 'cleanup 143' TERM
trap 'cleanup 130' INT

echo "=== RF4 server starting ==="
echo "Working dir: $(pwd)"
echo "Config file: $CONFIG"

echo "Initializing database..."
/app/seed --config "$CONFIG"

echo "Starting gameserver..."
/app/gameserver --config "$CONFIG" &
PID_GS=$!

echo "Waiting for gameserver tunnel 9401..."
RETRIES=40
while [ "$RETRIES" -gt 0 ]; do
    if nc -z 127.0.0.1 9401 2>/dev/null; then
        echo "gameserver tunnel 9401 is ready"
        break
    fi
    RETRIES=$((RETRIES - 1))
    [ "$RETRIES" -gt 0 ] || fail "gameserver не запустился вовремя или порт 9401 не готов"
    sleep 0.5
done

echo "Starting gateway..."
/app/gateway --config "$CONFIG" &
PID_GW=$!

echo "Starting admin..."
/app/admin --config "$CONFIG" &
PID_ADM=$!

echo "All services started, waiting..."
wait_status=0
wait -n || wait_status=$?
echo "[ERROR] Один из сервисов завершился, останавливаем контейнер..."
cleanup "$wait_status"
