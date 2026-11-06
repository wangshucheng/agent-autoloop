# M2：只读控制平面

记录时间：2026-11-05。前置：M0 基线（CI 双矩阵 success）、M1 纯内核（31 项单测）。

## 1. M2 做了什么

把设计稿里的「仪表盘 + Blackboard 看板 + 因果链 + 回放/断点」从纸面模板变成**真正能跑的只读后端**，并让已交付的可交互前端可以连上真实数据。

**M2 不写事实日志、不写投影、不跑 Agent、不调模型。** 所有写命令端点统一返回 `405 writes_require_explicit_command`，留给 M3。`commit()` 仍是唯一写日志者，`evolve()` 仍是唯一写投影者。

### 落地清单

| 文件 | 职责 |
| --- | --- |
| `kernel/evolve.ts` | **最小增量 5 行**：`TABLES` += `approvals` / `grants`、两组索引、`keyOf` 对新表返回 `row.id`。原有 handler 语义不变 |
| `sim/invariants.ts` | 回放 oracle 的表清单改为从 `TABLES` 派生，不再硬编码 |
| `host/super-blackboard.ts` | 泳道、仪表盘三问、多项目聚合、注意力计量、因果链 `trace` |
| `host/super-eventstore.ts` | 分支注册（O(1) fork）、父前缀 + 分支本地事实、只读 replay、断点、增量流 |
| `host/super-watchdog.ts` | HealthBoard（一条目一写者）、L0–L4 自愈阶梯、同一根因只发一张卡 |
| `host/super-api.ts` | `/v1/super/*` 只读端点 + SSE + 同源/鉴权 + 敏感字段擦除 |
| `host/http.ts` | **+1 行挂载**：`(await superHandle(request)) ?? (await runtime.handle(request))`，41 行（架构测试上限 50 行） |
| `tests/super-agent-host.test.ts` | 16 项：投影表、读模型、自愈阶梯、回放断点、API 契约、SSE |

### 单一真相

M1 落地后删掉 `super-agent/src/kernel/` 副本；M2 再删掉 `super-agent/src/host/{eventstore,blackboard,watchdog}.ts`。`assessor.ts` 保留为 M3 模板。仓库里每个组件只有一份代码。

## 2. 投影表扩展的代价

`evolve()` 运行期本来就把任意 `change.table` 写入 `projections`，所以**不需要新增写路径**；扩展 `TABLES` 只是为了编译期类型、索引与 `keyOf` 的 overlay 正确性。

但扩展触发了两处真实回归，均已修复：

1. `sim/invariants.ts` 的独立回放 oracle 硬编码了 11 张表，新增两张后每条重放断言都会因快照多出 `approvals: {}` / `grants: {}` 而失败。改为 `Object.fromEntries(TABLES.map(...))`——oracle 仍不依赖 `evolve` 的写/查实现，但共享表清单，今后再加表不会重复踩坑。
2. `host/runtime.ts` 的 `format` 指纹包含 `kernel/evolve.ts` 全文，因此改它会让升级时从日志重建一次投影。这是**预期行为**（索引与表结构变了），不是回归。

`tests/format.test.ts` 依赖 `evolve.ts` 里的若干固定字符串（如 `due: [["at"]],`、`["events","runs","cards","timers"]`），本次改动全部避开，测试保持有效。

## 3. `/v1/super/*` 端点

响应统一为 `Envelope<T>`：`{ ok, data, now, policy_version }`；前端 `app.js` 的 `unwrap()` 会取 `data`。错误为 `{ ok:false, error:{code,message}, now }`。

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/v1/super/overview?project=` | 仪表盘三问：待人事项 / 健康（健康不占版面）/ 24h 活动 |
| GET | `/v1/super/blackboard?project=` | 9 条泳道，`done` 可折叠 |
| GET | `/v1/super/projects` | 从 `meta.project_id` 聚合的多项目列表 |
| GET | `/v1/super/health` | HealthBoard 全量与抑制计数 |
| GET | `/v1/super/attention?window=24h` | 卡片 / 问题 / 字数 / 每 owner 每小时卡片数 |
| GET | `/v1/super/trace/:correlation_id` | 完整因果链、`verdict`、策略版本；**无模型调用明细** |
| GET | `/v1/super/grants` · `/grants/:id` | 授权投影 |
| GET | `/v1/super/approvals` | 审批投影 |
| GET | `/v1/super/policy` | 当前策略版本与 `read_only: true` |
| GET | `/v1/super/breakpoints` | M2 返回空数组（M3 接 eventstore） |
| GET | `/v1/super/stream?after=&project=` | SSE，一次一条事实，`after` / `Last-Event-ID` 续读 |
| 任意非 GET | 上述任意前缀 | `405 writes_require_explicit_command` |

不在 `/v1/super` 前缀下的请求，`superHandle()` 返回 `undefined`，原样交给底座 `createHandler()`。`/v1` 的既有路径、字段、鉴权、插件约定**零改动**。

### 鉴权与同源

- 同源检查先行：带 `Origin` 且与请求 origin 不同 → `403 cross_origin`。双击 `index.html` 的 `file://` 页面会发 `Origin: null`，仅在 loopback 放行，保证零构建前端可用。
- loopback（`127.0.0.1` / `localhost` / `::1`）的 GET 无需 key，方便本机开发；非 loopback 必须带 `Authorization: Bearer <owner-key>`，由底座 `kernel/credentials.ts` 的 `whose(view,"owner",token)` 判定。
- **M3 实现写命令时必须把鉴权移到 405 判断之前**，并默认要求 token，不能沿用 M2 的 loopback 便利。
- 响应出口统一 `scrub()`，递归移除 `key_hash` / `run_token` / `card_link_token` / `master_key` / `prompt_text` / `credentials` / `model_call_details`。单测用带这些字段的 grant row 验证过不会外泄。

### 连接真实后端

```bash
# 1. 启动中台（默认监听 127.0.0.1:3350，端口以实际 CLI 参数为准）
AGENT_AUTOLOOP_HOME=~/.agent-autoloop node bin/agent-autoloop.ts up

# 2. 打开前端（推荐同源/本机静态服务）
cd super-agent/web && python -m http.server 8080
# 浏览器打开 http://127.0.0.1:8080，把「API 地址」设为中台地址后点「连接后端」
```

前端探测 `GET /v1/super/overview`，成功切真实数据并用 SSE 订阅；失败自动回退演示数据并明确标注。事实快照默认最多读 `AGENT_AUTOLOOP_SUPER_MAX_FACTS=5000` 条，M4 会换成物化投影，不再扫日志。

## 4. 接线中发现并修复的 4 个真实缺陷

1. **`erasableSyntaxOnly` 冲突**：底座 `tsconfig.json` 开启该选项，模板里的构造参数属性（`constructor(private readonly board: ...)`）无法通过 typecheck。已改为显式字段声明 + 构造函数赋值。
2. **回放 oracle 表清单硬编码**：见 §2，已改为共享 `TABLES`。
3. **自愈阶梯走不到 L4**：L3 分支返回 `disable_component` / `pause_processing` 但没有记录自动升级次数，`escalationsInHour()` 永远为 0，人工卡永远发不出来。已在 L3 返回前 `escalations.push(now)`，单测覆盖 L0→L1×3→L3→L4→同根因不再发卡。
4. **命令端点的错误响应误导**：loopback 无 token 的 POST 原先先撞 `401`，看起来像缺 key，实际是 M2 根本不实现写。已把 `405` 判断提到鉴权之前，响应明确指向 M3。

另外修掉了模板里的几个占位值：`overviewOf` 的硬编码 `policy_version: "P8"` / `now: 0` / `capacity: 4` 改为可注入；`replay` 的 `checksumOf` 从「JSON 字符串长度」占位改为增量因果 digest，两次重放结果一致且稳定；`fork()` 的 `new Date()` 改为注入 `now`。

## 5. 验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ exit 0（含全部 M2 新增文件） |
| `prettier --check` 新增/改动文件 | ✅ |
| `tests/super-agent-host.test.ts` | ✅ 16/16 |
| 绿色回归子集（purity / ci-scope / cron / M1 / M2 / kernel / hops / projection） | ✅ **108/108** |
| `npm run test:sim`（20000 步随机模拟） | ✅ 36.5s / 1644 completed，证明回放 oracle 改动安全 |
| `tests/schema.test.ts` | ✅ 7/7 |
| `host/http.ts` 行数 | 41 ≤ 50（架构断言） |
| Windows `rules` / `conformance` / `format` 测试 | ❌ 已知 `EPERM` 临时目录与 ESM URL 平台假象，见 `M0_BASELINE.md §4`；CI 上为绿 |
| CI 双矩阵 | ✅ run `42032246684`：`ubuntu-latest` + `macos-latest` **全部 success**，完整 `npm test` 与 `install-smoke.sh` 通过 |

## 6. M3 入口（已全部完成，见 `M3_COMMANDS_AND_ASSESSMENT.md`）

> 以下清单保留为当时的计划记录：写命令端点、Assessor 旁路、分支调试端点、HealthBoard 实时接线均已在 M3 落地。M2 的 405 与空 `health()` 已成为历史状态。

1. 实现写命令：`approvals/:id/answer`、`grants/:id/revoke`、`policy/save`、`eval/:id/decision`，全部以**显式命令**经 `commit()` 写事实；鉴权前置，loopback 便利取消。
2. 落地 `src/host/assessor.ts`：主会话 LLM 评估旁路，结论以一条 `eval.decided` 事实回写，只带 `policy_version` + `reason.code`；回放不重跑模型。
3. 把 `replay` / `fork` / `breakpoints` 接到 `/v1/super/*` 的调试端点，分支事实写入 `facts_branch`（分支日志），生产 main 保持只读、永不回滚。
4. 接 HealthBoard 的实时 `health()` 与 `suppressed()`，替换当前空实现。
5. **红线不变**：不记录模型调用明细、不让模型生成审计摘要；外部文字始终 `taint: external`；挂起零 Agent 进程零 Token；一个状态一个写者。
