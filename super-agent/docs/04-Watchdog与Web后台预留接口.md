# 04 Watchdog 自愈合 + Web 后台预留接口（仪表盘 + Blackboard）

> 原则：**健康状态不占版面；只有需要人的时候才出现**。Watchdog 修复不了的问题，最终只给一张卡。

---

## 1. Watchdog 总览

```
                    ┌──────────────────────────────────────────┐
事实流 ──订阅──▶    │ HealthBoard（每条健康条目唯一认领者）       │
                    │  runtime / passes / evals / models /       │
                    │  assessment / launch / delivery / relay /  │
                    │  notice / reply / worker / source:<id> /   │
                    │  sync:<id> / watchdog                      │
                    └──────────────┬───────────────────────────┘
                                   │ 健康变化 = health.changed 事实
                                   ▼
                         Watchdog 决策（L0–L4 阶梯）
                                   │
                                   ▼
              自愈动作（重启/重建/降级/停用） ──▶ watchdog.recovered
                                   │ 连续超限仍失败
                                   ▼
                         一张卡片（唯一人工打扰）
```

**HealthBoard**（移植 dsh `src/infra/health.ts`）：每个组件在启动时「认领」自己的健康条目，重复认领被拒；只有认领者能写它；注销后的上报无效。这保证「一个状态一个写者」在运维层也成立。

条目状态：`ok | degraded | failing | disabled | recovering`，附 `consecutive_failures`、`last_success_at`、`last_error_code`、`since`。

Watchdog 自身也认领一个 `watchdog` 条目，并受 `self_heal_budget` 约束（见 §3）。

---

## 2. 自愈阶梯

| 级别 | 触发 | 动作 | 是否打扰人 | 事实 |
| --- | --- | --- | --- | --- |
| L0 自动退避 | 瞬时失败（网络 408/429/5xx、连接重置、DB 被占、卡片发送失败） | 按 `due` 表指数退避重试；`Later` 不计失败 | 否 | `effect.deferred` / `effect.failed` |
| L1 重启组件 | 插件抛未接住异常、通道/接单程序退出 | 30 秒后重启该插件（不影响中台与其它插件） | 否 | `health.changed` |
| L2 重建投影 | 格式指纹不匹配、启动发现游标缺失 | 在同一事务内逐条读日志重建投影与索引，不覆盖期间新提交 | 否 | `runtime.rebuilt` |
| L3 降级 | 连续 3 次失败（同类）、Source 配置非法、磁盘/DB 持续异常 | 停用该 Source / 暂停处理（Source 继续记录 Trigger）/ 旧规则继续跑 | 仅记入健康面板 | `health.changed{degraded}` |
| L4 人工 | L3 持续超过阈值、自愈预算耗尽、数据一致性校验失败、需人恢复登录/验证/浏览器连接 | 发**一张**可行动卡片（带选项：重试 / 停用 / 忽略），随后挂起零消耗 | 是 | `watchdog.escalated` + `card.created` |

关键约束：

- **只有「连续 3 次」才算系统问题**（dsh Effects / 底座失败表）；一次性网络错误绝不打扰。
- **规则文件写错/被删**：旧规则继续跑 + 一张说明卡（底座行为），不中断业务。
- **日志写不出去（管道断、磁盘满）**：进程退出，由 launchd/systemd 拉起（底座行为）。
- **中台重启**：状态全在 SQLite，各组件自动重连；在途 Assignment 以 `assignmentInterrupted` 语义恢复（移植 dsh），带 recovery note 让 Agent 先查目录、git 历史、远端状态再决定是否重做外部动作。
- **暂停期间**：Source 仍记录 Trigger；Eval 不超时；恢复后第一轮按当时 Policy 复验 Mandate。

---

## 3. 故障 → 级别映射表（直接复用底座失败表）

| 底座已定义的故障（`docs/protocol.md`「失败时会怎样」） | 级别 | 自愈动作 |
| --- | --- | --- |
| 来源重复发事件 / 重复点卡片 | L0 | 去重，不产生事实 |
| 领活响应丢失 / 交结果响应丢失 | L0 | 同 `claim` 拿回同一份活；同 token 重放得到同样确认，内容不同 409 |
| Agent 没跑成 | L0→L1 | 5 分钟起重试、翻倍至 1 小时；连续第 3 次通知；第 10 次记 cancelled 并发一张卡 |
| 接上原会话但干到一半断了 | L0 | 留在原会话重派，不开新会话重做业务 |
| 回执写错 | L0 | 只重写最后一条消息（最多 2 次），不重做业务；仍失败保留结论 + 一张卡 |
| 接单程序/通道停了或插件未接住异常 | L1 | 记日志，30 秒后重启；中台照常 |
| 别的进程占数据库太久 | L0 | 这次到期跳过，5 秒后再试，中台不退出 |
| 日志写不出去 / 磁盘满 | L1 + launchd/systemd | 进程退出，服务拉起 |
| 接单程序在线但 5 分钟没报某轮 | L3 | 标记「不确定」、放开该组、告知；后来交的结果照样收 |
| 接单程序整台不见了 | L3→L4 | 活留着不放开，10 分钟后**告知一次**；回来自动收尾 |
| 中台重启 | L2 | SQLite 恢复；格式变化则逐条重建（110 万事实约 43.1 秒） |
| 定时错过 | L0 | 醒来只补最近一次 |
| 规则写错 / 被删 | L3 | 旧规则继续跑，一张卡；放回去接着用 |
| 规则删掉或改名 | L3 | 未领走/未跑成的轮次记 cancelled 并通知；在跑的照常收结果 |
| 卡片发送失败 | L0→L4 | 递增退避，1 小时后放弃但卡片仍开；通道插件崩溃 30s 重启 |

**自愈预算**（防止 Watchdog 自己自激）：

```jsonc
"watchdog": {
  "restart_budget_per_component_per_hour": 5,
  "max_auto_escalations_per_hour": 2,
  "transient_failure_threshold": 3,
  "escalation_suppression_minutes": 30,
  "on_budget_exhausted": "disable_component_and_notify_once"
}
```

超预算后：**停用组件 + 一张卡**，不再自动重启；恢复必须由人显式操作。所有升级用 `digest` 去重，同一根因不重复打扰。

---

## 4. Web 后台：只做预留接口

### 4.1 设计原则（移植 dsh `docs/005-panel.md`）

1. 打开面板按顺序回答三个问题：**要我做什么？系统健康吗？这件事的历史？**
2. **A healthy state takes no space**：健康区块默认折叠，红色区块才展开。
3. 一个概念只在一个地方出现：Source 状态在 Source 页、Trigger/Thread 在 Trigger 页、Decision 在 Eval 页、Ticket 在 Execution 页；Overview 只做摘要与跳转。
4. 计数必须等于它所链接的列表长度；标签说明「在等谁、需要什么」，不暴露内部状态码。
5. 问题必须可行动；破坏性操作要二次确认。
6. 前端只读为主，写操作必须通过明确的命令端点（与 CLI/MCP 同一套 HTTP 接口）。

### 4.2 仪表盘（Dashboard）

`GET /v1/super/overview` → 三个区块，按顺序：

```jsonc
{
  "needs_person": {                    // ① 要我做什么（唯一默认展开）
    "count": 2,
    "items": [
      { "kind": "approval", "card_id": 56, "project_id": "home-deco",
        "title": "是否合并 PR #42", "waiting_for": "ou_xxx", "age_minutes": 12,
        "actions": ["approve", "deny", "open_trace"] },
      { "kind": "attention", "ticket_id": "t-9", "title": "需要恢复登录", "actions": ["retry", "stop"] }
    ]
  },
  "health": {                          // ② 系统健康（有问题才展开）
    "status": "degraded", "problems": [
      { "entry": "source:github", "code": "poll_failed_3x", "since": "2026-11-05T17:40:00+08:00",
        "action": "check_again" }
    ],
    "suppressed": 4                   // 被抑制的瞬时错误，不占版面
  },
  "activity_24h": {                    // ③ 活动与注意力（折叠）
    "triggers": 128, "evals": 17, "accepted": 3, "runs": 9, "cards": 2,
    "questions": 1, "tokens": 41200, "cost_usd": 0.31,
    "attention": { "cards_per_owner_hour": 0.5, "actionable_ratio": 1.0 },
    "worker_load": { "running": 2, "capacity": 4 }
  },
  "policy_version": "P8",
  "now": "2026-11-05T18:23:57+08:00"
}
```

### 4.3 Blackboard 看板

Blackboard 是**事实日志的读模型**，不是第二份状态源。所有列（泳道）由投影派生，永不手写。

```jsonc
// GET /v1/super/blackboard?project=home-deco
{
  "project_id": "home-deco",
  "lanes": [
    { "id": "intake",     "label": "新事件",     "count": 12, "items": [/* trigger.received */] },
    { "id": "evaluating", "label": "研判中",     "count": 1,  "items": [/* eval.started */] },
    { "id": "would_accept","label": "本来会接",  "count": 3,  "items": [/* observe 模式记录 */] },
    { "id": "authorized", "label": "已授权",     "count": 2,  "items": [/* grant.created */] },
    { "id": "working",    "label": "执行中",     "count": 2,  "items": [/* assignment.started */] },
    { "id": "waiting_person","label": "待人",    "count": 1,  "items": [/* card.created / approval.required */] },
    { "id": "suspended",  "label": "挂起零消耗", "count": 4,  "items": [/* 到期复查 / 等回答 */] },
    { "id": "done",       "label": "完成",       "count": 41, "items": [/* ticket.ended */] },
    { "id": "tripped",    "label": "熔断/阻断",  "count": 0,  "items": [/* excitation.tripped */] }
  ],
  "stream_after": 12648430             // 前端用 /v1/stream 增量更新，不轮询
}
```

每张卡（item）统一形状：`{ id, kind, project_id, title, preview, state, waiting_for, age, hops, policy_version, grant_id, correlation_id, actions[] }`。点开任一项 → `GET /v1/super/trace/:correlation_id` 拿到完整因果链（含评估与审批）。

### 4.4 预留 API 清单

**约定**：全部挂在 `/v1/super/*`，与底座 `/v1` 解耦；新增字段可选；老客户端忽略不认识的字段；同一套 HTTP + JSON，CLI / MCP / Web 平等；`Authorization: Bearer <owner key>`；同源校验、请求体上限、错误状态沿用底座 `kernel/http.ts`。除明确标注的命令外，**全部只读**。

| 方法 | 路径 | 用途 | 类型 |
| --- | --- | --- | --- |
| GET | `/v1/super/overview` | 仪表盘三问 | 读 |
| GET | `/v1/super/blackboard?project=&lane=` | 看板泳道 | 读 |
| GET | `/v1/super/projects` | 项目列表、预算、健康 | 读 |
| GET | `/v1/super/trace/:correlation_id` | 完整因果链 | 读 |
| GET | `/v1/super/attention?window=24h` | 注意力预算计量（卡片/问题/字数） | 读 |
| GET | `/v1/super/audit/trace/:run_id` | 与 `why` 同源的审计视图 | 读 |
| GET | `/v1/stream?after=&branch=&project=` | 事实 SSE（底座已有，扩展参数） | 读 |
| GET | `/v1/runs/:id/why` | 底座已有 | 读 |
| GET | `/v1/state` | 底座已有，保持兼容 | 读 |
| GET | `/v1/super/health` | HealthBoard 全量（含被抑制计数） | 读 |
| GET | `/v1/super/policy` / `/v1/super/policy/history` | 当前策略与版本历史 | 读 |
| GET | `/v1/super/grants/:id` | 授权详情与复验记录 | 读 |
| GET | `/v1/super/breakpoints?branch=` | 分支断点 | 读 |
| GET | `/v1/super/debug/stream?branch=` | 重放/断点 SSE | 读 |
| POST | `/v1/super/eval/:id/decision` | **主会话评估结论写回**（命令） | 写 |
| POST | `/v1/super/approvals/:id/answer` | 审批回答（等价于 `card.answered`） | 写 |
| POST | `/v1/super/grants/:id/revoke` | 撤销授权（命令） | 写 |
| POST | `/v1/super/policy/save` | 保存策略，带 `baseRevision` + `origin`（CAS） | 写 |
| POST | `/v1/super/processing/pause` | 暂停/恢复处理（命令） | 写 |
| POST | `/v1/super/replay` | 在只读副本上重放（命令，不写业务投影） | 写（调试） |
| POST | `/v1/super/fork` | 创建分支（命令） | 写（调试） |
| POST | `/v1/super/breakpoints` | 注册/清除断点（仅分支） | 写（调试） |
| POST | `/v1/super/watchdog/check` | 手动触发一次健康检查 | 写（运维） |

**已交付可交互前端**：`web/index.html` + `web/app.js` + `web/styles.css` + `web/mock.js`（仪表盘 + Blackboard 看板）。它只消费上面的预留接口；后端未启动时自动切到 `web/mock.js` 的演示数据，并在界面上明确标注「演示数据」。运行方式见 `web/README.md`。仍不在范围内：工作流画布、Agent 记忆、模型路由、插件市场、多租户 SaaS 化。

### 4.5 前端增量更新

```
Web 打开 ──GET /v1/super/overview + /blackboard──▶ 首屏
     │
     └──GET /v1/stream?after=<last seen seq>──▶ SSE 逐条事实 ──▶ 只更新受影响 item
```

不引入轮询；断线用 `Last-Event-ID` 续读；订阅者按自己速度逐条接收，服务端不缓存全量日志（底座约束）。因此「看板」本质上是事实流的物化视图，和 CLI `status` 看到的是同一份真相。

---

## 5. Watchdog 与后台的注意力约束

| 约束 | 落点 |
| --- | --- |
| 健康区块默认折叠，只有 `needs_person` 展开 | `/v1/super/overview` |
| 一次性错误不出现在界面（`suppressed` 只给一个数字，不给列表） | `health.suppressed` |
| 同一根因只发一张卡（`digest` 去重 + 升级抑制窗口） | Watchdog |
| Blackboard 的 `done` 泳道默认折叠（历史不占版面） | 前端约定 |
| 破坏性操作（撤销授权、停用 Source、删除分支）二次确认 | API + 前端 |
| 旁路生成/分析失败静默放弃，不发卡 | 最小注意力约束 |
