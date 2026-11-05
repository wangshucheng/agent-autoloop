# 02 事件内核：回放 / fork / 断点 / 审计追踪

> 底座已有：只追加事实日志、`evolve` 投影、格式指纹重建、`GET /v1/stream?after=`、`agent-autoloop why <run>`、
> 固定种子模拟与 SIGKILL 校验。本文在其上补齐：**因果链、分支 fork、可控断点、通用审计追踪**。
>
> **范围决策（master 已拍板）**：保留通用审计追踪（因果链、`why`、回放、fork、断点），**不做「审计追踪 DeepSeek」**——
> 既不记录模型调用明细，也不让模型生成审计摘要。主会话 LLM 评估本身保留，结论仍是一条普通事实。

---

## 1. Fact v2

底座 Fact（`kernel/evolve.ts:19`）：

```ts
type Fact = { version: 1; seq: number; at: number; type: string; changes: Change[]; meta?: Row };
```

扩展为 v2，**所有新增字段可选**，旧事实按缺省值读取，无需数据迁移：

```ts
type Trust = "system" | "operator" | "external" | "model";

interface FactV2 {
  version: 1 | 2;
  seq: number;                 // 全局单调递增，分支内也唯一
  at: number;                  // 由外壳传入的逻辑时间（ms），内核不读时钟
  type: string;                // 事实种类，见 §2
  changes: Change[];           // { table, key, row|null }，投影唯一写入依据
  meta?: {
    branch?: string;           // 缺省 "main"
    project_id?: string;       // 多项目命名空间，缺省 "default"
    correlation_id?: string;   // 一件事的完整因果链 id（从首个 Trigger 继承）
    causation_id?: number;     // 直接父事实的 seq
    actor?: string;            // 谁触发：source:github / worker:mac / channel:feishu / assessor / owner
    trust?: Trust;             // 事实来源可信度
    taint?: "none" | "external"; // 是否携带外部文字（只影响资料，不影响指令）
    hops?: number;             // 处理链深度，跨人工回答与定时复查不清零
    policy_version?: string;   // 决策所依据的策略版本
    grant_id?: string;         // 决策所依据的授权
    attention_cost?: number;   // 本事实是否消耗人的注意力（0/1/权重）
    digest?: string;           // 规范化内容哈希，用于自激去重
    reason?: { code: string; values?: Record<string, unknown>; said?: string };
  };
}
```

约束：

- `changes` 是**唯一**改变状态的途径；`meta` 只描述，不参与投影计算。
- 内核不读时钟/随机数：时间、随机材料、网络由外壳注入；`seq` 由 `view.seq + 1` 得出。
- `facts` 表增加 `branch TEXT NOT NULL DEFAULT 'main'`，主键 `(branch, seq)`；`projection_meta` 按分支一行。
- 不存：轮次 token、卡片链接 token、`master.key`、密钥明文、prompt 原文、模型调用明细（沿用底座 `SECURITY.md`，并按本次范围决策收紧）。
- 评估事实只带 `policy_version` 与 `reason`：知道「依据哪版策略、为什么这么判」即可，不需要知道用的是哪个模型、烧了多少 token。

### 1.1 因果链不变量

| # | 不变量 | 检查位置 |
| --- | --- | --- |
| I1 | `causation_id < seq`，且指向同分支已存在事实 | `commit` 前校验 |
| I2 | `correlation_id` 在一条链上恒定；`hops` 单调不减，人工回答/定时复查不清零 | `sim/invariants.ts` |
| I3 | 每条事实最多产生一个「注意力消耗」（卡片/问题），重复 `digest` 不产生第二张 | `ExcitationGuard` |
| I4 | 评估类事实必须带 `policy_version` 与 `reason.code` | `Assessor` 写回时校验 |
| I5 | 任何 `grant.*` 事实必须能追溯到一条 `eval.decided` 或 `trigger.received(explicit)` | 回放校验 |
| I6 | 重放不重跑规则、不重跑模型、不重发卡片 | 回放器只调用 `evolve` |
| I7 | 分支投影 = 父分支 `[1..base_seq]` + 分支本地事实，逐条重放结果一致 | `tests/fork.spec.ts` |
| I8 | `taint: external` 沿因果链继承，子事实不得清除或降级；`trust` 同步继承 | `kernel/fact.ts` 的 `childOf` 构造 `meta` 时校验（M1 已实现） |

---

## 2. 事实类型目录

分组沿用底座 `decide` 的 handler 命名，新增类型全部是**增量**：

| 组 | type | 触发 | 关键 `changes` |
| --- | --- | --- | --- |
| 入口 | `trigger.received` / `trigger.duplicate` / `trigger.filtered` | 来源/定时/Webhook/轮询/卡片回答 | `events`, `threads` |
| 准入 | `eval.started` / `eval.candidate_delivered` / `eval.requeued` / `eval.decided` / `eval.unavailable` | Gate / Assessor / 超时 | `decisions`, `threads` |
| 授权 | `grant.created` / `grant.revalidated` / `grant.revoked` | accept / 唤醒 / 策略变更 / 人停止 | `grants`, `tickets` |
| 编排 | `ticket.created` / `ticket.resumed` / `ticket.ended` / `thread.subscribed` / `thread.unsubscribed` | Router / Intake | `tickets`, `subscriptions` |
| 执行 | `run.queued` / `run.claimed` / `run.started` / `run.result` / `run.cancelled` | Worker 协议 | `runs`, `run_events` |
| 副作用 | `card.created` / `card.delivered` / `card.failed` / `card.answered` / `card.resolved` | 通道 | `cards`, `deliveries` |
| 审批 | `approval.required` / `approval.auto` / `approval.granted` / `approval.denied` / `approval.expired` | ApprovalGate | `cards`, `approvals` |
| 定时 | `timer.scheduled` / `timer.cancelled` / `timer.due` / `schedule.missed` | `due` 表 | `timers`, `schedules`, `due` |
| 副作用队列 | `effect.enqueued` / `effect.settled` / `effect.deferred` / `effect.failed` | Effects | `effects` |
| 策略 | `policy.changed` / `settings.saved` / `prompt.saved` | 面板 / 工具 / 同步 | `config`, `settings_versions` |
| 健康 | `health.changed` / `watchdog.escalated` / `watchdog.recovered` | Watchdog | `health` |
| 调试 | `branch.forked` / `replay.started` / `breakpoint.hit` / `replay.paused` / `replay.resumed` | 调试器（**只在分支**） | `branches`, `breakpoints` |
| 审计 | `audit.trace` | 只读派生，**不写业务投影** | — |

> `eval.decided` 的 `reason.code` 采用 dsh 的封闭集合扩展：`would_accept`、`no_matching_rule`、`policy_changed`、`timeout`、`not_admitted`、`handed_back`、`manual_stop`、`said`、`matched_rule`。

---

## 3. 回放（Replay）

底座已经具备重放能力（`kernel/store.ts:25 rebuild()`：格式指纹变化时逐条读日志重建投影，不一次读入内存、不覆盖期间的新提交）。本项目显式化成一个一等命令：

```bash
# 从 0 重放到指定 seq，输出投影摘要与校验和（不执行任何副作用）
agent-autoloop replay --branch main --to 12648430 --verify

# 只解释一轮（沿用底座 why，输出扩展为因果链）
agent-autoloop why 42 --json --trace
```

算法（纯函数，不联网）：

```
replay(branch, to, breakpointSet?):
  view = new View(db, 0, {}, format)         // 空视图
  facts = iterateLog(db, branch, 0, to)      // 生成器，逐条，不缓存全量
  for fact of facts:
     if breakpointSet.match(fact): yield paused(fact.seq, view.snapshot()); wait
     view = evolve(view, [fact], db, replay=true)
     invariants.assert(view, fact)
  return view.checksum()
```

要点：

- **只调用 `evolve`，绝不调用 `decide`**：规则版本、密钥哈希、评估结论都已固化在事实里，重放不重新判断。
- 副作用（发卡片、起 Agent、调 LLM）在重放中全部跳过；`effect.enqueued` 只重建队列状态，不触发 handler。
- 校验和是投影的规范化哈希，用于「强杀后恢复一致」「分支对比」「跨机器迁移一致」三项断言。
- 大历史量按底座实测：110 万事实全量重建 43.1 秒、峰值约 141MB；因此审计重放默认在**分支 + 时间窗**内做，主分支全量重建只在格式指纹变化时发生。

SSE 沿用 `GET /v1/stream?after=<seq>`，新增 `branch` 参数；断线用 `Last-Event-ID` 续读；不给订阅者发送密钥哈希或能力凭据（底座约束）。

---

## 4. fork（分支）

用途：① 事故复盘「如果当时不这么判会怎样」；② 换模型/换策略的 what-if 评估；③ 断点调试；④ 审计沙盒。**生产 `main` 分支永远只读、永不回滚。**

### 4.1 数据结构

```sql
CREATE TABLE branches (
  name TEXT PRIMARY KEY,
  parent TEXT,             -- NULL 表示 main
  base_seq INTEGER,        -- 从父分支的哪个 seq 分叉
  created_at TEXT,
  purpose TEXT,            -- "what-if" | "debug" | "audit"
  owner_key_hash TEXT
);
-- 分支本地事实：seq 从 base_seq+1 开始编号，与父分支共享 [1..base_seq] 前缀
CREATE TABLE facts (branch TEXT NOT NULL DEFAULT 'main', seq INTEGER NOT NULL,
                    fact TEXT NOT NULL, PRIMARY KEY(branch, seq));
```

读一个分支的逻辑日志 = `parent[1..base_seq] ⊕ branch[base_seq+1..]`。这样：

- 分叉是 **O(1)**，不复制历史（省磁盘，规避底座日志无限增长问题）；
- 分支内 `next`（编号高水位）从父分支 `base_seq` 处的快照继承，避免 id 冲突；
- 分支可以再 fork（父指针成链），`replay` 递归展开前缀。

### 4.2 命令

```bash
# 从第 12648430 条事实分叉，做一次「换成更严格的研判口径会怎么判」的 what-if
agent-autoloop fork --from 12648430 --name whatif/reasoner --purpose what-if

# 在分支上重放并只允许评估器重跑（其它副作用仍禁用）
agent-autoloop replay --branch whatif/reasoner --reassess-with deepseek-reasoner --to 12648430

# 对比两条分支的投影差异
agent-autoloop diff main whatif/reasoner
```

> `--reassess-with` 只是选择评估时用的模型，属于评估能力；**不构成模型调用审计**，也不写任何模型调用明细。

### 4.3 语义边界（必须遵守）

| 允许 | 禁止 |
| --- | --- |
| 在分支上重放、设断点、重跑评估、改策略再看结果 | 把分支事实合并回 `main` |
| 分支上产出 `audit.trace` | 分支上发真实卡片 / 起真实 Agent / 花真实钱 |
| 导出分支为审计证据（只读 JSON） | 用分支结果覆盖生产状态 |

分支 GC：`purpose=debug` 且 7 天无活动自动归档为压缩 JSONL 后删除本地事实；`what-if`/`audit` 保留到人工确认。

---

## 5. 断点（Breakpoint）

断点只注册在分支上，是**调试与审计工具**，不是生产控制流。

```ts
type Breakpoint = {
  id: string;
  branch: string;
  match: {
    type?: string[];                    // 事实类型，如 ["eval.decided", "grant.revoked"]
    project_id?: string;
    seq?: number;                       // 精确停在某条
    predicate?: string;                 // 受限表达式，如 "meta.hops >= 6"
    correlation_id?: string;            // 只跟一条链
  };
  action: "pause" | "snapshot" | "log";
};
```

交互（SSE `GET /v1/super/debug/stream?branch=...`）：

```
event: replay.paused   data: { seq, fact, viewChecksum, breakpoint }
event: replay.resumed   data: { seq }
```

支持：`pause / step / continue / inspect <table,key> / set-breakpoint / clear`。 inspector 只读投影快照，不写任何状态。

典型用例：

1. 自激事故：在 `hops >= 6` 停下，看是哪条 `run.result.events` 触发了回环。
2. 授权事故：在 `grant.revoked` 停下，检查复验时用的是哪一版 Policy。
3. 评估复核：在 `eval.decided` 停下，导出当时的候选卡与 `reason`，与新口径结果对照。

---

## 6. 审计追踪（通用，不含模型专项审计）

### 6.1 一条命令还原全链路

```bash
agent-autoloop audit <run|ticket|correlation_id> --full
```

输出结构（只读派生，不写业务投影）：

```json
{
  "correlation_id": "c-9f2a",
  "project_id": "home-deco",
  "chain": [
    {"seq": 1021, "type": "trigger.received", "actor": "source:github", "trust": "external", "hops": 0},
    {"seq": 1022, "type": "eval.started",    "policy_version": "P8", "strength": "inferred"},
    {"seq": 1023, "type": "eval.decided",    "reason": {"code":"matched_rule","values":{"rule":"issue-triage"}}},
    {"seq": 1024, "type": "grant.created",   "grant_id":"g-77","policy_version":"P8"},
    {"seq": 1031, "type": "approval.required","action":"merge","mode":"gate"},
    {"seq": 1032, "type": "card.created",    "attention_cost": 1},
    {"seq": 1033, "type": "card.answered",   "actor":"channel:feishu","by":"ou_xxx","hops": 0},
    {"seq": 1034, "type": "grant.revalidated","result":"held","policy_version":"P8"}
  ],
  "attention": {"cards": 1, "questions": 1, "words": 38},
  "cost": {"tokens": 3300, "usd": 0.0},
  "policy_versions": ["P8"],
  "verdict": "consistent"
}
```

`cost` 来自底座 `worker` 的 `usage` 上报（Agent 插件本来就报用量），不是模型调用明细。

### 6.2 范围说明（master 决策：不做「审计追踪 DeepSeek」）

| 保留 | 移除 |
| --- | --- |
| 事实因果链、`why`、`audit.trace`、回放/fork/断点 | 模型调用审计（模型名、prompt hash、token、延迟、成功率看板） |
| 评估结论的 `policy_version` / `reason.code` / `intent_evidence` 摘要 | 用模型生成审计摘要的 `audit.summary` 旁路 |
| 审批、授权复验、撤销、注意力计量、成本（worker usage） | `/v1/super/audit/deepseek`、`eval.audit`、`audit.summarize` 配置与 Fact `meta.model` 字段 |
| HealthBoard 中 `assessor` 条目的超时/失败计数 | 任何针对模型供应商的专项审计视图 |

理由：通用审计已经能回答「为什么跑、谁批的、依据哪版策略、花了多少注意力」；再加一层模型专项审计会引入新的状态、新的卡片与新的注意力成本，与「占用最少的人的注意力」相冲突。评估器仍然可用、可关、可回放（`eval.decided` 是普通事实）。

---

## 7. 与底座既有能力的关系

| 底座能力 | 本设计如何处理 |
| --- | --- |
| `GET /v1/stream?after=` SSE | 保留；新增 `branch`、过滤 `project_id`、不泄露凭据 |
| `GET /v1/runs/42/why` | 保留；`--trace` 输出完整因果链与评估/授权摘要 |
| `agent-autoloop backup/restore` | 保留；backup 需一并带走 `branches`、`audit`、`policy.json`、`config/prompts/`，权限仍 0700/0600 |
| 格式指纹重建 | 保留；指纹计算纳入 `kernel/approval.ts`、`excitation.ts`、`grants.ts` 三个新文件（底座指纹只算 `evolve/credentials`） |
| `sim/random.ts` / `crash.ts` / `mutate.ts` | 保留；新增 I1–I8 不变量到 `sim/invariants.ts`，新增分支/断点/审计场景 |
| `why` 默认不打印规则正文 | 保留；`--full` 才显示（避免信息过载，符合最小注意力） |

---

## 8. 新增测试清单

| 测试 | 断言 |
| --- | --- |
| `tests/fact-v2.spec.ts` | 旧事实按缺省读取；新字段不影响旧 handler；schema 2020-12 校验通过；无 `meta.model` 字段 |
| `tests/replay.spec.ts` | 重放不调用 `decide`、不发卡片、不调 LLM；校验和与在线投影一致 |
| `tests/fork.spec.ts` | 分叉 O(1)；前缀共享；父分支不受污染；嵌套 fork 正确 |
| `tests/breakpoint.spec.ts` | 只停分支；pause/step/continue；inspector 只读 |
| `tests/audit.spec.ts` | 因果链完整；不落模型调用明细；审计视图与在线事实一致 |
| `sim/invariants.ts` 扩展 | I1–I8 在 200000 步模拟与 8! 动作穷举中始终成立 |
