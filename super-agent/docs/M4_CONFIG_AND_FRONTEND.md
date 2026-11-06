# M4 第一批：配置落地与前端鉴权

记录时间：2026-11-05。前置：M0/M1/M2/M3 全部落地，四次 CI 双矩阵均 success（最后一次 run `42036512095`）。

## 1. 修掉一个会让中台无法启动的缺陷

`protocol/rules.ts` 的 `checkFields()` 明确写着「no others: a misspelt field would otherwise be silently ignored」，会遍历 `Object.keys(value)` 拒绝任何未声明字段。而 M0 交付的 `config/rules.example.json` 把整个 `super` 段塞在 `rules.json` 里，此外还有 `sources.*.project`、`channels.*.use`、`rules[].project`、`rules[].approval` 四处扩展字段。**这份示例配置直接当 `rules.json` 用会让中台启动失败**：

```
rules.json 有不认识的字段 super
来源 github 有不认识的字段 project
通道 feishu / desktop 有不认识的字段 use
规则「每日早报」有不认识的字段 project / approval
...
```

设计里 `/v1` 与 `rules.json` 的旧语义必须保持兼容，因此**不能**去放宽底座校验器，只能把扩展配置搬出去。

### 拆分结果

| 文件 | 内容 | 校验方 |
| --- | --- | --- |
| `config/rules.example.json` | 只保留 `timezone / askFirst / sources / agents / channels / rules / elsewhere` | 底座 `parseRules()`，单测验证 3 条规则全部通过 |
| `config/super.example.json` | 原 `super` 对象作为根，外加 `bindings`（记录被搬走的 source / rule 扩展元数据） | `host/super-config.ts` 的 `parseSuperConfig()` |

`scripts/dev-wsl.sh` 现在复制两份文件：`rules.json` 与 `super.json`，且都不覆盖已有文件。缺失 `super.json` 是合法的零配置安装，运行时使用默认值；但 `super.json` 若是坏 JSON 会明确报错。

> `web.reserved_api_prefix` 保留在示例里作为文档，但**不参与路由**：`/v1/super` 是协议常量，改它会破坏前端契约，`parseSuperConfig()` 强制返回该常量。

## 2. `host/super-config.ts`

纯解析层，零 I/O 依赖（只有 `loadSuperConfig()` 读文件）：

- `parseSuperConfig(raw)` 宽容合并默认值：未知键忽略、枚举非法值回落、数值越界回落、projects 逐项规范化、`bindings` 过滤非对象值。
- `loadSuperConfig(path)`：文件不存在返回默认；坏 JSON 抛明确错误。
- `superConfigPath(home)` → `<home>/super.json`；`capacityFor(config, projectId)` 供看板取项目并发上限。
- 不把 master key、owner key 或任何凭据放进这个文件；`eval.provider` / `eval.model` 属于主会话侧，运行时不读取、不落盘。

## 3. `liveDeps()` 接真实配置

M3 里所有硬编码常量改为从 `super.json` 读：

| 原来 | 现在 |
| --- | --- |
| `DEFAULT_ASSESSOR_CONFIG` | `config.assessor`（`enabled` / `accept_mode` / `timeout_ms` / `max_retries`） |
| `new HealthBoard()` 固定阈值 3 | `config.watchdog.transient_failure_threshold` |
| 固定 claim 三个组件 | `config.health_components` |
| `DEFAULT_MAX_FACTS = 5000` | `config.max_facts`（`AGENT_AUTOLOOP_SUPER_MAX_FACTS` 环境变量可覆盖） |
| `accept_mode: "observe"` 硬编码 | `config.accept_mode` |
| `overviewOf` 的 `worker_capacity: 4` | `capacityFor(config, project)` |

`health()` / `suppressed()` 仍是实时 HealthBoard；新增的 `report()` 辅助函数只在组件确实被 claim 时上报，避免自定义 `health_components` 时抛错。

## 4. 前端 owner key 与 SSE

M3 留下一个用户可感知的缺口：所有写命令要 owner key，但前端不带 `Authorization` 头，真实模式下批准/拒绝只会收到 401。M4 第一批补齐：

- `web/index.html` banner 增加 `Owner key` 密码输入框；`styles.css` 复用现有输入样式。
- `app.js` 的 `fetchJSON()` 构造独立的 `init.headers`，自动注入 `Authorization: Bearer <key>`，并保留调用方原有的 `Content-Type`；密钥只在浏览器内存，不进 URL、不进 localStorage。
- `input` 事件实时同步 `state.ownerKey`；「连接后端」与「重连」都会读取输入框。live 模式 banner 明确提示「写操作需要 owner key」或「已带 owner key」。
- **SSE 改走 `GET /v1/super/stream?after=`**：`EventSource` 无法发送自定义 header，而底座 `/v1/stream` 需要 owner key；super 流在 loopback 只读免 key。同时监听 `event: fact`（后端发的帧带该事件名）与默认 `onmessage`。
- 连接成功时把 `lastSeq` / `factCount` 归零，避免演示数据的大序号让真实事实永远推不出来。

单测用 `node:vm` + 最小 DOM 桩真正执行 `mock.js` + `app.js`：验证启动探测、live 模式 SSE URL、以及填入 key 后重连请求带上了 `Authorization`。

## 5. 验证

| 检查 | 结果 |
| --- | --- |
| `config/rules.example.json` 经底座 `parseRules()` | ✅ 3 条规则全部通过 |
| `config/super.example.json` 经 `parseSuperConfig()` | ✅ 3 个项目、bindings 完整 |
| `npm run typecheck` | ✅ exit 0 |
| `prettier --check` 新增/改动文件 | ✅ |
| `tests/super-agent-m4.test.ts` | ✅ 10/10（含前端 vm 冒烟） |
| M1 + M2 + M3 + M4 合并绿色回归子集（purity / ci-scope / cron / M1 / M2 / M3 / M4 / kernel / hops / projection / schema） | ✅ **145/145** |
| `npm run test:sim` 20000 步 | ✅ 30.3s / 1644 completed |
| `host/http.ts` 行数 | 41 ≤ 50（架构断言） |
| `node --check` 前端 app.js / mock.js | ✅ |
| CI 双矩阵 | ✅ run `42041668335`：`ubuntu-latest` + `macos-latest` **全部 success** |

## 6. M4 第二批进度

1. ✅ **组件主动上报 + 自愈动作接口**：已做成**不依赖外部系统**的可测闭环，见 `M4_HEALTH_CLOSED_LOOP.md`。
2. ✅ **看板物化投影**：`overview` / `blackboard` 改读 `board_items` 投影表，纯命令层契约零改动，等价性与回放一致性均有单测，见 `M4_MATERIALIZED_PROJECTION.md`。

以下仍是**必须依赖外部系统或目标平台**才能验证的工作，不做伪实现：
3. **Webhook / 飞书卡片 / 定时 / 多项目生产接线**：需要真实凭据、回调地址与飞书应用配置。
4. **WSL → macOS 迁移压测**：本机 `wsl.exe` 被安全策略禁止，需要用户在安全中心解禁或在 macOS 上执行 `deploy/com.superagent.runtime.plist`。

红线不因这些待办而放宽：不记录模型调用明细、不让模型生成审计摘要；外部文字始终 `taint: external`；挂起零 Agent 进程零 Token；授权可立即撤销；一个状态一个写者；生产 main 只读、永不回滚。
