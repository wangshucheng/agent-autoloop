/* 演示数据：仅在后端 /v1/super/* 不可达时使用。形状与 docs/04 的预留接口一致。 */
(function () {
  "use strict";

  var LANES = [
    { id: "intake", label: "新事件" },
    { id: "evaluating", label: "研判中" },
    { id: "would_accept", label: "本来会接" },
    { id: "authorized", label: "已授权" },
    { id: "working", label: "执行中" },
    { id: "waiting_person", label: "待人" },
    { id: "suspended", label: "挂起零消耗" },
    { id: "done", label: "完成" },
    { id: "tripped", label: "熔断/阻断" }
  ];

  function item(id, lane, title, extra) {
    return Object.assign({
      id: id,
      kind: "trigger.received",
      project_id: "home-deco",
      title: title,
      preview: "",
      state: "open",
      age_minutes: 4,
      hops: 0,
      policy_version: "P8",
      correlation_id: "c-" + id,
      actions: ["open_trace"],
      lane: lane,
      category: "routine"
    }, extra || {});
  }

  var ITEMS = {
    "home-deco": [
      item("h-101", "intake", "issues.opened #482 首页瀑布流错位", { kind: "trigger.received", taint: "external", preview: "来源 github · 外部文字只作资料", age_minutes: 3, hops: 0, tag: "external" }),
      item("h-102", "intake", "issues.opened #483 图片懒加载失效", { kind: "trigger.received", taint: "external", age_minutes: 8, hops: 0 }),
      item("h-103", "intake", "cron 09:00 每日早报", { kind: "trigger.received", age_minutes: 41, hops: 0 }),
      item("h-104", "intake", "alert.page_error /api/feed 5xx", { kind: "trigger.received", taint: "external", age_minutes: 1, hops: 0, tag: "alert" }),
      item("h-201", "evaluating", "候选 #482 · inferred · P8", { kind: "eval.started", preview: "Gate 已准入，等待主会话研判", age_minutes: 3, hops: 0, tag: "llm" }),
      item("h-301", "would_accept", "observe：本来会接 #477", { kind: "eval.decided", reason: "would_accept", preview: "只记录不接单，看过再切 auto", age_minutes: 36, hops: 0, tag: "observe" }),
      item("h-302", "would_accept", "observe：本来会接 #471", { kind: "eval.decided", reason: "would_accept", age_minutes: 92, hops: 0 }),
      item("h-401", "authorized", "Grant g-77 · issue-triage", { kind: "grant.created", grant_id: "g-77", preview: "scope: 分类与复现，不推送不合并", age_minutes: 22, hops: 1, tag: "grant" }),
      item("h-501", "working", "Assignment a-12 · codex", { kind: "assignment.started", preview: "cwd ~/code/home-deco · access edit", age_minutes: 18, hops: 1 }),
      item("h-502", "working", "Assignment a-13 · dsh", { kind: "assignment.started", preview: "告警排查，等待日志读取", age_minutes: 6, hops: 0 }),
      item("h-601", "waiting_person", "是否合并 PR #42", { kind: "approval.required", state: "open", waiting_for: "ou_xxx", preview: "动作类别 merge · 当前模式 gate", age_minutes: 12, hops: 2, category: "merge", tag: "gate", actions: ["approve", "deny", "open_trace"] }),
      item("h-602", "waiting_person", "需要恢复飞书登录", { kind: "card.created", state: "open", waiting_for: "ou_xxx", preview: "浏览器验收未完成，保留已完成业务", age_minutes: 27, hops: 1, tag: "blocked", actions: ["retry", "stop", "open_trace"] }),
      item("h-701", "suspended", "等待回答 · 零 Agent 进程", { kind: "card.created", preview: "三天未回也不花 Token", age_minutes: 130, hops: 2 }),
      item("h-702", "suspended", "later：30 分钟后复查", { kind: "timer.scheduled", preview: "到期表驱动，不轮询", age_minutes: 12, hops: 1 }),
      item("h-801", "done", "Ticket t-31 完成 · PR merged", { kind: "ticket.ended", preview: "订阅保留，后续评论可原授权唤醒", age_minutes: 180, hops: 3 }),
      item("h-802", "done", "Ticket t-29 · dropped 无需处理", { kind: "run.result", age_minutes: 260, hops: 2 }),
      item("h-901", "tripped", "hops_exceeded · 已记录不派发", { kind: "excitation.tripped", preview: "同一根因只发一张卡", age_minutes: 55, hops: 9, tag: "tripped" })
    ],
    "shop": [
      item("s-101", "intake", "order.paid #A2381", { project_id: "shop", kind: "trigger.received", taint: "external", age_minutes: 2, hops: 0 }),
      item("s-201", "evaluating", "候选 #A2381 · inferred · P8", { project_id: "shop", kind: "eval.started", age_minutes: 2, hops: 0 }),
      item("s-401", "authorized", "Grant g-91 · ops-alert", { project_id: "shop", kind: "grant.created", grant_id: "g-91", age_minutes: 15, hops: 1 }),
      item("s-501", "working", "Assignment a-21 · codex", { project_id: "shop", kind: "assignment.started", age_minutes: 9, hops: 1 }),
      item("s-601", "waiting_person", "是否重启订单服务", { project_id: "shop", kind: "approval.required", waiting_for: "ou_yyy", preview: "动作类别 restart · 规则覆盖为 off（隔离环境）", age_minutes: 5, hops: 1, category: "restart", tag: "escalate", actions: ["approve", "deny", "open_trace"] }),
      item("s-701", "suspended", "later：15 分钟后复查库存", { project_id: "shop", kind: "timer.scheduled", age_minutes: 7, hops: 1 }),
      item("s-801", "done", "Ticket t-08 完成", { project_id: "shop", kind: "ticket.ended", age_minutes: 96, hops: 2 })
    ],
    "personal": [
      item("p-101", "intake", "cron 08:00 每日早报", { project_id: "personal", kind: "trigger.received", age_minutes: 62, hops: 0 }),
      item("p-501", "working", "Assignment a-02 · reader", { project_id: "personal", kind: "assignment.started", age_minutes: 60, hops: 0 }),
      item("p-801", "done", "Ticket t-02 完成", { project_id: "personal", kind: "ticket.ended", age_minutes: 60, hops: 1 })
    ]
  };

  var CHAINS = {
    "c-h-601": [
      { seq: 1021, type: "trigger.received", actor: "source:github", trust: "external", hops: 0, detail: "issues.opened #482" },
      { seq: 1022, type: "eval.started", policy_version: "P8", hops: 0, detail: "strength = inferred" },
      { seq: 1023, type: "eval.decided", policy_version: "P8", hops: 0, detail: "accept", reason: "matched_rule: issue-triage" },
      { seq: 1024, type: "grant.created", grant_id: "g-77", policy_version: "P8", hops: 1, detail: "scope: 分类与复现" },
      { seq: 1030, type: "assignment.started", actor: "worker:mac", hops: 1, detail: "agent codex · access edit" },
      { seq: 1031, type: "run.result", actor: "worker:mac", hops: 2, detail: "done + ask 合并 PR #42" },
      { seq: 1032, type: "approval.required", hops: 2, detail: "action merge · mode gate", reason: "policy P8 / category merge" },
      { seq: 1033, type: "card.created", actor: "channel:feishu", hops: 2, detail: "飞书卡片，等待 ou_xxx", reason: "attention_cost 1" }
    ],
    "c-h-901": [
      { seq: 2010, type: "run.result", actor: "worker:mac", hops: 6, detail: "回执 emits 自引用事件" },
      { seq: 2011, type: "trigger.received", actor: "source:github", hops: 7, detail: "issue.auto-comment" },
      { seq: 2012, type: "run.result", actor: "worker:mac", hops: 8, detail: "再次 emits 同类事件" },
      { seq: 2013, type: "excitation.tripped", actor: "kernel", hops: 9, detail: "hops_exceeded：记录不派发", reason: "max_hops 8 · notify once" },
      { seq: 2014, type: "card.created", actor: "channel:feishu", hops: 9, detail: "事件循环已停止（唯一一张卡）" }
    ],
    "c-h-701": [
      { seq: 3010, type: "approval.required", hops: 2, detail: "action delete · mode gate" },
      { seq: 3011, type: "card.created", actor: "channel:feishu", hops: 2, detail: "发卡后本轮结束", reason: "process exits" },
      { seq: 3012, type: "card.answered", actor: "channel:feishu", hops: 2, detail: "choice = 拒绝（hops 不清零）" },
      { seq: 3013, type: "grant.revalidated", grant_id: "g-77", policy_version: "P8", hops: 2, detail: "result held · 原会话续接" }
    ]
  };

  function genericChain(correlationId) {
    return [
      { seq: 1001, type: "trigger.received", actor: "source:github", trust: "external", hops: 0, detail: correlationId },
      { seq: 1002, type: "eval.started", policy_version: "P8", hops: 0, detail: "Gate 准入" },
      { seq: 1003, type: "eval.decided", policy_version: "P8", hops: 0, detail: "决策已固化为事实", reason: "matched_rule" },
      { seq: 1004, type: "grant.created", grant_id: "g-demo", policy_version: "P8", hops: 1, detail: "授权范围与策略版本" },
      { seq: 1005, type: "run.result", actor: "worker:mac", hops: 2, detail: "回执在一个事务里生效" }
    ];
  }

  var STREAM = [
    { lane: "intake", item: item("h-105", "intake", "issue_comment #482 补充截图", { taint: "external", age_minutes: 0, hops: 0 }) },
    { lane: "evaluating", item: item("h-202", "evaluating", "候选 #483 · inferred · P8", { kind: "eval.started", age_minutes: 0, hops: 0 }) },
    { lane: "intake", item: item("h-106", "intake", "webhook: deploy.succeeded", { age_minutes: 0, hops: 0 }) },
    { lane: "done", item: item("h-803", "done", "Ticket t-32 完成 · dropped", { kind: "run.result", age_minutes: 0, hops: 2 }) },
    { lane: "tripped", item: item("h-902", "tripped", "duplicate · 冷却窗口内合并", { kind: "excitation.tripped", age_minutes: 0, hops: 4, tag: "dedup" }) }
  ];

  function lanesFor(projectId) {
    var items = (ITEMS[projectId] || []).slice();
    return LANES.map(function (lane) {
      var list = items.filter(function (i) { return i.lane === lane.id; });
      return { id: lane.id, label: lane.label, count: list.length, items: list };
    });
  }

  function overview(projectId) {
    var lanes = lanesFor(projectId);
    var waiting = lanes.filter(function (l) { return l.id === "waiting_person"; })[0].items;
    var problems = projectId === "home-deco"
      ? [{ entry: "source:github", code: "poll_failed_3x", since: "连续 3 次", action: "check_again" },
         { entry: "channel:feishu", code: "card_delivery_retry", since: "退避中", action: "check_again" }]
      : [];
    return {
      needs_person: { count: waiting.length, items: waiting },
      health: { status: problems.length ? "degraded" : "ok", problems: problems, suppressed: 4 },
      activity_24h: {
        triggers: projectId === "home-deco" ? 128 : (projectId === "shop" ? 47 : 12),
        evals: projectId === "home-deco" ? 17 : 6,
        accepted: projectId === "home-deco" ? 3 : 2,
        runs: projectId === "home-deco" ? 9 : 4,
        cards: waiting.length,
        questions: waiting.filter(function (i) { return i.kind === "approval.required"; }).length,
        tokens: projectId === "home-deco" ? 41200 : 9800,
        cost_usd: projectId === "home-deco" ? 0.31 : 0.08,
        attention: { cards_per_owner_hour: projectId === "home-deco" ? 0.5 : 0.2, actionable_ratio: waiting.length ? 1 : 0 },
        worker_load: { running: projectId === "home-deco" ? 2 : 1, capacity: 4 }
      },
      policy_version: "P8",
      now: Date.now()
    };
  }

  window.SUPERAGENT_MOCK = {
    lanes: LANES,
    projects: [
      { id: "home-deco", name: "家装社区 App", policy_version: "P8" },
      { id: "shop", name: "订单系统", policy_version: "P8" },
      { id: "personal", name: "个人笔记", policy_version: "P8" }
    ],
    overview: overview,
    blackboard: function (projectId) {
      return { project_id: projectId, lanes: lanesFor(projectId), stream_after: 12648430 };
    },
    trace: function (correlationId) {
      return { correlation_id: correlationId, chain: CHAINS[correlationId] || genericChain(correlationId) };
    },
    stream: STREAM,
    attention: { max_cards_per_owner_per_hour: 4, max_questions_per_ticket: 2, max_words_per_card: 100, digest_after: 3 },
    approvalCategories: {
      delete: "gate", restart: "gate", spend: "gate", external_message: "gate",
      merge: "escalate", read_only: "off", routine: "notify"
    }
  };
})();
