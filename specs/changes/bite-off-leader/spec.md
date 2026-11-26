# 咬断线组（掠食鱼咬断引线）

Status: done

## Problem Statement

少数掠食鱼在搏鱼时能把引线/子线咬断，这与「张力超过承力」的常规断线是**两条独立通路**：
常规断线由鱼拉力与部件承力比较触发，咬断由鱼种 + 鱼重 vs 引线承载 + 冲刺次数决定。
即使钓组远强于这条鱼，狗鱼照样能咬断。

当前服务端只有常规断线通路。客户端自己有一条「鱼把组磨断」的本地判定
（`FishingSet.cs:1716-1758`，见 `docs/analysis-client-line-break-detection-2026-11-12.md:70`），
但官方规则里的**按鱼种 20%/4% 的概率咬断**没有任何一端实现——服务端 `escapeTemplateKind`
里保留了 `10 = 牙齿咬断钓组` 的原因码，却没有产生它的地方。

数据来源：issue #153 提供的官方规则整理（wiki + 游戏内可观察信息）：

```
◆ 咬断线组的鱼：常见狗鱼、哲罗鱼、鳄雀鳝/斑点雀鳝、鼠鲨
鱼重 ＞ 引线承载重量 → 每次冲刺 20% 概率咬断线组
鱼重 ＜ 引线承载重量 → 每次冲刺  4% 概率咬断线组
（其余鱼种均无法咬断线组）
```

## Solution

新增 `internal/gameserver/bite_off.go`，在 14/8 遥测到达时判定：

1. **鱼种白名单** `bite_off_species`，默认 `n.pike,taimen,agar,sgar,lamna_n`
   （常见狗鱼 / 哲罗鱼 / 鳄雀鳝 / 斑点雀鳝 / 鼠鲨）。空串关闭整层。
2. **概率** 由 `biteOffChance` 纯函数给出：`鱼重/1000 > 引线承载` 取
   `bite_off_over_pct`（默认 20），否则取 `bite_off_under_pct`（默认 4）。
3. **冲刺信号** 用 14/8 的鱼剩余体力比（偏移 45）反推：休息机动的消耗趋近 0，
   挣扎时持续下降，**距上次掷骰的累计降幅 ≥ `bite_off_min_stamina_drop` 就算在冲刺**。
   单帧降幅不能作判据：一条 14/8 约 2 秒，实测单帧常只有 0.0008，比默认门槛还小，
   按相邻两帧比较会让低门槛鱼种永远掷不了骰。掷骰或重置时累计值清零。
4. **判定节流** `bite_off_sprint_seconds`（默认 10 秒）限制掷骰频率；节流窗口内的
   降幅继续累加，不丢样。`FishState` 记录这份基线属于哪一尾鱼（`biteOffFishGUID`），
   换鱼整体重置，新鱼不继承上一尾鱼的掷骰时刻与体力基准。
5. **断件** 复用既有事务，与 17/9 完全同口径：
   - 断了引线/前导线/铅芯前导 → `breakLineTxWithLineOut`，按
     `downstreamLossCategories` 一并删除下游钩、饵、拟饵，写
     `line_break` / `lost_on_line_break` 日志。**断件品类取实例真实品类**
     （钢丝前导是 15，不是 13），否则前导线自己不在下游集合里、断完还挂在竿上。
   - 没有引线/铅芯时，承力比较值退到主线 `LineStrengthKg`，走 `breakLineTx`（主线）。
6. **跑鱼原因** 用独立原因码 `牙齿咬断钓组`（`escapeTemplateKind` → 10），
   不复用张力断线的 `断子线`(30) / `断主线`(6)：客户端按原因码换文案。

### 为什么用体力降幅近似「冲刺」

客户端把机动调度完全跑在本地（`docs/analysis-bite-hook-fight-line-break-2026-11-12.md:41`
`dnblinaache` 每帧 Update、`llkfcijmgfd` 按权重挑下一个机动），服务端**收不到冲刺事件**。
14/8 是唯一的搏鱼期上行遥测，其字段里：

- 偏移 45（`.1.4`）鱼剩余体力比 0~1，每尾新鱼重置 1.0，长时间搏鱼单调下降
- 偏移 49（`.1.5`）钓组最弱环强度 kgf

这两项已有实机抓包标定（82 帧 / 144 帧，见 `gear_assistant_stamina.go:66`）。
官方文档确认「扣体力的不是冲刺事件而是受阻程度——被线拉住想跑跑不动时扣最多；
休息机动只是让消耗趋近 0」（`docs/analysis-fish-fight-physics-2026-11-07.md:112`），
所以**体力下降与「鱼在挣扎」是同一件事**，用它做冲刺代理有据可依。

这是本实现唯一的非官方成分：官方「冲刺」是客户端机动事件，这里是频率近似。
调 `bite_off_sprint_seconds` 就是在调这个近似。

### 默认关闭的原因

客户端已有一条「鱼把组磨断」的本地判定。两端同时开会让咬断概率叠加，
且服务端的断件事件会与客户端本地断件竞争。需要服务端权威时必须显式打开
`bite_off_enabled=1`。

## User Stories

1. 管理员开启后，用弱引线钓狗鱼/哲罗鱼会真的被咬断，而不是只有张力断线。
2. 鱼比引线重时咬断概率高（20%），比引线轻时仍有小概率（4%）——小鱼也可能咬断细线。
3. 关闭开关后行为回到现状，只有张力过载断线。
4. 鲤鱼、鲫鱼等非掠食鱼永远不会咬断线组。
5. 没有挂引线时咬断落在主线上，钩饵一起丢。

## Implementation Decisions

- `internal/gameserver/bite_off.go`：`biteOffChance` / `biteOffSprintGate` /
  `biteOffTunables` / `biteOffSpeciesSet` 均为纯函数或只读参数，便于测试。
- `FishState` 增加三个仅进程内字段：`biteOffSeen` / `biteOffLastStamina` /
  `biteOffRollAt`，不进持久化快照。
- `hFishingLoad` 在 `recordFightReelLoad` 之后调 `maybeBiteOff`。
  两者都只读 14/8，互不影响；咬断命中会清 `Pending/Hooked/Resolved`。
- `internal/admin/api.go`：`bite_off_` 前缀参数按各自区间校验（概率 0–100、
  间隔 1–120、开关 0/1、鱼种表任意字符串）。
- 后台「玩法规则 → 其他」新增四个控件。

## Testing Decisions

- 概率：鱼重 > 承载取 20%、否则 4%；恰好相等走轻档。
- 输入不可用时一律不判：引线承力 0/负/NaN/Inf、鱼重 0、两档概率全 0。
- 越界收敛：概率 >100 钳到 100%，间隔 <1 秒钳到 1 秒，负降幅阈值归零。
- NaN 参数让整层关闭，而不是按 0 处理（避免「配了没效果」的静默失效）。
- 鱼种表：默认 5 个 key、大小写与空格归一、空项忽略、空串关闭。
- 冲刺门控：体力不变不通过、下降 0.1 通过、阈值 0 时只按时间节拍。

## Out of Scope

- 不实现客户端「挂底磨断」（`FishingSet.cs:1716-1758`）的服务端对应物。
- 不改变常规张力断线的判定（`resolveGearBreak` / `breakLineTx`）。
- 不把 14/8 的字段观测器（`fightLoadProbe`）升级成结算输入。
