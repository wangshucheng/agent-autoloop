# 在 fork 中的位置说明

本目录是 `super-agent-auto-loop-runtime` 的**设计与骨架暂存区**，放在 `feat/super-agent-runtime` 分支上。

## 为什么集中放在 `super-agent/`

为了不触碰、不覆盖上游 `agent-autoloop` 的任何原有文件（`kernel/`、`host/`、`protocol/`、`worker/`、`cli/`、`plugins/`、`tests/`、`sim/` 全部保持原样），本轮交付统一放在这个新增目录下。到 M1–M4 实施时，再按 `docs/01-源码对照与移植映射.md §5` 的改造点把模板落到对应目录：

| 暂存位置 | 目标位置（M1+） |
| --- | --- |
| `src/kernel/*.ts` | `kernel/`（新增 `approval.ts` / `excitation.ts` / `grants.ts`，并扩展 `evolve.ts` / `decide.ts`） |
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
- **代码模板是骨架，未接线**；后端实现按 `docs/05` 的 M0–M5 里程碑推进。

## 不包含

`.research/` 里的两个上游源码只读快照、`.fork-stage/` 暂存目录本身、以及任何密钥或账号凭据，都不会提交。

## 许可

上游 `agent-autoloop` 与 `dsh-superagent-prototype` 均为 MIT。本目录新增文件同样适用 MIT，并保留上游 LICENSE；移植来源已在各文档中注明。
