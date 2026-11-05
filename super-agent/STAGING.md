# 在 fork 中的位置说明

本目录是 `super-agent-auto-loop-runtime` 的**设计与骨架暂存区**，放在 `feat/super-agent-runtime` 分支上。

## 为什么集中放在 `super-agent/`

为了不触碰、不覆盖上游 `agent-autoloop` 的任何原有文件（`kernel/`、`host/`、`protocol/`、`worker/`、`cli/`、`plugins/`、`tests/`、`sim/` 全部保持原样），本轮交付统一放在这个新增目录下。到 M1–M4 实施时，再按 `docs/01-源码对照与移植映射.md §5` 的改造点把模板落到对应目录：

| 暂存位置 | 目标位置（M1+） |
| --- | --- |
| ~~`src/kernel/*.ts`~~（M1 已落地，副本已删除） | `kernel/fact.ts` / `approval.ts` / `excitation.ts` / `grants.ts` / `five-questions.ts`；M2 再扩展 `evolve.ts` / `decide.ts` |
| `src/domain/ports.ts` | `domain/ports.ts` |
| `src/host/*.ts` | `host/`（新增 `eventstore.ts` / `assessor.ts` / `effects.ts` / `outbox.ts` / `watchdog.ts` / `blackboard.ts`） |
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
- **host / web / schema 层模板仍是骨架，未接线**；后端实现按 `docs/05` 的 M0–M5 里程碑推进，下一站 M2。

## 落地时必须留意的三条底座约束

1. `tests/purity.test.ts` 断言仓库根**不能存在 `web/`**。可交互前端留在 `super-agent/web/` 是安全的；若 M4 要迁到根 `web/`，必须同步调整该测试。
2. `tests/purity.test.ts` 只扫描 `kernel/` **顶层**的 `.ts`（非递归）。L0 组件放子目录会脱离架构守护。顶层文件必须满足：无 vendor 名、无网络请求、无 `Date.now` / `Math.random` / `process.env` / `node:fs`、无越权写投影。
3. `scripts/ci-scope.sh` 把 `kernel/*` 归为 `scope=kernel`（触发 `test:quick` + `test:sim`），把未列出的路径归为 `full`。新增 `tests/*.test.ts` 会被自动收录，无需改 CI。

## 不包含

`.research/` 里的两个上游源码只读快照、`.fork-stage/` 暂存目录本身、以及任何密钥或账号凭据，都不会提交。

## 许可

上游 `agent-autoloop` 与 `dsh-superagent-prototype` 均为 MIT。本目录新增文件同样适用 MIT，并保留上游 LICENSE；移植来源已在各文档中注明。
