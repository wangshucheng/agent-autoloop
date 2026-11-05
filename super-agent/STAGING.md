# 在 fork 中的位置说明

本目录是 `super-agent-auto-loop-runtime` 的**设计与骨架暂存区**，放在 `feat/super-agent-runtime` 分支上。

## 为什么集中放在 `super-agent/`

M0/M1 阶段为了不覆盖上游 `agent-autoloop` 的任何原有文件，交付统一放在这个新增目录下。**M2 起才有三处最小增量改动**：`kernel/evolve.ts`（+5 行，追加两张投影表）、`sim/invariants.ts`（回放 oracle 共享 `TABLES`）、`host/http.ts`（+1 行挂载 super handler，41 行仍在架构测试的 50 行上限内）。每处都有回归测试守护，原有 handler 语义与 `/v1` 协议不变。详见 `docs/M2_READONLY_PLANE.md`。

| 暂存位置 | 目标位置（M1+） |
| --- | --- |
| ~~`src/kernel/*.ts`~~（M1 已落地，副本已删除） | `kernel/fact.ts` / `approval.ts` / `excitation.ts` / `grants.ts` / `five-questions.ts`；M2 再扩展 `evolve.ts` / `decide.ts` |
| `src/domain/ports.ts` | `domain/ports.ts` |
| `src/host/{eventstore,blackboard,watchdog}.ts` | **M2 已落地**：`host/super-eventstore.ts` / `super-blackboard.ts` / `super-watchdog.ts`，副本已删除 |
| `src/host/assessor.ts` | M3 落位（主会话 LLM 评估旁路，结论以 `eval.decided` 回写） |
| `src/web/api.ts` | `web/api.ts` |
| `web/index.html` 等 | `web/`（可交互前端，可直接运行） |
| `schemas/fact.schema.json` | `protocol/fact.schema.json` 或 `schemas/` |
| `config/rules.example.json` | `~/.agent-autoloop/rules.json` 的扩展示例 |
| `deploy/` | `deploy/`（launchd / systemd 单元） |

## 本轮状态

- **已执行 fork**：`wangshucheng/agent-autoloop` 是 `KKKKhazix/agent-autoloop` 的 fork，已同步到上游最新 `main`；本分支从该 `main` 切出。
- **已交付可交互前端**：`web/index.html`，双击即可打开；后端不可达时自动切演示数据。运行方式见 `web/README.md`。
- **不做「审计追踪 DeepSeek」**：保留通用审计（因果链 / why / 回放 / fork / 断点）与主会话 LLM 评估；不记录模型调用明细、不生成模型审计摘要。见 `docs/02-事件内核-回放-fork-断点-审计.md §6.2`。
- **M0 基线已记录**：Windows 本机不作为正式基线，正式基线复用底座 CI 的 Linux + macOS 双矩阵；本机 `npm ci` / `typecheck` / 63 项纯内核回归全绿。见 `docs/M0_BASELINE.md`。
- **M1 纯内核已接线**：四个 L0 组件落到 `kernel/` 顶层，新增五问组合器 `kernel/five-questions.ts` 与 `tests/super-agent-kernel.test.ts`（31 项）；底座原有文件零改动，`purity.test.ts` 6/6 守护通过。接线中修掉了类型、去重契约、external taint 传播三个真实缺陷，详见 `docs/M0_BASELINE.md §5`。
- **M2 只读控制平面已接线**：`approvals` / `grants` 投影、`host/super-{blackboard,eventstore,watchdog,api}.ts`、`/v1/super/*` 只读端点与 SSE、`tests/super-agent-host.test.ts`（16 项）。写命令端点统一 405，留给 M3。见 `docs/M2_READONLY_PLANE.md`。
- **M0 正式基线已判定通过**：CI run `42021872381` 的 Linux + macOS 双矩阵全部 success。
- **schema 层与 `src/domain/ports.ts`、`src/web/api.ts` 仍是契约文件**；下一站 M3（写命令 + Assessor）。

## 落地时必须留意的三条底座约束

1. `tests/purity.test.ts` 断言仓库根**不能存在 `web/`**。可交互前端留在 `super-agent/web/` 是安全的；若 M4 要迁到根 `web/`，必须同步调整该测试。
2. `tests/purity.test.ts` 只扫描 `kernel/` **顶层**的 `.ts`（非递归）。L0 组件放子目录会脱离架构守护。顶层文件必须满足：无 vendor 名、无网络请求、无 `Date.now` / `Math.random` / `process.env` / `node:fs`、无越权写投影。
3. `scripts/ci-scope.sh` 把 `kernel/*` 归为 `scope=kernel`（触发 `test:quick` + `test:sim`），把未列出的路径归为 `full`。新增 `tests/*.test.ts` 会被自动收录，无需改 CI。

## 不包含

`.research/` 里的两个上游源码只读快照、`.fork-stage/` 暂存目录本身、以及任何密钥或账号凭据，都不会提交。

## 许可

上游 `agent-autoloop` 与 `dsh-superagent-prototype` 均为 MIT。本目录新增文件同样适用 MIT，并保留上游 LICENSE；移植来源已在各文档中注明。
