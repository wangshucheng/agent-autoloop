# 在 fork 中的位置说明

本目录是 `super-agent-auto-loop-runtime` 的**设计与骨架暂存区**，放在 `feat/super-agent-runtime` 分支上。

## 为什么集中放在 `super-agent/`

M0/M1 阶段为了不覆盖上游 `agent-autoloop` 的任何原有文件，交付统一放在这个新增目录下。**M2 起才有三处最小增量改动**：`kernel/evolve.ts`（+5 行，追加两张投影表）、`sim/invariants.ts`（回放 oracle 共享 `TABLES`）、`host/http.ts`（+1 行挂载 super handler，41 行仍在架构测试的 50 行上限内）。每处都有回归测试守护，原有 handler 语义与 `/v1` 协议不变。详见 `docs/M2_READONLY_PLANE.md`。

| 暂存位置 | 目标位置（M1+） |
| --- | --- |
| ~~`src/kernel/*.ts`~~（M1 已落地，副本已删除） | `kernel/fact.ts` / `approval.ts` / `excitation.ts` / `grants.ts` / `five-questions.ts`；M2 再扩展 `evolve.ts` / `decide.ts` |
| `src/domain/ports.ts` | 保留为 dsh 移植契约总览；运行时以 `host/super-*.ts` 为准 |
| `src/host/{eventstore,blackboard,watchdog}.ts` | **M2 已落地**：`host/super-eventstore.ts` / `super-blackboard.ts` / `super-watchdog.ts`，副本已删除 |
| ~~`src/host/assessor.ts`~~（M3 已落地，副本已删除） | `host/super-assessor.ts`（评估旁路）+ `host/super-commands.ts`（显式写命令） |
| `src/web/api.ts` | `web/api.ts` |
| `web/index.html` 等 | `web/`（可交互前端，可直接运行） |
| `schemas/fact.schema.json` | `protocol/fact.schema.json` 或 `schemas/` |
| `config/rules.example.json` | `~/.agent-autoloop/rules.json`（**只含底座原生字段**，单测验证可被 `parseRules()` 接受） |
| `config/super.example.json` | `~/.agent-autoloop/super.json`（M4 新增，承载 `super.*` 与 bindings） |
| `deploy/` | `deploy/`（launchd / systemd 单元） |

## 本轮状态

- **已执行 fork**：`wangshucheng/agent-autoloop` 是 `KKKKhazix/agent-autoloop` 的 fork，已同步到上游最新 `main`；本分支从该 `main` 切出。
- **已交付可交互前端**：`web/index.html`，双击即可打开；后端不可达时自动切演示数据。运行方式见 `web/README.md`。
- **不做「审计追踪 DeepSeek」**：保留通用审计（因果链 / why / 回放 / fork / 断点）与主会话 LLM 评估；不记录模型调用明细、不生成模型审计摘要。见 `docs/02-事件内核-回放-fork-断点-审计.md §6.2`。
- **M0 基线已记录**：Windows 本机不作为正式基线，正式基线复用底座 CI 的 Linux + macOS 双矩阵；本机 `npm ci` / `typecheck` / 63 项纯内核回归全绿。见 `docs/M0_BASELINE.md`。
- **M1 纯内核已接线**：四个 L0 组件落到 `kernel/` 顶层，新增五问组合器 `kernel/five-questions.ts` 与 `tests/super-agent-kernel.test.ts`（31 项）；底座原有文件零改动，`purity.test.ts` 6/6 守护通过。接线中修掉了类型、去重契约、external taint 传播三个真实缺陷，详见 `docs/M0_BASELINE.md §5`。
- **M0 正式基线已判定通过**：CI run `42021872381` 的 Linux + macOS 双矩阵全部 success。
- **M2 只读控制平面已接线**：`approvals` / `grants` 投影、`host/super-{blackboard,eventstore,watchdog,api}.ts`、`/v1/super/*` 只读端点与 SSE、`tests/super-agent-host.test.ts`（16 项）。CI run `42032246684` 双矩阵 success。见 `docs/M2_READONLY_PLANE.md`。
- **M3 显式写命令与评估旁路已接线**：`host/super-commands.ts`（五类命令 → 一条事实）、`host/super-assessor.ts`（候选卡 → `eval.decided` 回写）、鉴权前置、分支调试、HealthBoard 实时、`tests/super-agent-m3.test.ts`（20 项）。合并绿色回归 135/135。见 `docs/M3_COMMANDS_AND_ASSESSMENT.md`。
- **M4 第一批已完成**：修掉「示例配置会让中台无法启动」的缺陷，拆出 `super.json`，`host/super-config.ts` 与 `liveDeps()` 接真实配置，前端补 owner key 输入并改用 super SSE；10 项单测（含 `node:vm` 前端冒烟）。见 `docs/M4_CONFIG_AND_FRONTEND.md`。
- **M4 第二批第 1 项已完成**：`host/super-health.ts` 的 `HealthPlane` + `HealingActor` 接口把「组件上报 → Watchdog 阶梯 → 动作执行 → 恢复」做成零外部依赖的可测闭环；`/v1/super/health/report` · `/check` · `/actions` 端点、14 项单测、前端 L4 卡。见 `docs/M4_HEALTH_CLOSED_LOOP.md`。
- **schema 层与 `src/domain/ports.ts`、`src/web/api.ts` 仍是契约文件**；M4 第二批余下 3 项（物化投影 / Webhook 飞书 / WSL→macOS 压测）需要真实运行环境，本环境无法验证。

## 落地时必须留意的三条底座约束

1. `tests/purity.test.ts` 断言仓库根**不能存在 `web/`**。可交互前端留在 `super-agent/web/` 是安全的；若 M4 要迁到根 `web/`，必须同步调整该测试。
2. `tests/purity.test.ts` 只扫描 `kernel/` **顶层**的 `.ts`（非递归）。L0 组件放子目录会脱离架构守护。顶层文件必须满足：无 vendor 名、无网络请求、无 `Date.now` / `Math.random` / `process.env` / `node:fs`、无越权写投影。
3. `scripts/ci-scope.sh` 把 `kernel/*` 归为 `scope=kernel`（触发 `test:quick` + `test:sim`），把未列出的路径归为 `full`。新增 `tests/*.test.ts` 会被自动收录，无需改 CI。

## 不包含

`.research/` 里的两个上游源码只读快照、`.fork-stage/` 暂存目录本身、以及任何密钥或账号凭据，都不会提交。

## 许可

上游 `agent-autoloop` 与 `dsh-superagent-prototype` 均为 MIT。本目录新增文件同样适用 MIT，并保留上游 LICENSE；移植来源已在各文档中注明。
