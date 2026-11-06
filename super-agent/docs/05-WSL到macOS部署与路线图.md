# 05 WSL 开发 → macOS 生产：部署与路线图

> 底座官方支持 macOS / Linux，Windows 版当时未发布；因此在 **WSL2 (Ubuntu) 开发** 是最省事的路径，
> 生产目标 macOS 与底座 CI 矩阵一致（`.github/workflows` 已有 Linux / macOS）。

---

## 1. 环境差异清单

| 维度 | WSL2 开发 | macOS 生产 | 迁移动作 |
| --- | --- | --- | --- |
| 运行时 | Node 24（nvm / Volta） | Node 24（Homebrew / nvm） | `node --version` 固定，锁 `package-lock.json` |
| SQLite | `node:sqlite`（Node 24 内置） | 同 | 无原生依赖，零运行时依赖这一条要守住 |
| 服务托管 | `systemd --user`（WSL2 需启用 systemd）或 `supervisord` | `launchd`（`~/Library/LaunchAgents/`） | 底座 `host/service.ts` 已双实现；新增 `deploy/` 单元 |
| 数据目录 | `~/.agent-autoloop/` | `~/.agent-autoloop/` | 权限 `0700`，文件 `0600`；`master.key` 必须一起迁移 |
| 凭据 | `config.json`、`secrets.env` | 同 + 建议 Keychain 保管 `master.key` | 备份/恢复走 `agent-autoloop backup/restore` |
| 桌面通知 | `notify-send`（WSL 常无图形会话 → 底座会报 `skipped-<id>`，不反复打扰） | `osascript`（参数放 `--` 之后，不拼脚本） | 生产用飞书 + 桌面双通道 |
| 飞书回调 | 需要 `publicUrl`；本机地址手机打不开 | 同 | 反向代理做 HTTPS，中台本体仍只听 127.0.0.1 |
| 路径 | `/home/<u>/code/...` | `/Users/<u>/code/...` | `projects[].cwd` 用 `~` 或环境变量，**不写绝对路径到规则** |
| Git worktree | 可用 | 可用 | 一 Ticket 一目录；符号链接核对 |
| 定时/时区 | `TZ` / `rules.timezone` | 同 | 统一 `Asia/Shanghai`，避免合盖补跑差异 |
| 崩溃恢复 | WSL 关机=整机断电级，底座声明未单独测过 | 合盖睡眠 | 依赖 WAL + FULL 逐条提交；恢复后跑 `replay --verify` |
| 性能基线 | 与 M 系列不可比 | 底座实测机 M5 Pro | 冷启动 ≤150ms、空闲 RSS ≤60.4MB 只在 macOS 验收 |

**WSL 特别注意**

1. 项目文件放在 Linux 文件系统（`~/`），不要放 `/mnt/c/`，否则 SQLite WAL 与文件权限语义会跑偏。
2. WSL2 需在 `/etc/wsl.conf` 开 `[boot] systemd=true` 才能用 `systemctl --user`；否则开发期直接 `node bin/agent-autoloop.ts` 前台跑。
3. 无图形会话时桌面通知按底座约定跳过，不会刷屏；开发期主要用 CLI `status` 与假飞书通道。
4. Webhook 验签在本地用底座 `examples/plugins/hello-source` 的 HMAC 模板做联调，不连真实业务账号（底座场景模板也是这么做的）。

---

## 2. fork 与工程初始化（已执行，2026-11-05）

> master 已授权执行。检查结果：`wangshucheng/agent-autoloop` **本来就是** `KKKKhazix/agent-autoloop` 的 fork，
> 因此无需重复 fork；实际动作是：同步上游 → 克隆 → 建分支 → 提交设计与前端。

```bash
# 1. 同步 fork 到上游最新 main（同步前 fork HEAD 8f8e2ee，上游 f25ce4a）
gh repo sync wangshucheng/agent-autoloop --source KKKKhazix/agent-autoloop --branch main

# 2. 克隆（gh 会自动把 origin 指向 fork、upstream 指向父仓库）
gh repo clone wangshucheng/agent-autoloop .fork-stage -- --depth 1
cd .fork-stage
git checkout -b feat/super-agent-runtime

# 3. 把本仓库的 docs/ schemas/ config/ src/ web/ deploy/ scripts/ 复制到分支
#    （不覆盖底座任何原有文件；设计文档放在 docs/super-agent/ 下，前端放在 web/ 下）
#    src/ 中的模板按 docs/01 §5 的改造点落到 fork 对应目录

# 4. 基线必须先绿，才允许动内核
npm ci
npm test
node sim/random.ts 24301 200000
node sim/crash.ts 1000 12648430
node sim/mutate.ts
npm run benchmark      # 记录本机基线，不与 M5 Pro 数字硬比

# 5. 推送工作分支
git push -u origin feat/super-agent-runtime
```

上游 dsh 原型保持为**只读参考快照**（本仓库 `.research/`），不合并代码、不引入依赖、不加 submodule。

**许可证**：两个上游均为 MIT。fork 后保留 LICENSE 与 NOTICE，新增文件注明来源与改动；若对外发布，遵守底座用量与合规说明（模型调用算在自己账号名下；对外提供服务请用 API Key）。

---

## 3. 里程碑

| 里程碑 | 目标 | 交付 | 退出条件 |
| --- | --- | --- | --- |
| **M0 基线** | fork 完成、上游可 rebase、双平台 CI | `.github/workflows` 加 macOS + Linux 矩阵 | 底座 `npm test`/`conformance`/`sim`/`benchmark` 全绿 |
| **M1 纯内核** | Fact v2 + `approval.ts` / `excitation.ts` / `grants.ts` | `schemas/fact.schema.json`、三个纯函数模块 + 单测 | 不联网、不出网、零时钟；旧事实兼容；I1–I7 不变量 |
| **M2 领域** | 投影扩展、Intake/Gate/Router、Effects/Outbox、Policy 版本、多项目命名空间 | `kernel/evolve` 扩展、`domain/`、`host/effects.ts` | 底座原场景（早报/Issue/告警/巡检）零改动可跑；`sim` 不回归 |
| **M3 智能与安全** | Assessor（DeepSeek）、审批开关、挂起复验/撤销、自激防线、飞书卡片 | `host/assessor.ts`、审批策略 | 关闭评估器时行为等同底座；`observe` 只记录不接单；熔断 ≤8 跳且只 1 张卡；不做模型调用审计 |
| **M4 运维与后台** | Watchdog、HealthBoard、Dashboard + Blackboard 预留接口 | `host/watchdog.ts`、`host/blackboard.ts`、`web/api.ts` | 连续 3 次才升级；健康不占版面；SSE 增量更新；API 类型化 |
| **M5 迁移与压测** | WSL → macOS、长跑、大历史、自激压测、分支 GC | `deploy/`、迁移脚本、验收报告 | 见 §5 验收表；macOS 冷启动/内存达标；72h 挂起零消耗 |

**依赖顺序**：M1 全部是纯函数，可脱离宿主单测；M2 之前不要接 LLM，否则确定性问题无法定位。

---

## 4. 测试策略（继承底座，别重造）

| 层级 | 工具 | 覆盖 |
| --- | --- | --- |
| 单元 | `node --test` | 纯函数、schema 校验、策略解析、Grant 复验矩阵 |
| 协议一致性 | 底座 `conformance` | `/v1` 老契约零回归；新增 `/v1/super/*` 另加一套 |
| 固定种子模拟 | `sim/random.ts 24301 200000`（每 128 步换场景） | 故障注入、完整日志重放、I1–I7 不变量 |
| 有界穷举 | `sim/enumerate.ts`（8! 动作顺序） | 两台 worker、两条来源、一张问题卡片的所有交错 |
| 真崩溃 | `sim/crash.ts 1000 12648430` | WAL + FULL、已确认序号、视图、重放、重复提交 |
| 变异 | `sim/mutate.ts`（31 处） | 漏过任何一处即失败，不能用语法错误算检出 |
| 性能/大历史 | `scripts/history.ts 1000 10000 100000`、`npm run benchmark` | 110 万事实量级启动、状态汇总、慢速订阅 |
| 新增 | `tests/replay|fork|breakpoint|audit|assessor|grants|excitation|watchdog.spec.ts` | 本设计新增能力 |
| 真机 | WSL + macOS 各一轮 | 飞书卡片按钮回调、桌面通知、launchd 拉起、合盖补跑 |

**回归红线**：任何阶段 `sim/random.ts`、`sim/crash.ts`、`sim/mutate.ts` 不绿，禁止合并。

---

## 5. 验收表（M5）

| 项目 | 口径 | 期望 |
| --- | --- | --- |
| 兼容性 | 旧 `rules.json`、旧插件、旧客户端 | 零改动可跑，`conformance` 全绿 |
| 确定性 | 同输入同视图 | 事实序列完全一致；回放不重跑规则/模型/卡片 |
| 挂起 | 等待 72 小时 | Agent 进程数 0、Token 0、长轮询不产生事实；回答后接原会话 |
| 撤销 | `DELETE /v1/keys` / `runs/:id/cancel` / `grants/:id/revoke` | 立即拒绝长轮询/在途轮次/后续唤醒 |
| 审批 | 四种 mode 各跑一遍 | `off` 无卡、`notify` 灰卡不阻断、`gate` 阻断并挂起、`escalate` 条件触发 |
| LLM 评估 | 开/关两轮 | 关闭时与底座一致；开启时 `eval.decided` 带 `policy_version` 与 `reason.code`，无模型调用明细；回放不重跑 |
| 自激 | Agent 连续自引用 100 轮 | ≤8 跳熔断、只 1 张卡、预算/冷却生效、全部事实可查 |
| 注意力 | 默认场景 24h | `cards/owner/hour ≤ 配置值`；瞬时错误 0 打扰；健康区块折叠 |
| 自愈 | 杀插件 / 写坏规则 / 断网 / DB 锁 | 30s 重启；旧规则继续；连续 3 次才升级；自愈预算不耗尽 |
| 多项目 | 3 个项目并发 | 事件/预算/卡片/授权/目录严格隔离，跨项目越权被拒 |
| 审计 | 任取一轮 | `audit <run> --full` 给出完整因果链、评估、审批、授权复验、成本、注意力 |
| 平台 | macOS 生产 | 冷启动 ≤150ms、空闲 RSS ≤60.4MB（底座基线）；launchd 拉起；飞书手机可批 |

---

## 6. 部署单元（示意）

WSL 开发（`deploy/systemd-user.service`）：

```ini
[Unit]
Description=super-agent-auto-loop-runtime (dev)
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/super-agent-auto-loop-runtime
ExecStart=%h/.nvm/versions/node/v24/bin/node bin/agent-autoloop.ts up
Restart=on-failure
RestartSec=30
Environment=AGENT_AUTOLOOP_HOME=%h/.agent-autoloop

[Install]
WantedBy=default.target
```

macOS 生产（`deploy/launchd.plist`）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.superagent.runtime</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/me/super-agent-auto-loop-runtime/bin/agent-autoloop.ts</string>
    <string>up</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/me/.agent-autoloop/logs/stdout.log</string>
  <key>StandardErrorPath</key><string>/Users/me/.agent-autoloop/logs/stderr.log</string>
</dict>
</plist>
```

> 日志写不出去时底座会主动退出，由服务拉起——这正是 L1 自愈的宿主基础，别把 `KeepAlive` 去掉。

---

## 7. 迁移检查单（WSL → macOS）

- [ ] `agent-autoloop backup <dir>`：含 `hub.db`、`master.key`、`config.json`、`secrets.env`、`rules.json`、`policy.json`、`config/prompts/`、`branches/`、`audit/`；目录 0700、文件 0600。
- [ ] 目标机先停中台，再 `agent-autoloop restore <dir>`；恢复会替换规则与密钥，确认无误再起服务。
- [ ] `projects[].cwd` 全部改成 macOS 路径或 `~` 相对路径；核对 worktree 与符号链接。
- [ ] `hub.publicUrl` 指向 HTTPS 反代；飞书应用只保留一个卡片事件监听（底座 `SECURITY.md`）。
- [ ] `answerers` 按项目重新核对；卡片链接「持有即授权」，不发公开位置。
- [ ] `rules.timezone = Asia/Shanghai`；确认合盖补跑只补最近一次。
- [ ] 起服务后 `replay --verify` 校验投影一致，再 `status` 看待人卡片。
- [ ] 跑一遍 `agent-autoloop try`：提问 → 退出等回复 → 拍板 → 接着干完，确认挂起零消耗与会话续接在 macOS 上成立。
- [ ] 记录 macOS 冷启动/RSS/写入吞吐，与底座 M5 Pro 基线对照（换机器不硬比数字）。

---

## 8. 已知风险与未决项

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 事实日志无限增长（底座与 dsh 都有此问题） | 磁盘、状态汇总变慢、全量重建变久 | M5 加分支 GC + 冷归档 JSONL；主分支保留审计所需窗口 |
| 多项目是底座明确没有的能力 | 隔离不严会串项目 | `project_id` 强制命名空间 + 每项目密钥/预算/answerers + 跨项目越权测试 |
| LLM 评估引入不确定性 | 回放语义、成本 | 结论事实化 + prompt hash + `observe` 默认 + 可整体关闭 |
| 审批开关被人误设成 `off` | 高风险动作无卡 | `off` 需显式 `reason`；`spend/delete/external_message` 默认 `gate`；策略变更全量审计 |
| 飞书回调需要公网可达 | 与「不开公网端口」冲突 | 只暴露 HTTPS 反代到 `/v1/cards/*`，中台仍绑 127.0.0.1；或只用链接回答的兜底通道 |
| WSL 无图形会话 | 桌面通知不可用 | 底座已按 `skipped` 处理；开发期用 CLI + 假通道 |
| 上游继续演进 | fork 漂移 | 保留 `upstream` remote；所有扩展集中在新增文件，尽量少改底座原文件，便于 rebase |
| 两个上游都是 MIT、但 dsh 自承研究原型 | 质量与合规 | 只移植领域模型与约束，不搬运行时；保留 LICENSE/NOTICE；对外服务用 API Key |

---

## 9. 立即可做的下一步（不需外部授权）

1. ✅ `schemas/fact.schema.json` 与 `config/rules.example.json` 已作为契约基线评审掉。
2. ✅ M1 已完成：四个纯函数模板落到 `kernel/` 顶层，新增五问组合器 `kernel/five-questions.ts` 与 `tests/super-agent-kernel.test.ts`（31 项），I1–I2、新增 I8 及审批 / 熔断 / 复验矩阵跑通；底座原文件零改动。平台基线与三个已修缺陷见 `docs/M0_BASELINE.md`。
3. 用底座 `sim/random.ts` 加一个「Agent 自引用事件」场景，验证现有 `MAX_HOPS=8` 行为，作为 M3 的对照基线。
4. ✅ M2 已完成：投影表扩展、三个 host 只读组件落地、`/v1/super/*` 只读端点与 SSE、16 项单测。写命令统一 405。详见 `docs/M2_READONLY_PLANE.md`。
5. ✅ M3 已完成：五类显式写命令（每个只产一条事实、经 `commit()` 落盘）、主会话评估旁路、分支调试端点、HealthBoard 实时接线、20 项单测；合并绿色回归 135/135。详见 `docs/M3_COMMANDS_AND_ASSESSMENT.md`。
6. ✅ M4 第一批已完成：示例配置拆成 `rules.json` + `super.json`（前者已通过底座 `parseRules()`）、运行时接真实配置、前端 owner key 与 SSE 修正、10 项单测。详见 `docs/M4_CONFIG_AND_FRONTEND.md`。
7. ✅ M4 第二批第 1 项已完成：组件主动上报 + 自愈动作接口做成零外部依赖的可测闭环（`host/super-health.ts`，14 项单测，合并回归 159/159）。见 `docs/M4_HEALTH_CLOSED_LOOP.md`。
8. ✅ M4 第二批第 2 项已完成：看板物化投影（`board_items` 投影表，`overview` / `blackboard` 不再扫日志），等价性与回放一致性单测 9 项，合并回归 168/168。见 `docs/M4_MATERIALIZED_PROJECTION.md`。
9. ✅ M4 第二批第 3 项已完成：用底座原生通道插件 / 来源 adapter / `kernel/cron.ts` 接好 Webhook、飞书卡片、定时与多项目路由，无需真实凭据；13 项单测、合并回归 181/181。见 `docs/M4_UPSTREAM_BRIDGE.md`。
10. M4 第二批仅余 1 项：WSL → macOS 迁移压测，需要目标平台，本环境无法验证。移交物料已备齐：`docs/HANDOFF_MACOS.md`、`scripts/bootstrap-macos.sh`、端口统一 3350、plist 冲突警告与 9 项一致性单测。
11. 三个决策点已由 master 拍板：fork 已执行、可交互前端已交付、不做「审计追踪 DeepSeek」；按 `docs/00 §8` 的已定结论推进 M0–M4。
