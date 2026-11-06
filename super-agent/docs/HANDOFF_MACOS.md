# 移交到 macOS：交接说明与执行清单

记录时间：2026-11-06。本文档是**在一台新的 Mac 上继续本项目**的操作手册（逐步命令与验证清单）。

> **文档分工**：正式交接契约（交付物清单、验收标准、风险登记、回滚、签收）见 `MAC_MIGRATION_HANDOFF.md`；本文负责「怎么做」。此前的所有开发都在 Windows 本机完成，本机 `wsl.exe` 被安全策略禁止，因此 Linux/macOS 的行为一直由 GitHub Actions 的 `ubuntu-latest` + `macos-latest` 双矩阵 CI 验证。

## 1. 移交时的状态

| 项 | 值 |
| --- | --- |
| 仓库 | `wangshucheng/agent-autoloop`（`KKKKhazix/agent-autoloop` 的 fork） |
| 分支 | `feat/super-agent-runtime` |
| 基线提交 | `f25ce4a`（上游 main） |
| 最新提交 | 以远端 `feat/super-agent-runtime` 的 HEAD 为准（`git log -1`） |
| CI | `.github/workflows/check.yml`，Linux + macOS 双矩阵；`workflow_dispatch` 手动触发 |
| 已完成 | M0 基线、M1 纯内核、M2 只读控制平面、M3 写命令与评估旁路、M4 第一批（配置 + 前端）、M4 第二批 1–3（健康闭环 / 物化投影 / 底座原生桥接） |
| 仅余 | **M4 第二批第 4 项：WSL → macOS 迁移压测**（§6，需要目标机） |

### 代码在哪（别拿错目录）

所有实现都在 **fork 分支里的 `super-agent/` 目录 + 仓库根的 `host/super-*.ts`、`kernel/*.ts`、`tests/super-agent-*.test.ts`**：

```
super-agent/
  docs/          00-总纲 … 05-路线图、M0_BASELINE、M2/M3/M4 系列、HANDOFF_MACOS（本文）
  config/        rules.example.json（底座原生字段）、super.example.json（super.*）
  deploy/        com.superagent.runtime.plist（可选模板）、superagent-runtime.service（WSL 参考）
  scripts/       dev-wsl.sh、bootstrap-macos.sh
  web/           index.html / app.js / mock.js / styles.css / README.md
  src/           仅剩 domain/ports.ts、web/api.ts 两份契约文件
host/super-{api,commands,assessor,blackboard,eventstore,watchdog,health,config,projection,bridge}.ts
kernel/{fact,approval,excitation,grants,five-questions}.ts + evolve.ts 的 3 处增量
tests/super-agent-*.test.ts
```

> 工作区根（Windows 本机）另有一份早期设计副本 `deploy/`、`docs/`、`src/`，**不是交付物**；以 fork 仓库内的 `super-agent/` 为准。

## 2. 两个最容易踩的坑（本轮已修）

1. **端口**：底座 `agent-autoloop init` 默认 `3350`，而早期前端/文档写成 `8787`。本轮已把全仓统一为 `3350`（`web/app.js`、`web/index.html`、`web/README.md`、`M2_READONLY_PLANE.md`、全部测试桩、`super.example.json` 的 `hub.listen`）。`hub.listen` 还必须是 `主机:端口` 格式（`host/config.ts:parseListen` 会拒绝裸地址），现为 `127.0.0.1:3350`。
2. **服务冲突**：底座 `init` 在 macOS 上**自己**写 `~/Library/LaunchAgents/agent-autoloop.plist` 并拉起 `up`（`host/service.ts:installService()`），`host/up.ts:lock()` 会拒绝第二个 `up`。`deploy/com.superagent.runtime.plist` 因此只是**可选模板**，默认不要加载；只有明确 `init --no-service` 且已停用底座服务时才用。plist 里用 `__NODE_BIN__` / `__REPO_ROOT__` / `__HOME_DIR__` 占位，由 `bootstrap-macos.sh render-plist` 渲染。

另外：Homebrew 的 `node@24` 默认**不在 PATH**，必须用它的绝对路径跑 `init`，否则 LaunchAgent 会钉住错误的 node。`bootstrap-macos.sh` 会自动 `brew --prefix node@24` 并 export PATH。

## 3. 在 Mac 上从零开始

```bash
# 1. 准备 Node 24（Homebrew）
brew install node@24 git
export PATH="$(brew --prefix node@24)/bin:$PATH"
node --version            # v24.x

# 2. 取代码（只需一个 clone，不要 clone 上游再手动配 remote）
gh repo clone wangshucheng/agent-autoloop super-agent-auto-loop-runtime
cd super-agent-auto-loop-runtime
git checkout feat/super-agent-runtime

# 3. 预检 + 配置 + 绿色基线（不装服务、不改系统）
bash super-agent/scripts/bootstrap-macos.sh
```

`bootstrap-macos.sh` 会：检查 Node ≥24 / git / curl → 建 `~/.agent-autoloop`（0700）→ **不覆盖**地写 `rules.json` 与 `super.json` → `npm ci` / `format:check` / `typecheck` → 跑 M0–M4 绿色回归子集 + `test:sim` 20000 步 → 打印下一步。完整 `npm test` 需要已登录的 Agent CLI，默认跳过（`SUPER_FULL_TEST=1` 才跑）；CI 由 `install-smoke.sh` 提供。

```bash
# 4. 让底座自己装并启动服务（端口与 super.example.json 一致）
node --disable-warning=ExperimentalWarning bin/agent-autoloop.ts init --port 3350
#    -> ~/Library/LaunchAgents/agent-autoloop.plist, RunAtLoad + KeepAlive

# 5. 生成 owner key（写命令必需）
node --disable-warning=ExperimentalWarning bin/agent-autoloop.ts key new owner mac
```

**不要再加载 `deploy/com.superagent.runtime.plist`**。若确实要自己管 launchd：先 `init --no-service`，再

```bash
bash super-agent/scripts/bootstrap-macos.sh render-plist
launchctl bootout gui/$(id -u)/agent-autoloop 2>/dev/null || true
cp ~/.agent-autoloop/com.superagent.runtime.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.superagent.runtime.plist
```

## 4. 验证清单

```bash
P=3350
curl -s http://127.0.0.1:$P/v1/state                  # 底座仍在，协议未变
curl -s http://127.0.0.1:$P/v1/super/overview
curl -s http://127.0.0.1:$P/v1/super/blackboard
curl -s http://127.0.0.1:$P/v1/super/health
curl -s http://127.0.0.1:$P/v1/super/health/actions
curl -s http://127.0.0.1:$P/v1/super/schedule
curl -s http://127.0.0.1:$P/v1/super/channels
curl -s http://127.0.0.1:$P/v1/super/projects/routes
```

- 前端：打开 `super-agent/web/index.html`，API 地址填 `http://127.0.0.1:3350`，点「连接后端」；只读自动切真实数据，SSE 走 `/v1/super/stream?after=`。写操作要在 banner 填 owner key。
- 写命令（需 `Authorization: Bearer <owner-key>`）：`POST /v1/super/health/report`、`POST /v1/super/cards/deliver`、`POST /v1/super/ingress/github`。命令体出现 `to/cwd/skill/access/emits/agent/answerers` 一律 400。
- 底座原生能力：`/v1/in/:source` 仍负责验签（`plugins/github/source.ts`）；飞书/桌面通道插件通过 `nextCard()` 拉卡，凭据在 `config.json` / lark-cli，super 平面不碰。

## 5. 两份配置的分工

| 文件 | 谁读 | 约束 |
| --- | --- | --- |
| `~/.agent-autoloop/rules.json` | 底座 `protocol/rules.ts` | **只含原生字段**；`checkFields()` 拒绝任何未知键。示例 `super-agent/config/rules.example.json` 已用 `parseRules()` 验证通过 |
| `~/.agent-autoloop/super.json` | `host/super-config.ts` | 承载 `super.*`（accept_mode、projects、eval、watchdog、attention、schedule、bindings）。缺文件=零配置默认；坏 JSON 明确报错 |

`bindings.sources` 把来源映射到 `project_id`，`bindings.channels` 把项目映射到底座通道；`schedule` 用底座 `kernel/cron.ts` 解析。详见 `M4_CONFIG_AND_FRONTEND.md`、`M4_UPSTREAM_BRIDGE.md`。

## 6. 唯一剩余任务：WSL → macOS 迁移压测

在 Mac 上按顺序执行，把结果回传即可收口：

1. `npm test`（完整套件，需已登录的 Agent CLI；本机 Windows 缺 codex，一直由 CI 代跑）。
2. `node --disable-warning=ExperimentalWarning sim/crash.ts 1000 12648430` 与 `sim/mutate.ts`。
3. `sh scripts/install-smoke.sh`（CI 同款安装冒烟）。
4. launchd 恢复：`launchctl kickstart -k gui/$(id -u)/agent-autoloop`，确认 `up` 重启后 `~/.agent-autoloop/hub.db` 投影与日志一致。
5. 备份/恢复：`agent-autoloop backup <dir>` → `agent-autoloop restore <dir>`，确认 WAL 与 key 完好（Windows 上这些用例受文件语义影响，CI 上是绿的）。
6. 长稳：跑一晚 `npm run test:nightly` 或观察 24h，确认无重复卡片、无挂起期间的 Agent 进程/Token 消耗。
7. 触发一次 CI 双矩阵（`gh workflow run check.yml --ref feat/super-agent-runtime`），确认与本地结论一致。

这项**不需要新代码**，只需要在目标平台验证；因此本轮没有写伪实现。

## 7. 红线（移交后也不要放宽）

- 单条只追加事实日志是唯一真相；`commit()` 唯一写日志、`evolve()` 唯一写投影。
- 内核 L0 零 I/O / 零时钟 / 零随机数；LLM、Webhook、飞书、SQLite 连接都在 host 层。
- 评估结论以 `eval.decided` 事实回写，回放不重跑模型；**不记录模型调用明细、不让模型生成审计摘要**。
- 外部文字永远 `taint: external`，只进只读资料；`to/cwd/skill/access/emits/agent/answerers` 只由本机规则决定。
- 挂起期间零 Agent 进程、零 Token；唤醒前按当前 Policy 复验 Mandate；授权可立即撤销。
- fork/断点只在分支日志生效，生产 main 只读、永不回滚。
- 多项目用 `project_id` 命名空间隔离，不启多实例。

## 8. 回传什么

把以下内容发回即可继续：`git log -1` 的 SHA、CI run 链接与结论、§4 各端点返回、§6 六步结果、以及任何失败日志。若 `npm test` 因 Agent CLI 缺失失败，注明是环境而非回归（见 `M0_BASELINE.md §4`）。
