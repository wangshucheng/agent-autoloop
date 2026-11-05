# M0 / M1 基线记录

记录时间：2026-11-05。分支：`feat/super-agent-runtime`。上游 `main`：`f25ce4a`。

## 1. 结论（先看这个）

**Windows 本机不作为正式基线**。正式 M0 基线沿用底座已有的 `.github/workflows/check.yml`：`ubuntu-latest` + `macos-latest` 双矩阵、Node 24、`npm ci` → `format:check` → `typecheck` → `test:quick` → `test:sim` → `npm test` → `install-smoke.sh`。WSL2 本轮被本机安全策略禁止调用，Linux 侧的等价验证交给 CI。

本机只承担**纯内核与类型层面**的验证，这一层已经全绿：类型检查通过，M1 新增 31 项单测通过，底座架构约束与核心子集共 63 项通过。

## 2. 环境事实

| 项 | 值 | 说明 |
| --- | --- | --- |
| 系统 Node | `v22.22.2` | 低于底座 `engines.node >=24` |
| 验证用 Node | `v24.22.2` (Krypton) | 从 nodejs.org 下载 zip 到 `.tools/`，未改系统安装 |
| npm | `11.7.0` | 随 Node 24 包 |
| 版本管理器 | 无 nvm / fnm / volta | 因此补 `.nvmrc`（内容为 `24`） |
| WSL | `wsl.exe` 被安全策略禁止 | 未重试、未绕行；Linux 验证走 CI |
| 网络 | nodejs.org / npm registry / github raw 均 200 | 一次性 `git clone` 曾遇代理 502，`gh repo clone` 可用 |
| `core.autocrlf` | `true` | 见 §4 第 5 条 |
| 底座 CI | 已有 Linux + macOS 双矩阵 | M0 不重造 CI，直接复用 |

本地启用 Node 24 的方式：

```bash
export PATH="/path/to/repo/.tools/node-v24.22.2-win-x64:$PATH"
node --version   # v24.22.2
```

## 3. 验证结果

| 检查 | 结果 | 备注 |
| --- | --- | --- |
| `npm ci` | ✅ | `added 5 packages`，`0 vulnerabilities` |
| `npm run typecheck` | ✅ `exit 0` | 包含 M1 新增的全部 `kernel/*.ts` 与 `tests/super-agent-kernel.test.ts` |
| `tests/cron.test.ts` | ✅ 7/7 | 确认 Node 24 可直接跑 `.ts` 测试 |
| `tests/purity.test.ts` | ✅ 6/6 | 新增内核文件在 `kernel/` 顶层，被底座架构约束扫描覆盖 |
| `tests/ci-scope.test.ts` | ✅ 19/19 | CI 分流逻辑未受影响 |
| `tests/super-agent-kernel.test.ts` | ✅ 31/31 | M1 新增，见 §5 |
| 绿色子集合计 | ✅ 63/63 | 上述四项合跑，`duration_ms ≈ 20241` |
| `npm test`（完整） | ❌ 未采用 | Windows 平台失败 + 后台挂起 10 分钟后终止，见 §4 |
| `npm run format:check` | ❌ 本机假象 | 191 个文件告警，原因是 CRLF，见 §4 |

> **首次 CI 实跑（run `42021596862`，2026-11-05）**：`format:check` 失败，8 个文件告警，**全部来自第一提交 `b8e70cb` 的暂存模板**（`config/rules.example.json`、`schemas/fact.schema.json`、`src/domain/ports.ts`、`src/host/*.ts`、`src/web/api.ts`）——它们从未经过 prettier；M1 新增文件全部合规。已对这 8 个文件执行 `prettier --write`，校验 `prettier --check` 与 JSON 可解析均通过，并重新触发 CI。
>
> 这条教训值得记住：本机 Windows 的「191 文件全红」是 CRLF 噪音，它**掩盖了真实的 8 文件格式缺陷**。平台假象与真实回归必须分开判定，不能因为本机全红就跳过格式检查。`check.yml` 只在 `main` push / PR 时自动触发，因此本分支首次跑 CI 是手动 `workflow_dispatch`；后续每次推送都应手动触发或开 PR。

绿色子集复现命令：

```bash
export PATH="/path/to/repo/.tools/node-v24.22.2-win-x64:$PATH"
node --disable-warning=ExperimentalWarning --test \
  tests/purity.test.ts tests/ci-scope.test.ts tests/cron.test.ts tests/super-agent-kernel.test.ts
npm run typecheck
```

## 4. 完整测试失败分类（均为环境，非回归）

1. **缺外部 CLI**：`tests/adapters.test.ts` 抛出 `找不到 codex：先装好并登录`（`worker/agents.ts:78` 的 `findProgram`）。本机没有对应 Agent CLI，与本分支改动无关。
2. **Windows 文件语义**：`backup.test.ts` 的 backup / restore、独占打开、目录权限相关用例失败。`chmod 0700` 在 Windows 无 POSIX 语义，文件独占打开与 WAL 行为也不同。
3. **临时目录清理**：`tests/helpers.ts` 的 `after()` 报 `EPERM ... rmSync(...)`，本机运行时注入的安全删除 shim 拦截了对 `%TEMP%` 目录的删除。
4. **Windows 绝对路径**：`tests/format.test.ts` 4/4 失败，报 `ERR_UNSUPPORTED_ESM_URL_SCHEME: ... Received protocol 'c:'`——绝对 Windows 路径被当作 ESM URL，需要 `file://` 形式。本机 Node 24 + Windows 组合特有。
5. **CRLF vs prettier**：`core.autocrlf=true` 使检出的 191 个 `.ts/.json/.yml` 全为 CRLF，而 prettier 默认 `endOfLine: lf`，于是 `format:check` 对每个文件都报差异。用 `prettier tsconfig.json | diff - tsconfig.json` 验证过：内容一致，仅行尾不同。CI 检出为 LF，此项为绿。

> 因此本分支**不修改底座任何测试或格式配置**去迁就 Windows。M1 新增文件全部写为 LF，单独跑 `prettier --check` 为绿。

## 5. M1 已落地内容

把 `super-agent/src/kernel/` 的四个纯函数模板落到 `kernel/` 顶层，**底座原有文件零改动**：

| 文件 | 职责 |
| --- | --- |
| `kernel/fact.ts` | Fact v2、`digestOf`、`childOf`、`assertNoInstructionFields`、`validateEventShape` |
| `kernel/approval.ts` | 审批开关四模式、四级覆盖、`approvalChanges`、超时兜底 |
| `kernel/excitation.ts` | 自激防线八类熔断、`nextHops`、`eventDigest`、`isEmitsAllowed` |
| `kernel/grants.ts` | Mandate 授权生命周期、唤醒前复验、策略变更只发 Input |
| `kernel/five-questions.ts` | **新增组合器**：把四者接成「什么事 / 做不做 / 给谁做 / 在哪做 / 怎么做」的纯决策链 |
| `tests/super-agent-kernel.test.ts` | 31 项：因果链、指令数据分离、审批矩阵、八类熔断、复验矩阵、五问链、确定性、纯度 |

`five-questions.ts` 遵守的约束：短路链（reject / suspend 后不再产生执行决策）、最多一张卡、注意力预算压制、`owner / skill / execution_environment` 只由本机规则参数决定、`dispatch: false` 表示挂起期间零 Agent 进程零 Token。**不写事实日志、不写投影**——`commit()` 与 `evolve()` 的独占权保持不变，投影表扩展（`approvals` / `grants`）留到 M2。

### 接线过程中发现并修复的 3 个真实缺陷

1. **TS2322 类型缺陷**：`ApprovalDecision` 的 `allow` 分支只允许 `mode: "off"`，但 `escalate` 模式未达阈值时也返回 `allow`。模板未接线时 `tsc` 扫不到；落地后 `typecheck` 立即报错。已把该分支改为 `mode: "off" | "escalate"`。
2. **去重静默失效**：`guard()` 内部 digest 用键名 `project`，而 `Fact v2` 与调用方契约是 `project_id`，两边 canonical 字符串不同，导致 `duplicate` / `cooldown` 永远不命中。已导出 `eventDigest(source, type, subject, projectId)` 作为唯一身份契约，`guard()` 与测试共用；单测现覆盖八类 `TripCode` 全部命中。
3. **external taint 可被洗白**：`childOf()` 原先不继承 `trust` / `taint`，且允许子事实显式设 `taint: "none"`，外部文字的污染标记会在因果链第二跳丢失。已补 **I8 不变量**：来源为 `external` 时子事实必须保持 `external`，否则抛错；同时继承 `trust`。这是「指令数据分离」红线的实质加固。

### 一个必须留意的架构约束

`tests/purity.test.ts` 断言 `!existsSync(join(root, "web"))`，即**仓库根目录不能出现 `web/`**。可交互前端目前留在 `super-agent/web/` 是安全的；M4 若要把前端迁到根 `web/`，必须同步调整该测试，否则底座架构约束会失败。同理，`purity.test.ts` 只扫描 `kernel/` **顶层** `.ts`，所以 L0 组件不要放进子目录，否则会脱离守护。

CI 分流补充：`scripts/ci-scope.sh` 把 `kernel/*` 归为 `scope=kernel`，会触发 `npm run test:sim`；因为 `decide.ts` / `evolve.ts` 未改，模拟语义不变。新增 `tests/*.test.ts` 会被 `test:quick` 与 `npm test` 自动收录，无需改 CI。

## 6. 下一步（M2 入口）

1. 在 CI 上确认第二提交的双矩阵全绿，把结果回填本文件 §3。
2. 扩展 `kernel/evolve.ts` 的 `TABLES` 与 `change` 应用逻辑，纳入 `approvals` / `grants` 投影；保持「一个状态一个写者」。
3. 把 `super-agent/src/host/` 模板落到 `host/`：eventstore（分支 / 回放 / 断点）、assessor（主会话 LLM 评估旁路）、blackboard、watchdog。
4. 接 `/v1/super/*` 只读端点与 SSE，让 `super-agent/web/` 前端从演示数据切到真实后端。
5. 全程保持 `eval.decided` 结论回写、回放不重跑模型、**不记录模型调用明细**（master 已拍板不做「审计追踪 DeepSeek」）。
