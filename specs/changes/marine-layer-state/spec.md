# 海钓水层状态机与官方鱼汛第六开关

Status: in-progress

## Problem Statement

海钓 rig 50~60 的水层目前来自两条旧路径：50~54 使用 14/7 动作位推导的 `LureLayer`，
55~60 固定 0.93。深水点位（例如 180m 需要接近 60 秒下沉）时，`LureLayer` 约 3~9 秒
就到顶，服务端会过早按中层/贴底判鱼，玩家体感是“饵还没到底就被中上层鱼抢先接口”。

## Solution

新增 `marine_layer_enabled`（海钓水层影响，默认关），作为官方鱼汛第六个开关。
开启后，海钓 50~60 的水层改由海钓状态机输出唯一权威值：

- 起点 0.05，贴底 0.93（贴底活动层，不是 1.0 水底）；
- 下沉按 `marine_descent_seconds` 相对时长线性过渡；
- 14/7 的触底/离底事件 clamp 或切换状态；
- 循环收放线从当前层继续，不回到水面。

关闭时完全回退旧行为：50~54 用 `effectiveLureLayer`，55~60 用 0.93。其它钓法不变。

## User Stories

1. 作为海钓玩家，我希望铁板/沉底下沉期间先经过中上层、接近到底才进入底层鱼候选，
   而不是抛竿几秒内就被中上层鱼截口。
2. 边界：到底后继续收线，层数应逐级离开底层；再次放线时从当前层继续，不重置到水面。
3. 边界：客户端只发 `0x0` 或漏发 `0x8` 时，不应一帧就判离底；宽限后仍可恢复。
4. 边界：关闭 `marine_layer_enabled` 后，海钓与改动前逐位一致；旧库五开升级显示 mixed。

## Implementation Decisions

- 新增 `internal/gameserver/marine_layer.go`：状态、事件去抖、相对时长过渡、日志字段。
- `FishState` 增加仅进程内的 Marine 字段，不持久化；14/1 抛竿、收杆、剪线、移除装备、
  换饵等入口调用 `resetMarineLayerLocked`。
- `fishRollContext` 增加 `marineLayer` / `marineLayerKnown`；生产路径由
  `marineContextLayer` 填充，查鱼助手/声呐没有 14/7 序列时 `known=false`，回退旧口径。
- `rigWaterLayer`、`fishWaterConditionsFor`、`fishLureWeight`、`marineDepthMatch` 统一读取
  状态机层；`fishBiteEnvironmentWeight`、`applyBiteGates`、`groundbaitGates` 自动跟随。
- `store.biteModeKeys` 增加 `marine_layer_enabled`；官方鱼汛 realistic 六开、legacy 六关；
  旧库只有前五键为 `1` 时 `BiteModeFor` 返回 mixed，不自动开启新行为。
- 新增 tunables：`marine_layer_enabled`、`marine_descent_seconds`、
  `marine_descent_seconds_pilker`、`marine_descent_seconds_jig`、
  `marine_descent_seconds_bottom`。默认值 0/60/60/50/45。
- 学习固定开启，不提供单独后台开关；旧库残留 `marine_layer_learn_enabled` 不再读取。
  学习只存内存：`loc12_N + 钓组类别` 为 key，触底事件反推满程时长，EMA 平滑；
  中途收线/上升、从中层放线或样本不足时回退默认。
- 不引入总水深、物理阻力模型或客户端新协议字段；`DiveDepth` 不再是海钓水层起点。

## Testing Decisions

- 单元：`marine_layer_test.go` 覆盖下沉时间线、触底、循环收放线、收线离底宽限、
  `0x0` 宽限、关闭开关、55~60 时长、`rigWaterLayer` 回退、按区号/钓组学习、
  中途收线不学习、从中层放线不学习、旧学习开关残留不影响。
- 管理端：`bite_mode_test.go` 验证 realistic 六开；`store/bite_mode_test.go` 验证
  realistic/legacy/mixed 与旧库五开升级。
- 回滚：关闭 `marine_layer_enabled` 后，`rigWaterLayer` 应回到旧分支；相关单测仍应通过。
- 本机没有 Go 工具链，本次未执行 `go test` / `go vet` / `go build`；合并前必须在有 Go
  的环境补跑。

## Out of Scope

- 点位总水深、逐点深度网格、物理下沉速率/阻力模型。
- 14/7 是否上报深度字段的探测与接入。
- 多钩逐钩独立水层；14/7 是整杆动作位，本版整杆共用一个状态机层。
- 55~60 下沉期是否稳定上报 `0x80000/0x800000` 的实机抓包确认。

## Further Notes

- `[事实]` 现有 50~54 走 `effectiveLureLayer`，55~60 在 `rigWaterLayer` 返回 0.93；
  14/7 的 `0x80000` 每 1.5 秒才推进一步，180m/60s 场景会明显提前到顶。
- `[假设]` `marine_descent_seconds` 的 60/50/45 是首版相对时长，不是物理标定值；
  需要按海图/饵型实机观察后调整。
- `[未验证]` 55~60 下沉期 14/7 位序列尚未抓包；若只有 `0x0`，状态机将依赖相对时长推进。
