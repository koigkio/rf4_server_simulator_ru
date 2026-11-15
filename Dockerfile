# ---------- 构建阶段 ----------
FROM golang:1.27.3-alpine AS builder
WORKDIR /app

# 国内 Go 模块代理，避免 go mod download 卡住
ENV GOPROXY=https://goproxy.cn,direct
ENV GOSUMDB=off

# 编译目标平台
ENV CGO_ENABLED=0
ENV GOOS=linux

# 先复制依赖清单，利用 Docker 缓存
COPY go.mod go.sum ./
RUN go mod download

# 复制全部源码
COPY . .

# 分别编译服务端各组件，不编译 Windows 专用的 launcher
RUN go build -o /app/gateway    ./cmd/gateway
RUN go build -o /app/gameserver ./cmd/gameserver
RUN go build -o /app/admin      ./cmd/admin
RUN go build -o /app/seed       ./cmd/seed

# ---------- 运行阶段 ----------
FROM alpine:latest

RUN apk --no-cache add ca-certificates tzdata netcat-openbsd

WORKDIR /app

# 复制编译好的二进制
COPY --from=builder /app/gateway    .
COPY --from=builder /app/gameserver .
COPY --from=builder /app/admin      .
COPY --from=builder /app/seed       .

# 复制配置模板并重命名为 config.yaml
COPY config.example.yaml /app/config.yaml

# 复制数据库（打进镜像，不挂载，就不会被覆盖）
COPY server_data/ /app/server_data/

# 复制启动脚本
COPY start.sh .
RUN sed -i 's/\r$//' start.sh && chmod +x start.sh

# 声明容器运行时监听的端口
EXPOSE 8080 443 9341 9501

# 设置环境变量
ENV RF4_GATEWAY_ADVERTISE_HOST=
ENV RF4_ADMIN_PASSWORD=

# 创建运行时目录（只创建需要挂载的 data 和 certs）
RUN mkdir -p /app/data /app/certs

# 声明容器中需要持久化存储的路径（只保留这两个！）
VOLUME /app/data /app/certs

ENTRYPOINT ["/bin/sh", "/app/start.sh"]