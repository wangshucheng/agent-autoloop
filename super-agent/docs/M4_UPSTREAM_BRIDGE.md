# M4 第二批 · 第 3 项：用底座原生能力做生产接线

记录时间：2026-11-06。前置：M4 第一批、健康闭环、看板物化投影均已落地，CI 双矩阵连续通过（含 run `42182499252`）。

## 1. 为什么不需要真实凭据

master 的要求是**用 agent-autoloop 原本的实现**（例如飞书通道），而不是另造一套外部集成。底座已经把「难的部分」做完了：

| 能力 | 底座已有的实现 | 凭据在哪 |
| --- | --- | --- |
| Webhook 验签与事件翻译 | `plugins/github/source.ts`、`plugins/gitlab/source.ts`，经 `/v1/in/:source` → `adapt()` | `secrets.env` 的 `AGENT_AUTOLOOP_SECRET_*` |
| 飞书 / 桌面卡片渲染与回执 | `plugins/feishu/channel.ts`、`plugins/desktop/channel.ts`，经 `nextCard(channel)` 拉取 | `lark-cli` / `config.json`，**super 平面完全不碰** |
| 卡片去重 | `kernel/decide.ts` 的 `createCard()` 按 `key` + open 状态去重 | 无 |
| 定时语义 | `kernel/cron.ts` 的 `parseCron` / `nextRun` / `describeCron` | 无 |
| 多项目通道与收件人 | `rules.json` 的 `channels.*.answerers` + `host/runtime.ts` 的 `rules` | 既有配置 |

因此 super 平面只需要一个**纯适配层**：把已验签的事件映射成 super 事实、把 super 卡片转成底座 `createCard` spec、用底座 cron 算下次触发、按 `super.json` 的 bindings 做项目路由。不发任何 HTTP、不启动任何定时器、不读任何密钥——全部可用桩测试。

## 2. `host/super-bridge.ts`

```
已验签事件 (plugins/<source>/source.ts 的形状)
   → translateIngress()  → trigger.received 事实（taint: external / project_id / correlation）
   → writeFact()         → commit + board_items 投影
   
super 卡片
   → toUpstreamCard()    → 底座 createCard spec（key / kind / fyi / options / channel）
   → deliverCard()       → CardSink.createCard（即 hub.createCard）
   → plugins/feishu|desktop/channel.ts 通过 nextCard() 自己拉取并渲染
   
super.json schedule
   → nextScheduledRuns() → 底座 parseCron/nextRun，返回下次触发时刻（不启动定时器）
   
super.json bindings + rules.json channels
   → projectFor() / channelForProject() / projectRoutes()
```

四条函数全是纯函数；唯一的 I/O 通过 `CardSink` 与 `upstreamChannels()` 注入。

### 事实资料字段

`FactV2.meta` 新增可选 `preview?: {title, text}`：外部事件的标题/摘要作为**只读资料快照**进入 meta，`describeFact()` 优先读它，`lanesFromFacts` 与 `lanesFromRows` 因此都显示同一份内容。外部文字仍带 `taint: external`，不会变成 `to / cwd / skill / access / emits / agent / answerers` 任一指令字段；`translateIngress()` 用底座 `validateEventShape()` 在入口拒收它们。

## 3. 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/super/ingress/:source` | 接收**已验签**的底座 adapter 事件（单个或 `{events:[...]}`），每个事件产一条事实；批量 seq 连续 |
| POST | `/v1/super/cards/deliver` | 把 super 卡片送进底座卡片池，返回 `channel` / `answerers` / `duplicate` |
| GET | `/v1/super/schedule` | 各项目定时任务的下次触发时刻与中文描述 |
| GET | `/v1/super/channels` | 底座 `rules.json` 已配置的通道 |
| GET | `/v1/super/projects/routes` | 项目 → 来源 / 通道 / 收件人 / 并发上限 / 定时任务 |

两个 POST 沿用 M3 的 owner key 鉴权与指令字段拒收；`cardSink` 未接线返回 `501 card_sink_not_wired`，不假装已投递。

**入向部署说明**：底座 `/v1/in/:source` 仍是 Webhook 的正式入口（验签在那里）。super 的 ingress 端点用于「已经验签、需要 super 语义」的事件——生产可在同源代理把 `/v1/in/:source` 翻译出的事件镜像一份，或让来源插件直接调用；它不重复验签，也不替代底座入口。

## 4. 四项接线的具体落点

1. **Webhook**：复用 `plugins/github/source.ts` 输出的 `{id,type,subject,summary,detail,link}` 形状；`translateIngress` 加 `project_id`（来自 `bindings.sources`）、稳定 `correlation_id`（`digestOf({source,id})`）、`taint/trust: external`、只读 `preview`。`actor` 记来源名，不记模型信息。
2. **飞书卡片**：`toUpstreamCard` 生成底座 spec，`createCard` 的 `key` 去重天然实现「同一根因只发一张卡」；`notice` 卡设 `fyi=1`。选择哪个通道由 `bindings.channels[project]` 决定，示例把 `home-deco`/`shop` 指向 `feishu`、`personal` 指向 `desktop`。**super 不发飞书消息**，`plugins/feishu/channel.ts` 自己用 `nextCard("feishu")` 拉取并渲染。
3. **定时**：`super.json` 的 `schedule` 段（示例三条：`*/15 * * * *`、`0 18 * * *`、`0 9 * * 1-5`）交给底座 `parseCron`/`nextRun` 解析；`GET /schedule` 返回下次触发时刻，由外部调度器或底座 `tick()` 在到期时触发对应 action。请求驱动、挂起零进程零 Token，不新设定时器。
4. **多项目**：`projectFor` 按来源 → 规则绑定 → 默认项目路由；`channelForProject` 把项目映射到已配置通道与 `answerers`；`projectRoutes` 汇总来源、通道、并发上限、定时任务。`super.json` 新增 `bindings.channels` 与 `schedule`，`parseSuperConfig` 校验并合并默认值。

## 5. 验证

| 检查 | 结果 |
| --- | --- |
| `tests/super-agent-m4-bridge.test.ts` | ✅ 13/13（含「底座插件确实存在」的静态断言，防止另造客户端） |
| 合并绿色回归子集（purity / ci-scope / cron / M1 / M2 / M3 / M4 / health / projection / bridge / kernel / hops / projection.test / schema） | ✅ **181/181** |
| `npm run typecheck` | ✅ exit 0 |
| `prettier --check` 新增/改动文件 | ✅ |
| `npm run test:sim` 20000 步 | ✅ 35.4s / 1644 completed |
| `host/http.ts` 行数 | 41 ≤ 50 |
| CI 双矩阵 | 推送后触发，结果回填 |

## 6. M4 第二批进度

1. ✅ 组件主动上报 + 自愈动作接口（`M4_HEALTH_CLOSED_LOOP.md`）
2. ✅ 看板物化投影（`M4_MATERIALIZED_PROJECTION.md`）
3. ✅ Webhook / 飞书卡片 / 定时 / 多项目生产接线（本文档，用底座原生实现）
4. WSL → macOS 迁移压测——本机 `wsl.exe` 被安全策略禁止，需解禁或在 macOS 执行 `deploy/com.superagent.runtime.plist`。这是唯一仍需要目标平台的一项。

红线不变：不记录模型调用明细、不让模型生成审计摘要；外部文字始终 `taint: external`；挂起零 Agent 进程零 Token；授权可立即撤销；一个状态一个写者；生产 main 只读、永不回滚。
