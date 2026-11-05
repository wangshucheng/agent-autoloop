# super-agent-auto-loop-runtime

> 以 `KKKKhazix/agent-autoloop` 为运行底座，移植 `deepseek-ai/dsh-superagent-prototype` 的领域模型与设计思想，
> 构建一个事件驱动、最小注意力占用的多项目 Super-Agent 运行时。
> 开发在 WSL，最终运行在 macOS。

## 状态（2026-11-05 更新）

本仓库当前是**架构设计 + 可落地骨架 + 可交互前端原型**，不是已完成的后端实现。

- **fork 已执行**：`wangshucheng/agent-autoloop` 已是上游 fork，已同步到上游最新 `main`（`f25ce4a`），工作分支 `feat/super-agent-runtime`，设计与前端已提交到该分支。
- **可交互前端已交付**：`web/index.html`（仪表盘 + Blackboard 看板），可直接打开或用静态服务器运行；后端未启动时自动切演示数据并明确标注。
- **不做「审计追踪 DeepSeek」**：按 master 决策，移除模型调用审计与模型生成审计摘要；**保留通用审计追踪**（因果链 / `why` / 回放 / fork / 断点）与**主会话 LLM 评估**本身。
- 已完成：两个上游仓库的源码调研、总体架构、事件内核协议、策略组件、Watchdog、Web 后台预留接口、WSL→macOS 路线图。
- 已产出：`docs/` 设计文档 6 份、`schemas/` 协议、`config/` 全量示例配置、`src/` 核心代码模板、`web/` 前端、`scripts/` 与 `deploy/` 启动脚本。
- 参考源码快照：`.research/agent-autoloop/`、`.research/dsh-superagent-prototype/`（本地只读调研用）。

## 一句话结论

**能支持主会话 LLM 评估**，但 LLM 只能放在内核之外的旁路评估器里：内核保持「零网络、零时钟、零随机数」的确定性，评估作为一个订阅事件流的插件运行，其结论以一条 `eval.decided` 事实写回日志，回放时不重跑模型。这样既拿到 dsh-superagent 的研判能力，又不破坏 agent-autoloop 的事件溯源与可复现性。评估结论只记 `policy_version` 与 `reason`，不记模型调用明细。

## 五个问题 → 五个决策点

| 问题 | 决策组件 | 产物事实 |
| --- | --- | --- |
| 什么事 | Intake / Source / Trigger 归一化 | `trigger.received` |
| 做不做 | Gate（确定性）+ Assessor（主会话 LLM，可关） | `eval.started` / `eval.decided` |
| 给谁做 | Router / Assignment / Mandate | `ticket.created` / `run.claimed` |
| 在哪做 | ExecutionEnvironment（项目、目录、沙箱） | `assignment.started` |
| 怎么做 | Skill / Prompt / Receipt / 副作用闸门 | `run.result` / `card.created` |

共同约束：**占用最少的人的注意力**。所有组件默认安静，只有「必须人行动」或「人可用到结果」时才发卡片；每张卡片都要比它消耗的注意力更值钱。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| `docs/00-总纲.md` | 理念、五问映射、分层与组件、端到端事件流、ADR、目录结构、已拍板决策 |
| `docs/01-源码对照与移植映射.md` | 两个仓库逐项对照、移植策略、保留/放弃清单、fork 改造点 |
| `docs/02-事件内核-回放-fork-断点-审计.md` | Fact v2、因果链、分支/fork/回放/断点、通用审计追踪与范围说明 |
| `docs/03-策略组件-评估-审批-授权-自激防线.md` | Policy 版本、主会话评估、审批卡片开关、授权可撤销、自激防线、注意力预算 |
| `docs/04-Watchdog与Web后台预留接口.md` | 自愈合阶梯、健康面板、仪表盘 + Blackboard 看板预留 API |
| `docs/05-WSL到macOS部署与路线图.md` | 环境差异、服务托管、fork 实操记录、M0–M5 里程碑、测试与验收 |
| `web/README.md` | 可交互前端的运行方式、接口对接、演示数据说明 |

## 目录

```
docs/                 设计文档（按顺序读）
schemas/fact.schema.json   Fact v2 JSON Schema (2020-12)
config/rules.example.json  全量示例配置（所有开关都在这里演示）
src/kernel/           确定性内核模板：fact / approval / excitation / grants
src/domain/           领域端口与角色接口（Pick 收窄）
src/host/             外壳模板：eventstore / assessor / watchdog / blackboard
src/web/              预留 API 类型定义
web/                  可交互前端：index.html / app.js / styles.css / mock.js
scripts/              WSL 开发脚本
deploy/               macOS launchd / WSL systemd 单元
.research/            上游仓库只读快照
```

## 关键红线

1. **不改 `/v1` 已有语义**：路径、字段含义、鉴权、插件约定、`rules.json` 旧字段全部保持兼容；新能力一律用可选字段、新事实类型、新 `/v1/super/*` 端点。老客户端忽略不认识的字段。
2. **内核不出网**：LLM、Webhook、飞书、时钟、随机数、SQLite 连接都在 `host/`，内核只做 `decide(view, input, now, env) -> facts`。
3. **一个状态一个写者**：事实日志只有 `commit` 写，投影只有 `evolve` 写，健康条目只有认领它的组件写。
4. **外部文字永远是 data**：`summary/detail`、Issue 正文、飞书消息只进资料文件并打 `taint: external`，永不拼进提示词、永不决定 `to/cwd/skill/access`。
5. **一切可解释**：任何一轮都能用一条命令回答「为什么跑、谁批的、依据哪个策略版本、花了多少」。
6. **不做模型专项审计**：不落 `prompt_hash` / 模型名 / token / 延迟，不让模型生成审计摘要；评估结论是普通事实。

## 快速开始

```bash
# 1. 先读设计
cat docs/00-总纲.md

# 2. 看完整配置长什么样
cat config/rules.example.json

# 3. 打开可交互前端（后端未启动时自动使用演示数据）
#    直接双击 web/index.html，或起一个静态服务器：
cd web && python -m http.server 8080
#    浏览器打开 http://127.0.0.1:8080

# 4. 在 WSL 里对照上游跑一致性基线
cd .research/agent-autoloop && node --version   # 需要 Node 24
npm test
```

真正的 fork / 移植步骤与实操记录见 `docs/05-WSL到macOS部署与路线图.md §2`。
