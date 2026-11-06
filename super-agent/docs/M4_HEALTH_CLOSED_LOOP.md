# M4 第二批 · 第 1 项：组件主动上报 + 自愈动作接口（可测闭环）

记录时间：2026-11-05。前置：M4 第一批（`d4e0373`，CI run `42041668335` 双矩阵 success）。

## 1. 目标与边界

把「真实组件接 HealthBoard / Watchdog 自愈」做成**不依赖任何外部系统**的可测闭环：

```
组件 POST /v1/super/health/report
   -> HealthPlane.report()            （一条目一写者，首次上报自动注册）
   -> HealthBoard.report()            （累计失败、状态 ok/degraded/failing）
   -> Watchdog.evaluate()             （L0–L4 自愈阶梯，预算与去重）
   -> HealingActor.apply()            （唯一扩展点，默认只记录）
   -> HealthPlane 动作日志 / L4 卡    （读模型）
   -> 组件再上报 ok:true              -> 状态恢复，动作停止
```

**边界**：`InMemoryHealingActor` 不重启进程、不访问网络、不碰文件系统；健康是**运行时状态，不是事实**——瞬时错误绝不进入 append-only 日志，也不占用人的版面。生产要真正重启 worker，只需注入另一个 `HealingActor` 实现，本模块与 API 一行都不用改。

## 2. 交付清单

| 文件 | 职责 |
| --- | --- |
| `host/super-health.ts` | `HealthPlane`、`HealingActor` 接口、`InMemoryHealingActor`、动作/卡片记录、状态派生 |
| `host/super-api.ts` | 2 个写端点 + 2 个读端点；`liveDeps()` 用 `HealthPlane` 替换裸 `HealthBoard`；overview 透传 L4 卡 |
| `host/super-blackboard.ts` | `Overview.health` 增可选 `cards`，`overviewOf` 接受 `health_cards` |
| `super-agent/web/app.js` | 健康面板（默认折叠）显示 L4 待处理卡与已抑制瞬时错误数 |
| `super-agent/config/super.example.json` | `web.health_components` 列出 7 个组件示例 |
| `tests/super-agent-m4-health.test.ts` | 14 项：纯闭环 + API 闭环 |

## 3. `HealingActor`：唯一的外部系统扩展点

```ts
export interface HealingActor {
  apply(action: HealingAction, entry: HealthEntry, now: number): void;
}
```

`HealingAction` 来自 M2 的 Watchdog：`retry / restart / rebuild_projection / pause_processing / disable_component / notify_once`，带 `level`、`delay_ms`、可选 `card`。默认实现：

```ts
export class InMemoryHealingActor implements HealingActor {
  readonly applied: Array<{ at: number; action: HealingAction }> = [];
  apply(action, _entry, now) { this.applied.push({ at: now, action }); }
}
```

生产实现示例（**不在本仓库落地，避免伪实现**）：

```ts
class ProcessHealingActor implements HealingActor {
  apply(action: HealingAction, entry: HealthEntry, now: number): void {
    if (action.action === "restart") workerSupervisor.restart(entry.name, action.delay_ms);
    if (action.action === "rebuild_projection") store.rebuild(db);
    if (action.action === "disable_component") sourceRegistry.disable(entry.name);
    // notify_once 仍由卡片通道处理，不在这里发消息
  }
}
```

注入点：`new HealthPlane({ components, policy, now, actor })`。单测用自定义 `RecordingActor` 验证了可替换性。

## 4. API 契约

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/super/health/report` | body `{component, owner, ok, code?}`；返回 `{entry, actions, status, suppressed}` |
| POST | `/v1/super/health/check` | 显式对全部非 ok 条目评估一次，返回 `{actions, entries, status, suppressed}` |
| GET | `/v1/super/health` | `status / entries / suppressed / transient_absorbed / actions / cards` |
| GET | `/v1/super/health/actions` | 动作日志 + L4 卡 + 已吸收瞬时错误数 |

约束：

- **鉴权与 M3 一致**：两个 POST 都要 owner key（包括 loopback），否则 `401 writes_require_owner_key`；未接线返回 `501 health_not_wired`。
- **指令数据分离**：body 出现 `to / cwd / skill / access / emits / agent / answerers` 任一字段 → `400 instruction_field_rejected`。组件名用 `component` 而不是 `agent`，正是为了避开保留字段。
- **一条目一写者**：首次上报自动 `claim(component, owner)`；之后 owner 不符 → `409 health_owner_mismatch`。
- **不写事实**：单测把 `writeFact` 设为计数桩，断言一次健康上报后计数为 0。
- **请求驱动**：`evaluateAll()` 只在 `POST /health/check` 时调用，不设定时器；挂起期间零进程、零 Token。每次评估会消耗一次重启预算，不要高频调用。

## 5. 自愈阶梯在这个闭环里的实测序列

用 `restart_budget=2`、`max_auto_escalations=1`、`transient_failure_threshold=3` 的策略连续上报 7 次失败：

| 第 N 次 | 累计失败 | 动作 | 级别 |
| --- | --- | --- | --- |
| 1–2 | 1–2 | `retry`（指数退避） | L0 |
| 3–4 | 3–4 | `restart` | L1 |
| 5 | 5 | `pause_processing` | L3 |
| 6 | 6 | `notify_once`（一张卡） | L4 |
| 7 | 7 | 无动作（同一根因已发过卡） | — |

`format_fingerprint_mismatch` 会在达到阈值时直接走 L2 `rebuild_projection`，不消耗重启预算。L0 吸收的次数记为 `suppressed()`——**一个数字，不是一串错误**；它同时进入 `overview.health.suppressed` 与前端健康面板。上报 `ok:true` 后状态回 `ok`、错误码清空、后续评估不再产生动作。

## 6. 配置与前端

`super.json` 的 `web.health_components` 决定初始 claim 的组件（示例 7 个：`super-api / watchdog / assessor / worker / channel / source:github / delivery`），未列出的组件仍可通过首次上报自动注册。策略阈值来自 `watchdog` 段。super 平面自身的 `assessor` 超时、`super-api` 命令成功也走同一个 `report()` 闭环。

L4 卡经 `overview.health.cards` 透传到前端健康面板（**默认折叠**），标题显示为「组件 X 需要你处理」，并标 `L4`；卡片 key 做过转义与截断。演示数据没有 `cards` 字段，行为保持不变。

## 7. 验证

| 检查 | 结果 |
| --- | --- |
| `tests/super-agent-m4-health.test.ts` | ✅ 14/14 |
| 合并绿色回归子集（purity / ci-scope / cron / M1 / M2 / M3 / M4 / health / kernel / hops / projection / schema） | ✅ **159/159** |
| `npm run typecheck` | ✅ exit 0 |
| `prettier --check` 新增/改动文件 | ✅ |
| `node --check` 前端 app.js / mock.js | ✅ |
| `host/http.ts` 行数 | 41 ≤ 50 |
| CI 双矩阵 | ✅ run `42044645583`：`ubuntu-latest` + `macos-latest` **全部 success** |

## 8. M4 第二批进度

1. ✅ **组件主动上报 + 自愈动作接口**（本文档）。
2. ✅ **看板物化投影**：`overview` / `blackboard` 改读 `board_items` 投影表，见 `M4_MATERIALIZED_PROJECTION.md`；`trace` / `attention` / `projects` 仍是事实派生读模型。
3. Webhook / 飞书卡片 / 定时 / 多项目生产接线——需要真实凭据、回调地址与飞书应用配置。
4. WSL → macOS 迁移压测——本机 `wsl.exe` 被安全策略禁止，需解禁或在 macOS 执行 `deploy/com.superagent.runtime.plist`。

红线不变：不记录模型调用明细、不让模型生成审计摘要；外部文字始终 `taint: external`；挂起零 Agent 进程零 Token；授权可立即撤销；一个状态一个写者；生产 main 只读、永不回滚。
