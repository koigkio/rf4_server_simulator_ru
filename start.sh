#!/bin/sh
set -e

# 1. 检查 IP 环境变量
if [ -z "${RF4_GATEWAY_ADVERTISE_HOST:-}" ]; then
  echo "[ERROR] RF4_GATEWAY_ADVERTISE_HOST 未设置或为空，请在环境变量RF4_GATEWAY_ADVERTISE_HOST中填写宿主机 IP。" >&2
  exit 1
fi

if ! printf '%s\n' "$RF4_GATEWAY_ADVERTISE_HOST" | awk -F. '
  NF != 4 { exit 1 }
  { for (i = 1; i <= NF; i++) if ($i !~ /^(0|[1-9][0-9]{0,2})$/ || $i + 0 > 255) exit 1 }
'; then
  echo "[ERROR] RF4_GATEWAY_ADVERTISE_HOST='$RF4_GATEWAY_ADVERTISE_HOST' 不是合法 IPv4，请检查环境变量RF4_GATEWAY_ADVERTISE_HOST。" >&2
  exit 1
fi
export RF4_GATEWAY_ADVERTISE_HOST

# 2. 替换密码
if [ -n "$RF4_ADMIN_PASSWORD" ]; then
    echo "检测到 RF4_ADMIN_PASSWORD 环境变量，正在更新配置文件..."
    esc=$(printf '%s' "$RF4_ADMIN_PASSWORD" | sed -e 's/[\/&|\\]/\\&/g')
    if sed -i "s|^  password: .*|  password: \"$esc\"|" /app/config.yaml 2>/dev/null; then
        echo "密码更新完毕。"
    else
        echo "警告：sed 执行失败，config.yaml 可能不可写" >&2
    fi
else
    echo "未检测到 RF4_ADMIN_PASSWORD 环境变量，使用配置文件中的默认密码。"
fi

CONFIG=/app/config.yaml

echo "=== RF4 server starting ==="
echo "Working dir: $(pwd)"
if [ -f "$CONFIG" ]; then
  echo "Config file: $CONFIG"
else
  echo "ERROR: $CONFIG not found"
  exit 1
fi

# 3. 定义优雅退出函数（捕获 SIGTERM 和 SIGINT）
cleanup() {
    echo "收到停止信号，正在优雅关闭所有服务..."
    # 向所有子进程发送 TERM 信号
    kill -TERM "$PID_GS" "$PID_GW" "$PID_ADM" 2>/dev/null || true
    # 等待它们完全退出
    wait "$PID_GS" "$PID_GW" "$PID_ADM" 2>/dev/null || true
    echo "所有服务已安全关闭。"
    exit 0
}
trap cleanup SIGTERM SIGINT

# 4. 启动 gameserver
echo "Starting gameserver..."
/app/gameserver --config "$CONFIG" &
PID_GS=$!

# 等待隧道端口就绪 (使用 timeout 兜底，防止死循环)
echo "Waiting for gameserver tunnel 9401..."
RETRIES=20
while [ $RETRIES -gt 0 ]; do
  if nc -z 127.0.0.1 9401 2>/dev/null; then
    echo "gameserver tunnel 9401 is ready"
    break
  fi
  RETRIES=$((RETRIES - 1))
  if [ $RETRIES -eq 0 ]; then
    echo "[ERROR] gameserver 启动超时或端口 9401 未就绪" >&2
    cleanup
  fi
  sleep 0.5
done

# 5. 启动 gateway
echo "Starting gateway..."
/app/gateway --config "$CONFIG" &
PID_GW=$!

# 6. 启动 admin
echo "Starting admin..."
/app/admin --config "$CONFIG" &
PID_ADM=$!

echo "All services started, waiting..."

# 7. 监控进程，如果任意一个服务挂掉，脚本退出并触发清理
wait -n
echo "[ERROR] 检测到有服务退出，正在停止容器..."
cleanup