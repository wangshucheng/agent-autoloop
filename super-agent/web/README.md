# 可交互前端：仪表盘 + Blackboard 看板

一个**零依赖、零构建**的静态单页前端。它只消费 `docs/04` 定义的预留接口；后端未启动时自动切换演示数据，并在顶部明确标注。

## 运行

```bash
# 方式一：直接双击 index.html（file:// 也能跑，自动走演示数据）

# 方式二：起静态服务器（推荐，便于接真实后端）
cd web
python -m http.server 8080
# 浏览器打开 http://127.0.0.1:8080
```

连接真实后端：把顶部「API 地址」改成中台地址（默认 `http://127.0.0.1:8787`），点「连接后端」。前端会探测 `GET /v1/super/overview`；成功则切到真实数据并用 SSE 订阅 `GET /v1/super/stream?after=`，失败则留在演示数据。中台默认只听 `127.0.0.1`，loopback 放行同源与 `file://`（`Origin: null`）的只读请求。

> **M4 起前端可填写 owner key**：在 banner 的「Owner key」输入框填入密钥后点「重连」，后续所有请求（含写命令）自动带 `Authorization: Bearer <owner-key>`。密钥只存在浏览器内存、不写入 URL；只读浏览在 loopback 仍免 key。SSE 走 `/v1/super/stream`——`EventSource` 无法发送自定义 header，而该端点在 loopback 只读免 key。命令契约见 `docs/M3_COMMANDS_AND_ASSESSMENT.md §3`。
>
> 中台从 `~/.agent-autoloop/super.json` 读取 `super.*` 配置；`rules.json` 只放底座原生字段。两份示例分别在 `config/rules.example.json` 与 `config/super.example.json`，见 `docs/M4_CONFIG_AND_FRONTEND.md`。

## 能点什么

| 交互 | 行为 |
| --- | --- |
| 项目下拉 | 切换 `project_id`，仪表盘、看板、指标、追踪全部按项目过滤 |
| 审批模式开关 | `off / notify / gate / escalate` 实时演示同一动作的不同结果；`off` 时审批项从「待人」移除，`notify` 变灰卡不阻断，`gate` 阻断并挂起，`escalate` 标为条件升级 |
| 批准 / 拒绝 / 重试 / 停止 | 演示模式本地更新并写一条提示；真实模式 `POST /v1/super/approvals/:id/answer`。拒绝与停止二次确认 |
| 卡片点击 / 「追踪」 | 打开右侧因果链抽屉，展示 `seq / type / actor / policy_version / grant_id / hops / reason`，断点命中高亮 |
| 抽屉「回放 / 断点」 | 单步 / 自动播放 / 重置的只读重放 stepper；断点可启用停用（如 `meta.hops >= 6`、`type = grant.revoked`）；明确标注「只调用 evolve，不重跑模型」 |
| 抽屉「策略与授权」 | 显示类别默认模式、当前模式、授权复验规则；可撤销授权（二次确认）、暂停/恢复处理 |
| 泳道标签 / 泳道折叠 | 按泳道筛选；`done` 默认折叠（历史不占版面） |
| 搜索 | 按标题 / id / correlation_id / kind / 预览过滤 |
| 事实流开关 | 演示模式每 6 秒注入一条新事实；真实模式来自 SSE；可暂停 |
| 系统健康区块 | 默认折叠，只给「几个问题 + 已抑制的瞬时错误数」；连续 3 次才升级。L4 人工卡（标 `L4`）在展开后出现，同一根因只发一张 |

## 接口映射

| 前端动作 | 预留接口 |
| --- | --- |
| 首屏 / 项目切换 | `GET /v1/super/overview?project=` · `GET /v1/super/blackboard?project=` |
| 增量更新 | `GET /v1/super/stream?after=&project=`（SSE，`event: fact`，`after` 续读）；底座原生的 `GET /v1/stream` 仍保留 |
| 追踪抽屉 | `GET /v1/super/trace/:correlation_id` · `GET /v1/super/audit/trace/:run_id` |
| 审批回答 | `POST /v1/super/approvals/:id/answer`（等价 `card.answered`） |
| 撤销授权 | `POST /v1/super/grants/:id/revoke` |
| 策略保存 | `POST /v1/super/policy/save`（带 `baseRevision` + `origin`，CAS） |
| 暂停处理 | `POST /v1/super/processing/pause` |
| 重放 / 分支 / 断点 | `POST /v1/super/replay` · `/fork` · `/breakpoints`，以及 `GET /v1/super/debug/stream` |
| 组件健康上报 / 自愈 | `POST /v1/super/health/report` · `/health/check`（需 owner key），`GET /v1/super/health` · `/health/actions`。见 `docs/M4_HEALTH_CLOSED_LOOP.md` |

## 设计约束

- **不做「审计追踪 DeepSeek」**：因果链里没有模型名、prompt hash、token、延迟，也没有模型生成的审计摘要；评估结论只带 `policy_version` 与 `reason.code`。
- **最小注意力**：只有「要我做什么」默认展开；健康区块折叠；`done` 折叠；一次性错误只给一个抑制计数；一次只问一个具体问题。
- **外部文字是 data**：所有标题/预览渲染前做 HTML 转义，避免把资料当指令注入页面。
- **只读为主**：写操作全部走明确命令端点，破坏性操作二次确认。
- **不引入第二份状态源**：看板是事实日志的读模型；演示数据只是后端不可达时的本地替身，界面会明确标注。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.html` | 结构、控件、抽屉骨架 |
| `styles.css` | light theme、扁平、无渐变/阴影 |
| `mock.js` | 演示数据（3 个项目 / 9 泳道 / 因果链 / 事实流片段） |
| `app.js` | 状态、接口探测、渲染、交互、重放 stepper、SSE |
