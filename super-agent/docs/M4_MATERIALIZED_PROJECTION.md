# M4 第二批 · 第 2 项：看板物化投影

记录时间：2026-11-06。前置：M4 第一批与第 1 项健康闭环均已落地，CI 双矩阵连续通过。

## 1. 目标

把**看板主路径**（`GET /v1/super/overview` 与 `/blackboard`）从「每次请求读最近 N 条事实再投影」换成**读取 `evolve()` 已经写好的投影表**。请求不再扫日志，投影由事实日志确定性重建，回放不重跑任何命令或模型。

## 2. 关键设计：投影决策放在 host，不动纯命令层

`evolve()` 是唯一写投影者，而它只依据 `fact.changes` 写。若直接在 `prepareCommand()` 里给每个事实加 `board_items` change，会改动 M3 已固化的事实契约。本轮采用更干净的分层：

```
prepareCommand()  ->  原样的 FactV2（M3 契约零改动）
       |
       v  liveDeps().writeFact()
withBoardChange() ->  追加一条 board_items change   [host 层纯函数]
       |
       v
store.commit()    ->  facts 日志 + evolve() 投影，同一事务
       |
       v
view.select("board_items")  ->  lanesFromRows()  ->  overview / blackboard
```

- `kernel/evolve.ts` 只加 3 处最小增量：`TABLES` += `board_items`、一组索引、`keyOf` 返回 `row.id`。
- `host/super-projection.ts` 的 `boardChangeFor()` / `withBoardChange()` 是纯函数且幂等；没有看板泳道的事实（如内部记账事实）不产生投影行。
- `super-blackboard.ts` 把「事实如何显示」抽成 `describeFact()`，事实读路径 `lanesFromFacts()` 与投影读路径 `lanesFromRows()` **共用同一份描述逻辑**，避免两份真相漂移。

## 3. 等价性与回放一致性

单测用同一批事实分别走两条路径，`assert.deepEqual(lanesFromRows(rows), lanesFromFacts(facts))`：

- `BoardItem.id` 都用 `fact_seq`；`age_minutes` 都从投影/事实里的 `at` 现算，不在落库时冻结。
- 标题、预览、状态、`waiting_for`、`actions` 全部来自 `describeFact()`。
- `taint`、`hops`、`policy_version`、`grant_id`、`correlation_id` / `causation_id` 原样保留；`would_accept` 与 `external` taint 都有专门断言。
- `sim/invariants.ts` 的独立回放 oracle 在 M2 已改为共享 `TABLES`，因此新增投影表自动纳入；`assert.doesNotThrow(() => invariants(view, log))` 验证重放与投影完全一致。

### 接线中抓到的一个真实缺陷

投影行最初带了一堆值为 `undefined` 的可选字段。`JSON.stringify` 落库时会**丢弃**这些键，而回放 oracle 保留内存对象里的键，`assert.deepEqual` 因此判定不一致。修复：`boardChangeFor()` 用 `compact()` 过滤掉所有 `undefined` 值。这是纯投影层的问题，不是底座或 oracle 的问题。

## 4. 读路径分流（诚实说明范围）

| 读模型 | 来源 | 理由 |
| --- | --- | --- |
| `overview` / `blackboard` | **`board_items` 投影** | 看板主路径，请求频繁，本轮完成物化 |
| `trace/:correlation_id` | 事实日志 | 需要完整因果链与 `verdict` 一致性判定，不适合按看板行裁剪 |
| `attention` | 事实日志 | 需要按时间窗口聚合卡片/问题/字数 |
| `projects` | 事实日志 | 需要跨全部事实聚合 `project_id` 与策略版本 |
| `/stream` SSE | 事实日志 | 本来就是增量事实流 |

后三者仍读最近 N 条事实（上限由 `super.json` 的 `max_facts` 决定）。它们不是看板主路径，物化收益有限且会引入新的投影表；留作 M5 可选项，不冒充已完成。

## 5. 兼容性与配置

- `SuperDeps.boardRows?` 是**可选**的。未注入时 `lanesFor()` 自动回落到 `lanesFromFacts()`，所以 M1–M4 的全部既有单测行为不变（168/168 通过）。生产 `liveDeps()` 注入 `hub.getView().select("board_items", ...)`。
- 历史事实（本轮之前写入的）不带 `board_items` change，因此重建投影时不会凭空出现历史看板项；从启用时刻起的事实才会物化。这是「日志是唯一真相」的自然结果，不做回填伪造。
- 投影表索引：`[project_id, lane]`、`correlation_id`、`kind`，与 `View.select` 的 `json_extract` 查询对齐。

## 6. 验证

| 检查 | 结果 |
| --- | --- |
| `tests/super-agent-m4-projection.test.ts` | ✅ 9/9 |
| 合并绿色回归子集（purity / ci-scope / cron / M1 / M2 / M3 / M4 / health / projection / kernel / hops / projection.test / schema） | ✅ **168/168** |
| `npm run typecheck` | ✅ exit 0 |
| `prettier --check` 新增/改动文件 | ✅ |
| `npm run test:sim` 20000 步 | ✅ 1644 completed（本机负载下 133s，此前 30–36s；不变量结论不变） |
| `host/http.ts` 行数 | 41 ≤ 50 |
| CI 双矩阵 | ✅ run `42182499252`：`ubuntu-latest` + `macos-latest` **全部 success** |

## 7. M4 第二批进度

1. ✅ 组件主动上报 + 自愈动作接口（`M4_HEALTH_CLOSED_LOOP.md`）。
2. ✅ 看板物化投影（本文档）。
3. ✅ **Webhook / 飞书卡片 / 定时 / 多项目生产接线**：改用底座原生插件与 cron，不需要真实凭据，见 `M4_UPSTREAM_BRIDGE.md`。
4. WSL → macOS 迁移压测——本机 `wsl.exe` 被安全策略禁止，需解禁或在 macOS 执行 `deploy/com.superagent.runtime.plist`。

红线不变：不记录模型调用明细、不让模型生成审计摘要；外部文字始终 `taint: external`；挂起零 Agent 进程零 Token；授权可立即撤销；一个状态一个写者；生产 main 只读、永不回滚。
