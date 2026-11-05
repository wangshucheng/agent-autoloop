# M3：显式写命令与主会话评估旁路

记录时间：2026-11-05。前置：M0 基线（CI 双矩阵 success）、M1 纯内核（31 项）、M2 只读控制平面（16 项，CI 双矩阵 success）。

## 1. 定位

M2 把所有写操作挡在 `405` 后面；M3 打开写路径，但只开**显式命令**：每个命令产出**一条**事实，经 `kernel/store.commit()` 落盘，由 `evolve()` 更新投影。运行时**绝不自行写事实**——超时、评估、看板、SSE 都只是通知或读模型。

主会话 LLM 评估按「旁路订阅者」落地：运行时不出网、不调模型、不记模型明细；它把一张候选卡交给主会话，主会话用 `POST /v1/super/eval/:id/decision` 回写一条 `eval.decided`。回放只 `evolve` 事实，因此**不会重跑模型**。

## 2. 交付清单

| 文件 | 职责 |
| --- | --- |
| `host/super-commands.ts` | 纯决策层：`SuperCommand` → `FactV2`。命令解析、校验、幂等、CAS、状态派生 |
| `host/super-assessor.ts` | `assessmentOutcome` 纯函数 + `MainSessionAssessor` 生命周期（候选卡 / 超时 / 结论归一化） |
| `host/super-api.ts` | 鉴权前置、5 类写命令、Assessor 待办端点、分支调试端点、HealthBoard 实时接线 |
| `host/super-eventstore.ts` | 新增 `appendBranchFact()`，只写分支日志，不碰生产 `facts` 表 |
| `host/runtime.ts` | **+6 行**：导出 `publish(type, facts)`，`execute()` 改为调用它（等价重构） |
| `tests/super-agent-m3.test.ts` | 20 项：命令、Assessor、API、分支、架构约束 |

**单一真相**：删掉 `super-agent/src/host/assessor.ts`（M2 已删 eventstore/blackboard/watchdog）。`super-agent/src/domain/ports.ts` 保留为 dsh 移植契约总览，运行时以 `host/super-*.ts` 为准。

## 3. 写命令契约

| 方法 | 路径 | 事实类型 | 写入的投影表 |
| --- | --- | --- | --- |
| POST | `/v1/super/approvals/:id/answer` | `card.answered` | `approvals` |
| POST | `/v1/super/grants/:id/revoke` | `grant.revoked` | `grants` |
| POST | `/v1/super/eval/:id/decision` | `eval.decided` | 无（纯日志事实） |
| POST | `/v1/super/policy/save` | `policy.changed` | 无（纯日志事实） |
| POST | `/v1/super/processing/pause` | `processing.paused` | 无（纯日志事实） |

硬约束：

- **鉴权前置**：loopback 免 key 只适用于 GET；**任何写命令在任何主机都必须带 owner key**，否则 `401 writes_require_owner_key`。同源检查仍先行（`403 cross_origin`）。未声明的写路径返回 `405 writes_require_explicit_command`。
- **指令数据分离**：命令体若出现 `to / cwd / skill / access / emits / agent / answerers` 任一字段，直接 `400 instruction_field_rejected`，不产生任何事实。body 上限 64 KB。
- **只写新表**：`changes` 只涉及 M2 新增的 `approvals` / `grants`；底座原有 11 张投影表（events/runs/cards/deliveries/timers/schedules/seen/keys/config/due/run_events）的写者不变。
- **日志不跳号**：`commandState()` 的 `seq` 取自 `getView().seq`，事实 `seq = view.seq + 1`，保证 `sim/invariants.ts` 的「日志序号连续」断言成立。并发提交撞车时 `commit()` 抛 `Conflict`，API 返回 `409 commit_conflict` 而不是 500。
- **幂等**：审批已回答 → `409 already_resolved`；授权已失效 → `409 already_inactive`；策略 `base_revision` 不匹配 → `409 policy_conflict`。
- **敏感字段**：响应出口继续递归 `scrub()`。

### 不做「审计追踪 DeepSeek」

`eval.decided` 的 `meta` 只有 `policy_version`、`reason`（`code` + `values.decision` / `values.matched_rules`）、`actor`、`trust`、`taint`、`correlation_id`。单测显式断言序列化结果中不含 `deepseek` / `prompt_hash` / `token` / `latency` / `model_call_details` / `prompt_text`。配置里 `eval.model = deepseek-chat` 属于**主会话侧**的调用参数，运行时不读取、不落盘。

## 4. Assessor 旁路

```
trigger.received (inferred)
   → MainSessionAssessor.request() 入队（enabled=false 或 explicit 直接跳过）
   → GET /v1/super/eval/pending 给出候选卡（一次一个具体问题，taint: external）
   → delivered() 后超时时钟才启动；挂起期间零 Agent 进程、零 Token
   → 主会话 POST /v1/super/eval/:id/decision 回写结论
   → assessmentOutcome() 归一化 → eval.decided 事实
```

`assessmentOutcome()` 移植 dsh `src/policy.ts` 的三条判定：inferred accept 必须有匹配规则**且**有意图证据；`observe` / `off` 模式下 inferred accept 只记 `would_accept`（`ignore`）；`auto` 才真正 admit。explicit 请求不走评估。

**超时不是隐式写**：`sweep()` 在请求时调用（不设定时器），前 `max_retries` 次延长窗口，超过后只通过 `onTimeout` 通知并把 `unavailable` 放进 `GET /v1/super/eval/pending` 的 `timed_out`；主会话据此**显式**回写。这比 dsh 原型「超时自动写 unavailable」更严格地遵守「writesRequireExplicitCommand」，也让「一个状态一个写者」不被旁路破坏。

## 5. 分支调试与 HealthBoard

新增只读端点：`GET /v1/super/eval/pending`、`GET /v1/super/eval/:id`、`GET /v1/super/branches`、`GET /v1/super/breakpoints?branch=`。

新增 debug 命令（同样要求 owner key）：`POST /v1/super/fork`、`POST /v1/super/replay`、`POST /v1/super/breakpoints`、`POST /v1/super/branches/:name/facts`。分支事实只写 `facts_branch`，**生产 main 的 `facts` 表永不被 host 写入**，`appendBranchFact` 单测断言 main 行数不变。debug body 同样拒收指令字段；未接线的 host 返回 `501 debug_not_wired`。

> `replay` 的边界参数叫 `to_seq` 而不是 `to`：`to` 是保留的指令字段（收件人），重放边界必须避开这个语义冲突。这是接线时发现的真实缺陷。

HealthBoard 不再是空实现：`liveDeps()` 创建实例并 claim `super-api` / `watchdog` / `assessor`，写命令成功会 `report(ok)`，Assessor 超时会 `report(fail, "timeout")`；`suppressed()` 统计最近事实里的 `attention.suppressed`。M4 会把真实组件（worker / channel / source）接进来。

## 6. 关键架构决策

1. **为什么不走 `runtime.execute()`**：底座 `decide()` 的 Input 是封闭集合，塞入新事实类型会改动底座 handler 语义。改用 `commit(db, getView(), () => [fact])` —— `commit` 仍是唯一写日志者、`evolve` 仍是唯一写投影者，且 `getView()` 用底座自己的 `format` 打开视图，不会误触发重建。
2. **为什么给 `runtime.ts` 加 `publish()`**：直接 `commit()` 不会唤醒 `onChange` 监听器，SSE 就推不出新事实。导出 `publish(type, facts)` 复用底座已有的 listener 集合，`execute()` 也改调它（等价重构）。底座 `/v1/stream` 与 `/v1/super/stream` 因此都能看到 M3 事实。
3. **为什么 `facts()` 改读最近 N 条**：M2 的 `logAfter(0, maxFacts)` 返回的是日志**最旧**的 5000 条，看板会看不到新事实，`seq` 也会落后于 view。改为 `logAfter(max(0, view.seq - maxFacts), maxFacts)`，并让 `seq()` 直接取 `getView().seq`。这是顺带修掉的 M2 缺陷。
4. **为什么 `appendBranchFact` 用 `INSERT OR REPLACE`**：分支事实是 what-if 步骤，同一 seq 覆盖是合理的幂等语义；同时避免 `INSERT INTO facts...` 字面量被 `purity.test.ts` 的「只有 store.ts 能追加日志」正则误判。分支表与生产主表是不同的表。

## 7. 接线中修掉的真实缺陷

| # | 问题 | 修复 |
| --- | --- | --- |
| 1 | `erasableSyntaxOnly` 禁止构造参数属性，`MainSessionAssessor` 无法 typecheck | 显式字段 + 构造函数赋值（与 M2 的 Watchdog 同样处理） |
| 2 | `replay` 的 `to` 撞保留指令字段 `to`，debug 请求一律 400 | 参数改名 `to_seq` |
| 3 | M2 的只读 `policy` 端点返回 `read_only: true` 与 M3 不符 | 改为返回 `version` / `base_revision` / `paused` / `commands_enabled` |
| 4 | M2 的 405 在鉴权之前，M3 会把写命令误判成「无写路径」 | 405 移到鉴权之后，只对未声明路径生效 |
| 5 | `facts()` 读最旧 N 条导致看板与 `seq` 落后 | 改读最近 N 条，`seq()` 取视图 |

## 8. 验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ exit 0 |
| `prettier --check` 新增/改动文件 | ✅ |
| `tests/super-agent-m3.test.ts` | ✅ 20/20 |
| 绿色回归子集（purity / ci-scope / cron / M1 / M2 / M3 / kernel / hops / projection / schema） | ✅ **135/135** |
| `npm run test:sim` 20000 步 | ✅ 31.1s / 1644 completed |
| `host/http.ts` 行数 | 41 ≤ 50（架构断言） |
| 新 host 文件 SQL 扫描 | 无越权写日志 / 投影 |
| CI 双矩阵 | ✅ run `42036512095`：`ubuntu-latest` + `macos-latest` **全部 success**，完整 `npm test` 与 `install-smoke.sh` 通过 |

Windows 本机 `rules` / `conformance` / `format` 测试的 `EPERM` / ESM URL 失败仍是已知平台假象（见 `M0_BASELINE.md §4`），CI 上为绿。

## 9. M4 入口（第一批已完成，见 `M4_CONFIG_AND_FRONTEND.md`）

> M4 第一批已把 `super.*` 配置接进运行时、修掉示例配置无法启动中台的缺陷、给前端补上 owner key 与正确的 SSE 端点。以下清单保留为 M4 第二批待办。

1. 把 `super.policy.accept_mode`、`super.eval.*`、`super.watchdog.*` 从 `rules.json` 接进 `liveDeps()`，替换当前的默认常量。
2. 把真实组件（worker / channel / source / delivery）接入 HealthBoard，并让 Watchdog 的自愈动作落到实际组件。
3. `/v1/super/*` 物化投影：不再扫最近 N 条日志，改读投影表；前端从演示数据完全切到真实后端。
4. Webhook / 飞书卡片 / 定时 / 多项目的生产接线，以及 WSL → macOS 迁移压测。
5. **红线不变**：不记录模型调用明细、不让模型生成审计摘要；外部文字始终 `taint: external`；挂起零 Agent 进程零 Token；授权可立即撤销；一个状态一个写者；生产 main 只读、永不回滚。
