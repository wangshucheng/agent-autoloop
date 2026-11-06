# Super-Agent Runtime · macOS 迁移交接文档

> **文档性质**：正式交接契约（签收依据）。
> **配套操作手册**：`HANDOFF_MACOS.md`（逐步命令与验证清单）。本文负责「交接什么、验收什么、风险与责任」；手册负责「怎么做」。
> **权威位置**：fork 仓库 `feat/super-agent-runtime` 分支的 `super-agent/docs/MAC_MIGRATION_HANDOFF.md`。主工作区 `docs/` 下的同名文件为交付副本。

## 文档控制

| 项 | 值 |
| --- | --- |
| 文档版本 | v1.0 |
| 编制日期 | 2026-11-06 |
| 编制方 | 开发侧（Windows 本机） |
| 接收方 | macOS 目标机接手人 |
| 状态 | 待接收方签收 |
| 仓库 | `wangshucheng/agent-autoloop`（`KKKKhazix/agent-autoloop` 的 fork） |
| 分支 | `feat/super-agent-runtime` |
| 上游基线 | `f25ce4a` |
| 编制时 HEAD | `d5c4e9a`（交付后以 `git log -1` 为准） |
| 许可 | MIT（与两个上游仓库一致，保留 LICENSE） |
| 正式基线 | GitHub Actions `check.yml`，`ubuntu-latest` + `macos-latest` 双矩阵 |

## 0. 阅读指引

| 角色 | 必读章节 |
| --- | --- |
| 接手人（首次上机） | §1、§3、§4、§6、§7、附录 A/B |
| 评审 / 签收人 | §1、§3、§7、§8、§9、§12 |
| 后续开发者 | §2、§5、§10、§11、附录 C/D |

---

## 1. 交接摘要（一页纸）

**做了什么**：以 `agent-autoloop`（MIT、Node 24、零运行时依赖、单条只追加事实日志）为 fork 底座，移植 `dsh-superagent-prototype` 的领域模型与设计思想，建成一个事件驱动、多项目、最小注意力占用的 Super-Agent 运行时。M0–M4 共 11 个交付提交，代码只在新增文件里，底座原有 handler 语义与 `/v1` 协议保持不变。

**没做什么**：没有写需要真实凭据或目标平台才能验证的伪实现。唯一未完成项是 **M4 第二批第 4 项：WSL → macOS 迁移压测**（§8），需要在目标机执行。

**接收方要做的三件事**：

```bash
gh repo clone wangshucheng/agent-autoloop super-agent-auto-loop-runtime
cd super-agent-auto-loop-runtime && git checkout feat/super-agent-runtime
bash super-agent/scripts/bootstrap-macos.sh                 # 预检 + 配置 + 绿色基线
node --disable-warning=ExperimentalWarning bin/agent-autoloop.ts init --port 3350
```

然后按 §7 逐项验收、按 §8 完成压测、按 §12 回传签收。**不要加载 `deploy/com.superagent.runtime.plist`**（§6.5）。

**判定标准**：§7 全部通过 + §8 六步完成 + 双矩阵 CI success = 迁移完成。

---

## 2. 背景与架构边界

### 2.1 项目定位

以底座的单条只追加事实日志为唯一真相，用投影提供读模型；LLM（DeepSeek）、Webhook、飞书、SQLite 连接一律在 host 层；内核 L0 零 I/O、零时钟、零随机数。共同理念的可度量形式是「占用最少的人的注意力」——注意力预算、一次一个具体问题、健康状态不占版面、瞬时错误连续 3 次才升级、同一根因只发一张卡。

### 2.2 为什么迁移

| 维度 | Windows 开发机（源） | macOS 目标机（生产） |
| --- | --- | --- |
| 定位 | 设计与编码、静态验证 | 长稳运行、真实通道、验收 |
| 限制 | `wsl.exe` 被安全策略禁止；无 POSIX 服务管理 | 无此限制 |
| 验证方式 | 纯内核 + 类型检查 + 模拟；完整行为交 CI | 完整 `npm test` + launchd + 备份/恢复 + 24h 长稳 |
| 已知假象 | CRLF 导致 `format:check` 全红；`EPERM` 删临时目录；`ERR_UNSUPPORTED_ESM_URL_SCHEME`；缺 codex 导致 `npm test` 失败 | 均不存在 |

因此**本机结果不作为判定依据**，正式基线一直是 CI 双矩阵；到 Mac 后由本地完整套件接过判定权。

### 2.3 不可协商的红线（后续开发同样适用）

1. 单条只追加事实日志是唯一真相；`commit()` 唯一写日志、`evolve()` 唯一写投影；不搬 dsh 的 SQLite 聚合存储。
2. 内核 L0 零 I/O、零时钟、零随机数；LLM / Webhook / 飞书 / SQLite 连接都在 host 层。评估结论以 `eval.decided` 事实回写，回放不重跑模型。
3. `/v1` 已有路径、字段、鉴权、插件约定、`rules.json` 旧语义保持兼容；新能力一律用可选字段、新事实类型、新 `/v1/super/*` 端点。
4. 外部文字永远 `taint: external`，只进只读资料；`to/cwd/skill/access/emits/agent/answerers` 只由本机规则决定。
5. 一个状态一个写者；角色接口用 `Pick<Engine>` 收窄；请求用祈使动词，适配器上报用过去式。
6. 挂起期间零 Agent 进程、零 Token；唤醒前按当前 Policy 复验 Mandate；授权可立即撤销。
7. fork/断点只在分支日志生效，生产 main 只读、永不回滚。
8. 多项目用 `project_id` 命名空间隔离，不启多实例；不记录模型调用明细、不让模型生成审计摘要。

---

## 3. 交付物清单

### 3.1 里程碑与提交链

| 提交 | 里程碑 | 关键产物 |
| --- | --- | --- |
| `f25ce4a` | 上游 main 基线 | — |
| `b8e70cb` | 设计与前端 | 6 份设计文档、配置/Schema 示例、11 个代码模板、零依赖可交互前端 |
| `533e38f` | M0 基线 + M1 纯内核 | `.nvmrc`、4 个 L0 组件 + 五问组合器、31 项单测、`M0_BASELINE.md` |
| `7449686` | 格式修复 | 修第一提交 8 个模板文件的 prettier 问题（首次 CI 暴露） |
| `f75ac13` | M2 只读控制平面 | `approvals`/`grants` 投影表、4 个 host 组件、SSE、16 项单测 |
| `e23db75` | M3 写命令与评估旁路 | 5 类显式命令、`eval.decided` 回写、分支调试、20 项单测 |
| `d4e0373` | M4 第一批 | 配置拆分 `rules.json`/`super.json`、运行时接真实配置、前端 owner key、10 项单测 |
| `1cff38c` | M4-2-1 健康闭环 | `HealthPlane` + `HealingActor`、L4 卡、14 项单测 |
| `368558b` | M4-2-2 物化投影 | `board_items` 投影表、等价性与回放一致性、9 项单测 |
| `20dd355` | M4-2-3 底座原生桥接 | Webhook / 飞书卡片 / 定时 / 多项目接线、13 项单测 |
| `d5c4e9a` | 移交准备 | 端口统一 3350、LaunchAgent 冲突警告、macOS 引导、9 项静态守卫 |

**合计**：11 个交付提交；绿色回归子集从 63 项增长到 **190 项**；`test:sim` 20000 步每次通过。

### 3.2 CI 记录（均为双矩阵 success）

| Run | 对应交付 |
| --- | --- |
| `42021872381` | M0/M1（格式修复后） |
| `42032246684` | M2 |
| `42036512095` | M3 |
| `42041668335` | M4 第一批 |
| `42044645583` | 健康闭环 |
| `42182499252` | 物化投影 |
| `42184474914` | 底座桥接 |
| `42186090477` | 移交准备（**编制时最新，双矩阵 success**） |

> `check.yml` 只在 `main` push / PR 时自动触发；本分支历次均用 `workflow_dispatch` 手动触发。接手人若开 PR 即可自动触发。

### 3.3 文件地图

| 位置 | 内容 |
| --- | --- |
| `kernel/fact.ts`、`approval.ts`、`excitation.ts`、`grants.ts`、`five-questions.ts` | L0 纯函数；`evolve.ts` 仅 3 类最小增量（TABLES/indexes/keyOf），`runtime.ts` 仅加 `publish()` |
| `host/super-api.ts` | `/v1/super/*` 控制平面（只读 + 命令 + 调试 + 桥接）；`host/http.ts` 仅 +1 行挂载（41 行 ≤ 50） |
| `host/super-{commands,assessor,blackboard,eventstore,watchdog,health,config,projection,bridge}.ts` | L1 host 组件 |
| `tests/super-agent-*.test.ts` | 190 项回归中的 super 部分；`super-agent-handoff.test.ts` 是静态守卫 |
| `super-agent/docs/` | 6 份设计文档 + M0/M2/M3/M4 系列 + `HANDOFF_MACOS.md` + 本文 |
| `super-agent/config/` | `rules.example.json`（底座原生字段）、`super.example.json`（`super.*`） |
| `super-agent/scripts/` | `dev-wsl.sh`（Linux）、`bootstrap-macos.sh`（macOS） |
| `super-agent/web/` | 零依赖静态前端（仪表盘 + Blackboard + 因果链 + SSE） |
| `super-agent/deploy/` | 可选 LaunchAgent 模板、WSL systemd 参考单元 |
| `super-agent/src/` | 仅剩 `domain/ports.ts`、`web/api.ts` 两份契约文件 |

> 主工作区根目录另有一套早期设计副本（`docs/`、`src/`、`deploy/`），**不是交付物**；以 fork 仓库内的 `super-agent/` 为准。

---

## 4. 环境差异矩阵（源 → 目标）

| 维度 | 源（Windows 开发机） | 目标（macOS） | 迁移动作 / 判定 |
| --- | --- | --- | --- |
| Node | 系统 `v22.22.2`；用 `.tools/node-v24.22.2-win-x64` PATH 切换 | Homebrew `node@24` 默认**不在 PATH** | `export PATH="$(brew --prefix node@24)/bin:$PATH"`；`.nvmrc` = 24；`bootstrap-macos.sh` 自动定位绝对路径 |
| 换行符 | `core.autocrlf=true` → 工作区 CRLF | LF | 本机 `format:check` 191 文件告警是假象；CI/Mac 为绿，不要为迁就本机改底座格式配置 |
| 路径 | `C:\...` / Git Bash | POSIX `/Users/...` | 不要把 Windows 路径带进配置；plist 用占位符渲染 |
| 服务管理 | 无 launchd/systemd；WSL 被安全策略禁止 | `launchd` LaunchAgent | 用底座 `init` 自装服务；勿加载第二份 plist |
| 文件权限 | `chmod 0700` 无 POSIX 语义；`EPERM` 删临时目录 | 正常 POSIX | `backup.test.ts` / `helpers.ts` 在 CI/Mac 为绿 |
| ESM URL | 绝对路径触发 `ERR_UNSUPPORTED_ESM_URL_SCHEME` | `file://` 正常 | `format.test.ts` 在 CI/Mac 为绿 |
| 外部 Agent CLI | 缺 codex，`npm test` 无法完整跑 | 需已登录 CLI | 完整 `npm test` 需要 CLI；CI 由 `install-smoke.sh` 提供；引导脚本默认跳过，`SUPER_FULL_TEST=1` 开启 |
| SQLite / 投影 | 相同 | 相同 | 投影可重建；日志只追加、永不回滚 |
| 网络 | 代理偶发 502（push 需重试） | 正常 | 与代码无关 |
| 端口 | 早期文档写 8787（已修） | `3350` | 全仓统一 3350，`super.json` 的 `hub.listen` 为 `127.0.0.1:3350` |

---

## 5. 迁移前检查（源端，已完成）

- [x] 分支 `feat/super-agent-runtime` 的全部提交已推送，远端 HEAD 与本地一致（`d5c4e9a`）。
- [x] 最新 CI 双矩阵 success（`42186090477`）。
- [x] 绿色回归 190/190、typecheck 0、prettier 全绿、`test:sim` 20000 步通过。
- [x] 两个引导脚本 `bash -n` 通过，引用的测试文件全部存在（静态守卫）。
- [x] 两份示例配置分别通过各自的解析器（`parseRules()` / `parseSuperConfig()`）。
- [x] plist 可被 XML 解析、含冲突警告、无硬编码用户路径。
- [x] **凭据未写入仓库**：owner key、Webhook secret、飞书 channel key、DeepSeek key 全部留待目标机配置。

### 目标机需自备的凭据（不进仓库）

| 凭据 | 用途 | 生成/配置位置 |
| --- | --- | --- |
| owner key | 所有 `/v1/super/*` 写命令 | `agent-autoloop key new owner <name>`；前端 banner 填写 |
| source key / Webhook secret | `/v1/in/:source` 验签 | `~/.agent-autoloop/secrets.env`（`AGENT_AUTOLOOP_SECRET_*`） |
| 飞书 channel key | `plugins/feishu/channel.ts` 拉取卡片 | `~/.agent-autoloop/config.json` / lark-cli |
| DeepSeek API key | **主会话侧**评估调用 | 主会话环境；运行时不读取、不落盘 |
| GitHub 凭据 | clone / 触发 CI | `gh auth login`（仅开发侧，不进运行时） |

---

## 6. 迁移执行步骤

### 6.1 代码

```bash
brew install node@24 git
export PATH="$(brew --prefix node@24)/bin:$PATH"
gh repo clone wangshucheng/agent-autoloop super-agent-auto-loop-runtime
cd super-agent-auto-loop-runtime && git checkout feat/super-agent-runtime
git log -1                       # 记录 SHA 用于签收
```

### 6.2 运行时与基线

```bash
bash super-agent/scripts/bootstrap-macos.sh
```

脚本完成：Node ≥24 / git / curl 检查 → `~/.agent-autoloop`（0700）及子目录 → **不覆盖**地写两份配置 → `npm ci` / `format:check` / `typecheck` → M0–M4 绿色子集 → `test:sim` → 打印下一步。完整 `npm test` 默认跳过（需已登录 Agent CLI）。

### 6.3 配置分工（务必分清）

| 文件 | 读取方 | 约束 |
| --- | --- | --- |
| `~/.agent-autoloop/rules.json` | 底座 `protocol/rules.ts` | **只含原生字段**；`checkFields()` 拒绝任何未知键。示例已用 `parseRules()` 验证 |
| `~/.agent-autoloop/super.json` | `host/super-config.ts` | 承载 `super.*`（accept_mode、projects、eval、watchdog、attention、schedule、bindings）；缺文件=零配置默认，坏 JSON 明确报错 |

`bindings.sources` 把来源映射到 `project_id`；`bindings.channels` 把项目映射到底座通道；`schedule` 由底座 `kernel/cron.ts` 解析。

### 6.4 状态数据

| 数据 | 位置 | 迁移原则 |
| --- | --- | --- |
| 事实日志（`facts`） | `~/.agent-autoloop/hub.db` | 唯一真相，只追加；迁移用 `agent-autoloop backup` / `restore`，不手工改 |
| 投影（`projections`） | 同库 | 可从日志重建（`format` 指纹变化会自动 rebuild），不是真相 |
| `board_items` / `approvals` / `grants` | 同库 | 由 `evolve()` 从 `fact.changes` 写；历史事实无 `board_items` change，重建时不产生历史看板项（预期行为） |
| 密钥 / 配置 | `keys`、`config.json`、`rules.json`、`super.json`、`secrets.env` | 权限 0600；`backup`/`restore` 一并带走 |
| 分支日志 | `facts_branch` | 只在分支调试用，生产 main 永不被 host 写 |

### 6.5 服务（**最易出错**）

```bash
node --disable-warning=ExperimentalWarning bin/agent-autoloop.ts init --port 3350
```

底座 `init` 会自行写 `~/Library/LaunchAgents/agent-autoloop.plist`（label `agent-autoloop`），`RunAtLoad` + `KeepAlive` 拉起 `up`，plist 内用 `process.execPath` 钉住 Node 与 `PATH`。**因此必须用 node@24 执行 init**。

`host/up.ts:lock()` 会拒绝第二个 `up`。所以：

- ✅ 支持路径：用底座 `init` 装的服务。
- ❌ 不得同时加载 `super-agent/deploy/com.superagent.runtime.plist`。
- ⚠️ 仅在明确 `init --no-service` 且已停用底座服务时，才用 `bootstrap-macos.sh render-plist` 渲染占位符模板自行管理 launchd。

---

## 7. 验收标准（逐项勾选）

| # | 验收项 | 命令 / 判定 | 期望 |
| --- | --- | --- | --- |
| 1 | Node 版本 | `node --version` | `v24.x` |
| 2 | 依赖与静态检查 | `npm ci && npm run format:check && npm run typecheck` | 全绿 |
| 3 | 绿色回归 | `bootstrap-macos.sh` 内的 16 个测试文件 | **190/190** |
| 4 | 随机模拟 | `npm run test:sim` | 20000 步通过 |
| 5 | 服务已装 | `launchctl print gui/$(id -u)/agent-autoloop` | 存在且运行 |
| 6 | 底座协议未变 | `curl -s http://127.0.0.1:3350/v1/state` | 200，字段与上游一致 |
| 7 | 只读端点 | `/v1/super/{overview,blackboard,health,health/actions,schedule,channels,projects/routes,policy}` | 均 200，`ok:true`，envelope 含 `data/now/policy_version` |
| 8 | 因果链与注意力 | `/v1/super/trace/:id`、`/attention?window=24h` | `verdict` 与计量合理 |
| 9 | SSE | `/v1/super/stream?after=0` | `text/event-stream`，`event: fact` 帧 |
| 10 | 写命令鉴权 | 带/不带 owner key 调 `POST /v1/super/health/report` | 带 200；不带 `401 writes_require_owner_key` |
| 11 | 命令幂等 | 同一审批重复回答 / 同一 key 重复投递卡片 | `409 already_resolved` / `duplicate:true` |
| 12 | 指令字段拒收 | 命令体带 `cwd` 或 `agent` | `400 instruction_field_rejected`，且不写事实 |
| 13 | 前端 | 打开 `super-agent/web/index.html`，API 地址 `http://127.0.0.1:3350` | 切真实数据、SSE 运行、健康面板默认折叠 |
| 14 | 投影一致性 | `sim/invariants.ts` / 备份恢复后对比 | 日志与投影一致，回放不重跑模型 |
| 15 | 数据保护 | 响应体中检索 `key_hash` / `master_key` / `prompt_text` 等 | 不出现（出口 scrub） |

---

## 8. 剩余工作：WSL → macOS 迁移压测

这一项**不需要新代码**，只缺目标平台。按顺序执行并记录结果：

| # | 步骤 | 判定标准 |
| --- | --- | --- |
| 1 | `npm test`（完整套件，需已登录 Agent CLI） | 全绿；若因 CLI 缺失失败，注明是环境而非回归 |
| 2 | `node --disable-warning=ExperimentalWarning sim/crash.ts 1000 12648430`、`sim/mutate.ts` | 不变量不破 |
| 3 | `sh scripts/install-smoke.sh` | 与 CI 同款通过 |
| 4 | `launchctl kickstart -k gui/$(id -u)/agent-autoloop` | `up` 重启后 `hub.db` 投影与日志一致 |
| 5 | `agent-autoloop backup <dir>` → `agent-autoloop restore <dir>` | WAL 与 key 完好，状态可还原 |
| 6 | `npm run test:nightly` 或 24h 观察 + 触发一次双矩阵 CI | 无重复卡片、挂起期间零 Agent 进程/零 Token、CI 与本地结论一致 |

---

## 9. 风险登记与缓解

| ID | 风险 | 影响 | 概率 | 缓解 / 责任 |
| --- | --- | --- | --- | --- |
| R1 | 同时加载两份 LaunchAgent | `up` 抢锁，服务起不来 | 高 | 用底座 `init`；plist 仅可选模板并已加醒目警告；`super-agent-handoff.test.ts` 守卫。**接手人** |
| R2 | `init` 用了错误 Node（非 24） | LaunchAgent 钉住错误二进制 | 中 | `bootstrap-macos.sh` 用 `brew --prefix node@24` 定位并 export PATH。**接手人** |
| R3 | 端口写错（8787） | 前端连不上后端 | 已消除 | 全仓统一 3350 + 静态守卫。**已完成** |
| R4 | 完整 `npm test` 缺 Agent CLI | 误判为回归 | 中 | 标注为环境限制；CI 由 `install-smoke.sh` 提供；`SUPER_FULL_TEST=1` 可选。**接手人** |
| R5 | 历史事实无 `board_items` change | 重建后缺历史看板项 | 低 | 属「日志是唯一真相」的预期行为，不做回填伪造。**已记录** |
| R6 | 未配置 owner key | 写命令全部 401 | 中 | `key new owner` 并在前端 banner 填写。**接手人** |
| R7 | 代理 502 | push 偶发失败 | 低 | 重试即可（历史上已发生两次，均重试成功）。**开发侧** |
| R8 | 投影格式指纹变化 | 启动时重建投影 | 低 | `evolve.ts` 变更会触发 `rebuild`，属预期；不要手工改 projections |
| R9 | 把 Windows CRLF 假象当成回归 | 误改底座测试/格式配置 | 低 | 见 `M0_BASELINE.md §4`；以 CI/Mac 结果为准 |

---

## 10. 回滚与应急

| 场景 | 动作 |
| --- | --- |
| 代码回滚 | `git checkout <前一提交>` 或新建 revert 提交；**不要** `reset --hard` 到已推送历史 |
| 服务异常 | `launchctl bootout gui/$(id -u)/agent-autoloop`；检查 `~/.agent-autoloop/logs/up.log`；必要时 `agent-autoloop up` 前台定位 |
| 投影损坏 | 投影可从日志重建；用 `agent-autoloop backup/restore`，或让 format 指纹变化触发 rebuild |
| 配置改错 | 两份配置由引导脚本「不覆盖」写入，保留 `.bak` 后替换；`rules.json` 改错会让底座启动失败，用 `parseRules()` 先校验 |
| **事实日志** | **永不回滚**；生产 main 只读，fork/断点只在分支日志生效 |

---

## 11. 交接后的维护约定

- 新增能力一律用可选字段、新事实类型、新 `/v1/super/*` 端点；不改 `/v1` 已有路径与鉴权。
- 任何 `kernel/*.ts` 顶层文件都会受 `tests/purity.test.ts` 扫描：不得含 vendor 名、网络请求、`Date.now`/`Math.random`/`process.env`/`node:fs`、越权写投影。
- 根目录不得出现 `web/`（同一测试断言）；前端留在 `super-agent/web/`。
- `host/http.ts` 必须保持 ≤ 50 行（现 41 行）。
- `sim/invariants.ts` 的回放 oracle 从 `TABLES` 派生；新增投影表不要硬编码表清单。投影行不能带 `undefined` 值键（JSON 落库会丢弃，导致 oracle 不一致）。
- 扩展配置放 `super.json`，**绝不能**塞进 `rules.json`。
- 每次推送后手动触发双矩阵 CI（或开 PR 自动触发），把结论回填对应里程碑文档。

---

## 12. 回传与签收

接收方完成 §7 与 §8 后，回传以下内容即可签收：

1. `git log -1` 的提交 SHA 与 `gh run list` 中最新 CI run 的结论/链接。
2. §7 十五项的勾选结果（逐项通过 / 未通过 + 原因）。
3. §8 六步的命令输出摘要，尤其是 `npm test`、`install-smoke.sh`、`kickstart`、`backup/restore` 的结果。
4. 任一失败项的完整日志；若因 Agent CLI 缺失，明确标注「环境」而非「回归」。
5. 凭据配置状态（只需说明已配置/未配置，**不要回传任何密钥明文**）。

**签收判定**：§7 全通过 + §8 六步完成 + 双矩阵 CI success。签收后 M4 收口，项目进入 M5（生产长稳与真实通道运营）。

---

## 附录 A · 命令速查

```bash
# 环境
export PATH="$(brew --prefix node@24)/bin:$PATH"
node --version                          # v24.x

# 代码与基线
gh repo clone wangshucheng/agent-autoloop super-agent-auto-loop-runtime
cd super-agent-auto-loop-runtime && git checkout feat/super-agent-runtime
bash super-agent/scripts/bootstrap-macos.sh
npm run typecheck && npm run test:sim

# 服务（底座自装 LaunchAgent）
node --disable-warning=ExperimentalWarning bin/agent-autoloop.ts init --port 3350
node --disable-warning=ExperimentalWarning bin/agent-autoloop.ts key new owner mac
launchctl print gui/$(id -u)/agent-autoloop

# 验证
P=3350
curl -s http://127.0.0.1:$P/v1/state
curl -s http://127.0.0.1:$P/v1/super/overview
curl -s http://127.0.0.1:$P/v1/super/blackboard
curl -s http://127.0.0.1:$P/v1/super/health
curl -s http://127.0.0.1:$P/v1/super/health/actions
curl -s http://127.0.0.1:$P/v1/super/schedule
curl -s http://127.0.0.1:$P/v1/super/channels
curl -s http://127.0.0.1:$P/v1/super/projects/routes

# 可选：自己管 launchd（先 init --no-service 并停用底座服务）
bash super-agent/scripts/bootstrap-macos.sh render-plist
```

## 附录 B · `/v1/super/*` 端点全表

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/overview?project=` | loopback 免 key | 仪表盘三问 |
| GET | `/blackboard?project=` | 同上 | 9 泳道（读 `board_items` 投影） |
| GET | `/projects` | 同上 | 项目聚合 |
| GET | `/projects/routes` | 同上 | 项目 → 来源/通道/收件人/并发/定时 |
| GET | `/channels` | 同上 | 底座 `rules.json` 通道 |
| GET | `/schedule` | 同上 | 定时任务下次触发 |
| GET | `/health` | 同上 | HealthBoard 状态 + 动作 + L4 卡 |
| GET | `/health/actions` | 同上 | 动作日志与人工卡 |
| GET | `/attention?window=` | 同上 | 注意力计量 |
| GET | `/policy` | 同上 | 版本 / accept_mode / paused |
| GET | `/grants`、`/grants/:id` | 同上 | 授权投影 |
| GET | `/approvals` | 同上 | 审批投影 |
| GET | `/eval/pending`、`/eval/:id` | 同上 | 评估候选卡与状态 |
| GET | `/branches`、`/breakpoints?branch=` | 同上 | 分支调试读模型 |
| GET | `/trace/:id` | 同上 | 完整因果链 |
| GET | `/stream?after=&project=` | 同上 | SSE，帧为 `event: fact` |
| POST | `/approvals/:id/answer` | **owner key** | 审批回答（幂等） |
| POST | `/grants/:id/revoke` | **owner key** | 撤销授权 |
| POST | `/eval/:id/decision` | **owner key** | 评估结论回写（无模型明细） |
| POST | `/policy/save` | **owner key** | CAS 保存策略 |
| POST | `/processing/pause` | **owner key** | 暂停/恢复 |
| POST | `/health/report` | **owner key** | 组件主动上报健康 |
| POST | `/health/check` | **owner key** | 显式全量自愈评估 |
| POST | `/ingress/:source` | **owner key** | 已验签事件 → super 事实 |
| POST | `/cards/deliver` | **owner key** | 卡片进底座卡片池 |
| POST | `/fork`、`/replay`、`/breakpoints` | **owner key** | 分支调试 |
| POST | `/branches/:name/facts` | **owner key** | 只写分支日志 |

响应统一 `Envelope<T>`：`{ ok, data, now, policy_version }`；错误 `{ ok:false, error:{code,message}, now }`。命令体 7 个指令字段一律拒收；响应出口递归擦除 `key_hash` / `run_token` / `card_link_token` / `master_key` / `prompt_text` / `credentials` / `model_call_details`。

## 附录 C · 文档索引

| 文档 | 读它的理由 |
| --- | --- |
| `00-总纲.md` … `05-WSL到macOS部署与路线图.md` | 架构总纲、上游源码映射、事件内核/回放/审计、策略组件、Watchdog 与 Web 预留接口、路线图 |
| `M0_BASELINE.md` | Windows 平台假象的完整分类、正式基线判定 |
| `M2_READONLY_PLANE.md` | 投影表扩展、只读端点、同源/鉴权 |
| `M3_COMMANDS_AND_ASSESSMENT.md` | 写命令契约、评估旁路、不记模型明细的保证 |
| `M4_CONFIG_AND_FRONTEND.md` | 配置拆分（`checkFields` 拒绝未知字段）、前端 owner key |
| `M4_HEALTH_CLOSED_LOOP.md` | 健康闭环与 `HealingActor` 扩展点 |
| `M4_MATERIALIZED_PROJECTION.md` | 物化投影、等价性与回放一致性 |
| `M4_UPSTREAM_BRIDGE.md` | 用底座原生插件/cron 接线的四项 |
| `HANDOFF_MACOS.md` | **操作手册**：逐步命令与验证清单 |
| 本文 | **交接契约**：交付物、验收、风险、回滚、签收 |

## 附录 D · 术语

| 术语 | 含义 |
| --- | --- |
| 事实日志 / `facts` | 只追加的唯一真相；`commit()` 是唯一写者 |
| 投影 / `projections` | 由 `evolve()` 从事实 `changes` 构建的读模型，可重建 |
| L0 / L1 | L0 = 内核纯函数（零 I/O/时钟/随机数）；L1 = host 层（时钟、网络、SQLite） |
| Mandate / Grant | 不可变授权；唤醒前必须按当前 Policy 复验，可立即撤销 |
| 注意力预算 | `max_cards_per_owner_per_hour`、`一次一个具体问题`、`observe` 默认只记录 |
| `taint: external` | 外部文字只读资料标记，沿因果链继承（I8），不可洗白 |
| `eval.decided` | 主会话评估结论事实，只带 `policy_version` + `reason` |
| `board_items` | 看板物化投影表，由 `withBoardChange()` 在 commit 前附加 change |
| 绿色回归子集 | 平台无关、不需外部 CLI 的 190 项测试；完整 `npm test` 另需已登录 Agent CLI |

---

_编制：开发侧（Windows） · 待接收方签收 · 许可 MIT_
