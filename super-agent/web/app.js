/* 仪表盘 + Blackboard 看板。只消费 docs/04 的预留接口；后端不可达时自动使用演示数据。 */
(function () {
  "use strict";

  var M = window.SUPERAGENT_MOCK;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var age = function (m) {
    if (m < 1) return "刚刚";
    if (m < 60) return m + " 分钟";
    if (m < 1440) return Math.round(m / 60) + " 小时";
    return Math.round(m / 1440) + " 天";
  };

  var state = {
    mode: "demo",
    apiBase: "http://127.0.0.1:8787",
    projectId: "home-deco",
    approvalMode: "gate",
    laneFilter: null,
    query: "",
    collapsed: { done: true },
    streamPaused: false,
    healthOpen: false,
    items: {},
    overview: null,
    selected: null,
    drawerTab: "trace",
    replayStep: 0,
    replayTimer: null,
    breakpoints: [
      { id: "bp-1", expr: "meta.hops >= 6", action: "pause", active: true },
      { id: "bp-2", expr: "type = grant.revoked", action: "pause", active: false }
    ],
    streamIndex: 0,
    streamTimer: null,
    eventSource: null,
    lastSeq: 12648430,
    factCount: 0
  };

  /* ---------- data ---------- */

  function ensureItems(projectId) {
    if (state.items[projectId]) return state.items[projectId];
    var board = M.blackboard(projectId);
    var list = [];
    board.lanes.forEach(function (lane) {
      lane.items.forEach(function (i) { list.push(Object.assign({}, i, { lane: lane.id })); });
    });
    state.items[projectId] = list;
    return list;
  }

  function visibleItems() {
    return ensureItems(state.projectId).filter(function (i) {
      if (state.approvalMode === "off" && i.kind === "approval.required") return false;
      if (state.laneFilter && i.lane !== state.laneFilter) return false;
      if (state.query) {
        var q = state.query.toLowerCase();
        var hay = [i.title, i.id, i.correlation_id, i.kind, i.preview].join(" ").toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    }).map(function (i) {
      if (state.approvalMode === "notify" && i.kind === "approval.required") {
        return Object.assign({}, i, { tag: "fyi", actions: ["open_trace"], state: "fyi" });
      }
      if (state.approvalMode === "escalate" && i.kind === "approval.required") {
        return Object.assign({}, i, { tag: "escalate" });
      }
      return i;
    });
  }

  function laneItems(laneId) {
    return visibleItems().filter(function (i) { return i.lane === laneId; });
  }

  function waitingItems() { return laneItems("waiting_person"); }

  function modeNote() {
    var n = ensureItems(state.projectId).filter(function (i) { return i.kind === "approval.required" && i.lane === "waiting_person"; }).length;
    var text = {
      off: "off：高风险动作按规则直接放行，不产生卡片；当前 " + n + " 项审批已从「待人」中移除。",
      notify: "notify：只发一张不带按钮的灰卡留痕，不阻断本轮、不挂起。",
      gate: "gate：阻断本轮，发带选项卡片并挂起零消耗；超时默认 deny。",
      escalate: "escalate：前 2 次自动处理，超阈值或研判置信度低时才升为 gate。"
    }[state.approvalMode];
    return text + "　演示模式下只改变本地展示，不会写回后端；真实模式需调用 /v1/super/policy/save 保存。";
  }

  /* ---------- api ---------- */

  function fetchJSON(path, opts) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 2000);
    return fetch(state.apiBase.replace(/\/$/, "") + path, Object.assign({ signal: ctrl.signal }, opts || {}))
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .finally(function () { clearTimeout(timer); });
  }

  function unwrap(payload) { return payload && payload.data ? payload.data : payload; }

  function refreshLive() {
    if (state.mode !== "live") { renderAll(); return; }
    var p = encodeURIComponent(state.projectId);
    Promise.all([
      fetchJSON("/v1/super/overview?project=" + p),
      fetchJSON("/v1/super/blackboard?project=" + p)
    ]).then(function (res) {
      state.overview = unwrap(res[0]);
      var board = unwrap(res[1]);
      if (board && board.lanes) {
        var list = [];
        board.lanes.forEach(function (lane) {
          (lane.items || []).forEach(function (i) { list.push(Object.assign({}, i, { lane: lane.id })); });
        });
        state.items[state.projectId] = list;
      }
      renderAll();
    }).catch(function () {
      state.mode = "demo"; state.overview = null;
      startDemoStream(); renderAll();
      toast("读取真实数据失败，已切回演示数据");
    });
  }

  function tryConnect(silent) {
    fetchJSON("/v1/super/overview").then(function (data) {
      state.mode = "live";
      state.overview = unwrap(data);
      closeDemoStream();
      startEventSource();
      refreshLive();
      if (!silent) toast("已连接真实后端");
    }).catch(function () {
      state.mode = "demo";
      state.overview = null;
      if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
      startDemoStream();
      renderAll();
      if (!silent) toast("后端不可达，已切换到演示数据");
    });
  }

  function currentOverview() {
    if (state.overview && state.mode === "live") return state.overview;
    var o = M.overview(state.projectId);
    o.needs_person = { count: waitingItems().length, items: waitingItems() };
    return o;
  }

  /* ---------- rendering ---------- */

  function renderAll() {
    renderHeader();
    renderNeeds();
    renderHealth();
    renderMetrics();
    renderLaneTabs();
    renderBoard();
    renderFooter();
    if (state.selected) renderDrawer();
  }

  function renderHeader() {
    var sel = $("project-select");
    if (!sel.options.length) {
      M.projects.forEach(function (p) {
        var o = document.createElement("option");
        o.value = p.id; o.textContent = p.name;
        sel.appendChild(o);
      });
      sel.value = state.projectId;
    }
    $("approval-select").value = state.approvalMode;
    var badge = $("mode-badge");
    badge.textContent = state.mode === "live" ? "真实后端" : "演示数据";
    badge.className = "badge" + (state.mode === "live" ? " live" : "");
    var banner = $("mode-banner");
    banner.className = "banner" + (state.mode === "live" ? " live" : "");
    banner.innerHTML = state.mode === "live"
      ? '<span>已连接 <b>' + esc(state.apiBase) + '</b>：写操作会调用命令端点，请谨慎操作。</span><span class="banner-inline">只读为主 · 破坏性操作二次确认</span>'
      : '<span>当前为<b>演示数据</b>：所有交互都在本地生效，不会写入真实系统。</span>' +
        '<span class="banner-inline">API 地址 <input id="api-base" type="text" value="' + esc(state.apiBase) + '" spellcheck="false">' +
        '<button data-act="connect" class="btn btn-small">重试连接</button></span>';
  }

  function renderNeeds() {
    var list = waitingItems();
    $("needs-count").textContent = list.length;
    $("needs-count").className = "count" + (list.length ? "" : " zero");
    var host = $("needs-list");
    if (!list.length) {
      host.innerHTML = '<p class="empty">没有需要你处理的事。健康状态不占版面。</p>';
    } else {
      host.innerHTML = list.map(function (i) {
        var buttons = (i.actions || ["open_trace"]).map(function (a) {
          var label = { approve: "批准", deny: "拒绝", retry: "重试", stop: "停止", open_trace: "追踪" }[a] || a;
          var cls = "btn btn-small" + (a === "approve" ? " btn-primary" : "") + (a === "deny" || a === "stop" ? " btn-danger" : "");
          return '<button class="' + cls + '" data-act="' + a + '" data-id="' + esc(i.id) + '">' + label + "</button>";
        }).join("");
        return '<div class="need-row"><div class="need-main"><h3>' + esc(i.title) + "</h3>" +
          '<div class="need-meta">' + esc(i.kind) + " · 等 " + esc(i.waiting_for || "-") + " · " + age(i.age_minutes) +
          " · hops " + i.hops + " · " + esc(i.policy_version) + "</div></div>" +
          '<div class="need-actions">' + buttons + "</div></div>";
      }).join("");
    }
    $("approval-hint").textContent = modeNote();
  }

  function renderHealth() {
    var o = currentOverview();
    var probs = (o.health && o.health.problems) || [];
    $("health-status").className = "dot" + (probs.length ? " degraded" : "");
    $("health-summary").textContent = probs.length
      ? probs.length + " 个问题 · " + (o.health.suppressed || 0) + " 次瞬时错误已抑制"
      : "正常 · " + (o.health.suppressed || 0) + " 次瞬时错误已抑制";
    $("health-toggle").setAttribute("aria-expanded", state.healthOpen ? "true" : "false");
    $("health-body").hidden = !state.healthOpen;
    $("health-body").innerHTML = probs.length
      ? probs.map(function (p) {
          return '<div class="health-row"><span>' + esc(p.entry) + " · " + esc(p.since) +
            '</span><span class="code">' + esc(p.code) + "</span></div>";
        }).join("") + '<p class="empty">一次性网络错误不升级；连续 3 次才进这里。</p>'
      : '<p class="empty">健康状态不占版面：没有问题需要你处理。</p>';
  }

  function renderMetrics() {
    var a = currentOverview().activity_24h || {};
    var defs = [
      ["事件", a.triggers], ["研判", a.evals], ["接单", a.accepted], ["轮次", a.runs],
      ["卡片", a.cards], ["问题", a.questions], ["Token", a.tokens], ["费用 ¥", a.cost_usd]
    ];
    $("metrics").innerHTML = defs.map(function (d) {
      var v = typeof d[1] === "number" ? (d[1] >= 1000 ? Math.round(d[1] / 1000) + "k" : d[1]) : (d[1] || 0);
      return '<div class="metric"><div class="label">' + d[0] + '</div><div class="value">' + esc(v) + "</div></div>";
    }).join("");
    var att = a.attention || {};
    var limit = M.attention.max_cards_per_owner_per_hour;
    var over = (att.cards_per_owner_hour || 0) > limit;
    $("attention").innerHTML =
      '<span class="chip">卡片/人/小时 ' + (att.cards_per_owner_hour || 0) + " / " + limit + "</span>" +
      '<span class="chip">可行动占比 ' + Math.round((att.actionable_ratio || 0) * 100) + "%</span>" +
      '<span class="chip">worker ' + ((a.worker_load || {}).running || 0) + " / " + ((a.worker_load || {}).capacity || 4) + "</span>" +
      '<span class="chip' + (over ? " warn" : "") + '">' + (over ? "超出注意力预算，将合并为摘要卡" : "注意力预算内，默认安静") + "</span>";
  }

  function renderLaneTabs() {
    var lanes = M.lanes;
    $("lane-tabs").innerHTML =
      '<button class="lane-tab' + (state.laneFilter ? "" : " active") + '" data-act="lane" data-id="">全部 <span class="n">' + visibleItems().length + "</span></button>" +
      lanes.map(function (l) {
        var n = laneItems(l.id).length;
        return '<button class="lane-tab' + (state.laneFilter === l.id ? " active" : "") + '" data-act="lane" data-id="' + l.id + '">' +
          esc(l.label) + ' <span class="n">' + n + "</span></button>";
      }).join("");
  }

  function tagClass(tag) {
    if (tag === "gate" || tag === "tripped" || tag === "blocked" || tag === "alert") return "red";
    if (tag === "escalate" || tag === "observe" || tag === "dedup") return "amber";
    if (tag === "grant" || tag === "llm" || tag === "fyi") return "blue";
    return "";
  }

  function renderBoard() {
    var lanes = M.lanes.filter(function (l) { return !state.laneFilter || state.laneFilter === l.id; });
    $("board").innerHTML = lanes.map(function (lane) {
      var items = laneItems(lane.id);
      var collapsed = !!state.collapsed[lane.id];
      var cards = items.length
        ? items.map(function (i) {
            var acts = (i.lane === "waiting_person" && i.actions && i.actions.length > 1)
              ? '<div class="card-actions">' + i.actions.filter(function (a) { return a !== "open_trace"; }).map(function (a) {
                  var label = { approve: "批准", deny: "拒绝", retry: "重试", stop: "停止" }[a] || a;
                  return '<button class="btn btn-small" data-act="' + a + '" data-id="' + esc(i.id) + '">' + label + "</button>";
                }).join("") + "</div>"
              : "";
            return '<div class="card' + (i.tag === "gate" || i.tag === "tripped" ? " alert" : "") + '" data-act="open" data-id="' + esc(i.id) + '">' +
              "<h4>" + esc(i.title) + "</h4>" +
              '<div class="meta">' + esc(i.kind) + " · " + esc(i.id) + " · hops " + i.hops + "</div>" +
              (i.preview ? '<div class="meta">' + esc(i.preview) + "</div>" : "") +
              (i.tag ? '<span class="tag ' + tagClass(i.tag) + '">' + esc(i.tag) + "</span>" : "") +
              acts + "</div>";
          }).join("")
        : '<p class="empty">空</p>';
      return '<div class="lane' + (collapsed ? " collapsed" : "") + '"><div class="lane-head"><h3>' + esc(lane.label) +
        ' <span class="n">' + items.length + '</span></h3><button class="lane-toggle" data-act="collapse" data-id="' + lane.id + '">' +
        (collapsed ? "展开" : "折叠") + '</button></div><div class="lane-items">' + (collapsed ? "" : cards) + "</div></div>";
    }).join("");
  }

  function renderFooter() {
    $("footer-stats").textContent = "模式 " + state.mode + " · 项目 " + state.projectId +
      " · 审批 " + state.approvalMode + " · 事实 " + state.factCount + " · stream_after " + state.lastSeq +
      " · 事实流" + (state.streamPaused ? "已暂停" : "运行中");
  }

  /* ---------- drawer ---------- */

  function breakpointHit(step) {
    return state.breakpoints.filter(function (bp) {
      if (!bp.active) return false;
      if (bp.expr.indexOf("hops") !== -1) return (step.hops || 0) >= 6;
      if (bp.expr.indexOf("type") !== -1) return step.type === bp.expr.split("=")[1].trim();
      return false;
    });
  }

  function openDrawer(id) {
    var item = ensureItems(state.projectId).filter(function (i) { return i.id === id; })[0];
    if (!item) return;
    state.selected = item;
    state.drawerTab = "trace";
    state.replayStep = 0;
    stopReplay();
    $("drawer").hidden = false;
    $("drawer-mask").hidden = false;
    $("drawer-title").textContent = item.title;
    renderDrawer();
  }

  function closeDrawer() {
    stopReplay();
    state.selected = null;
    $("drawer").hidden = true;
    $("drawer-mask").hidden = true;
  }

  function renderDrawer() {
    var item = state.selected;
    if (!item) return;
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.tab === state.drawerTab);
    });
    var body = $("drawer-body");
    if (state.drawerTab === "trace") {
      var tr = state.mode === "live"
        ? null
        : M.trace(item.correlation_id);
      if (state.mode === "live") {
        fetchJSON("/v1/super/trace/" + encodeURIComponent(item.correlation_id))
          .then(function (d) { if (state.selected === item) { drawTrace(d.chain || [], item); } })
          .catch(function () { drawTrace(M.trace(item.correlation_id).chain, item); });
        body.innerHTML = '<p class="empty">正在读取因果链…</p>';
        return;
      }
      drawTrace(tr.chain, item);
    } else if (state.drawerTab === "replay") {
      drawReplay(item);
    } else {
      drawPolicy(item);
    }
  }

  function drawTrace(chain, item) {
    $("drawer-body").innerHTML =
      '<p class="note">通用审计追踪：因果链、策略版本、授权与审批。<b>不记录模型调用明细</b>，也不生成模型摘要。</p>' +
      '<div class="kv" style="margin-top:14px"><span class="k">correlation_id</span><span class="v">' + esc(item.correlation_id) + "</span>" +
      '<span class="k">policy_version</span><span class="v">' + esc(item.policy_version) + "</span>" +
      '<span class="k">grant_id</span><span class="v">' + esc(item.grant_id || "-") + "</span>" +
      '<span class="k">hops</span><span class="v">' + item.hops + "（人工回答/定时复查不清零）</span></div>" +
      '<div class="trace">' + chain.map(function (s, idx) {
        var hits = breakpointHit(s);
        return '<div class="trace-step' + (hits.length ? " hit" : "") + '" data-step="' + idx + '">' +
          '<div class="seq">seq ' + s.seq + "</div>" +
          '<div class="type">' + esc(s.type) + "</div>" +
          '<div class="detail">' + esc(s.detail || "") + (s.actor ? " · " + esc(s.actor) : "") +
          (s.policy_version ? " · " + esc(s.policy_version) : "") + " · hops " + (s.hops || 0) + "</div>" +
          (s.reason ? '<div class="reason">' + esc(s.reason) + "</div>" : "") +
          (hits.length ? '<div class="reason">断点命中：' + esc(hits[0].expr) + "</div>" : "") +
          "</div>";
      }).join("") + "</div>";
  }

  function chainFor(item) { return M.trace(item.correlation_id).chain; }

  function drawReplay(item) {
    var chain = chainFor(item);
    var step = Math.min(state.replayStep, chain.length);
    var hits = step < chain.length ? breakpointHit(chain[step]) : [];
    $("drawer-body").innerHTML =
      '<div class="replay-controls">' +
        '<button class="btn btn-small" data-act="replay-prev">上一步</button>' +
        '<button class="btn btn-small" data-act="replay-next">下一步</button>' +
        '<button class="btn btn-small" data-act="replay-play">' + (state.replayTimer ? "暂停播放" : "自动播放") + "</button>" +
        '<button class="btn btn-small" data-act="replay-reset">重置</button>' +
      "</div>" +
      '<div class="replay-state"><b>只读重放</b> · 分支 <b>whatif/demo</b> · 进度 ' + step + " / " + chain.length +
      "<br>只调用 evolve，不调用 decide、不重跑模型、不发卡片。</div>" +
      '<div class="replay-state">' + (step >= chain.length
        ? "重放结束：投影校验和与在线一致。"
        : "当前：seq " + chain[step].seq + " · " + esc(chain[step].type) +
          (hits.length ? '<br><b>断点暂停</b> · ' + esc(hits[0].expr) + "（可单步继续）" : "")) + "</div>" +
      '<div class="trace">' + chain.slice(0, step).map(function (s, idx) {
        return '<div class="trace-step' + (breakpointHit(s).length ? " hit" : "") + '">' +
          '<div class="seq">seq ' + s.seq + '</div><div class="type">' + esc(s.type) + '</div>' +
          '<div class="detail">' + esc(s.detail || "") + "</div></div>";
      }).join("") + "</div>" +
      '<h3 style="margin:18px 0 8px;font-size:13px;font-weight:500">断点（仅分支生效）</h3>' +
      '<div class="bp-list">' + state.breakpoints.map(function (bp) {
        return '<div class="bp-item"><span><span class="expr">' + esc(bp.expr) + "</span> · " + esc(bp.action) + "</span>" +
          '<button class="btn btn-small" data-act="bp-toggle" data-id="' + bp.id + '">' + (bp.active ? "停用" : "启用") + "</button></div>";
      }).join("") + "</div>" +
      '<p class="note" style="margin-top:12px">生产 main 分支只读、永不回滚；fork/断点只影响分支投影。</p>';
  }

  function drawPolicy(item) {
    var cat = item.category || "merge";
    var effective = state.approvalMode;
    $("drawer-body").innerHTML =
      '<div class="kv">' +
        '<span class="k">项目</span><span class="v">' + esc(item.project_id) + "</span>" +
        '<span class="k">policy_version</span><span class="v">' + esc(item.policy_version) + "</span>" +
        '<span class="k">动作类别</span><span class="v">' + esc(cat) + "</span>" +
        '<span class="k">类别默认</span><span class="v">' + esc(M.approvalCategories[cat] || "gate") + "</span>" +
        '<span class="k">当前模式</span><span class="v">' + esc(effective) + "</span>" +
        '<span class="k">grant_id</span><span class="v">' + esc(item.grant_id || "-") + "</span>" +
        '<span class="k">hops</span><span class="v">' + item.hops + "</span>" +
      "</div>" +
      '<h3 style="font-size:13px;font-weight:500;margin-bottom:8px">授权复验与撤销</h3>' +
      '<p class="note">唤醒前按当前 Policy 复验 Mandate：规则仍启用、发送人仍在名单、accept_mode 仍为 auto。策略变更只发 policy_changed Input，<b>不立即撤销</b>在途授权；复验失败才写 grant.revoked。密钥、轮次 token、Mandate 三层都可立即撤销。</p>' +
      '<div class="replay-controls" style="margin-top:14px">' +
        '<button class="btn btn-small btn-danger" data-act="revoke" data-id="' + esc(item.grant_id || "g-demo") + '">撤销授权（二次确认）</button>' +
        '<button class="btn btn-small" data-act="toggle-processing">暂停 / 恢复处理</button>' +
      "</div>";
  }

  function stopReplay() {
    if (state.replayTimer) { clearInterval(state.replayTimer); state.replayTimer = null; }
  }

  /* ---------- actions ---------- */

  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 2400);
  }

  function findItem(id) {
    return ensureItems(state.projectId).filter(function (i) { return i.id === id; })[0];
  }

  function resolveItem(id, choice) {
    var i = findItem(id);
    if (!i) return;
    i.lane = "done";
    i.state = choice;
    i.tag = choice === "approve" ? "granted" : "denied";
    i.actions = ["open_trace"];
    i.preview = choice === "approve" ? "审批通过 · 写 approval.granted 事实" : "审批拒绝 · 写 approval.denied 事实";
    state.factCount += 1;
    state.lastSeq += 1;
    if (state.mode === "live") {
      fetchJSON("/v1/super/approvals/" + encodeURIComponent(id) + "/answer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice: choice, by: "owner" })
      }).catch(function (e) { toast("命令失败：" + e.message); });
    }
    renderAll();
    toast(choice === "approve" ? "已批准，授权复验后原会话续接" : "已拒绝，本轮按未获授权处理");
  }

  function startDemoStream() {
    if (state.streamTimer) return;
    state.streamTimer = setInterval(function () {
      if (state.streamPaused || state.mode !== "demo") return;
      var f = M.stream[state.streamIndex % M.stream.length];
      state.streamIndex += 1;
      var list = ensureItems(state.projectId);
      var copy = Object.assign({}, f.item, {
        id: f.item.id + "-" + state.streamIndex,
        correlation_id: "c-live-" + state.streamIndex,
        project_id: state.projectId,
        lane: f.lane,
        age_minutes: 0
      });
      list.unshift(copy);
      state.factCount += 1;
      state.lastSeq += 1;
      renderLaneTabs();
      renderBoard();
      renderFooter();
    }, 6000);
  }

  function closeDemoStream() {
    if (state.streamTimer) { clearInterval(state.streamTimer); state.streamTimer = null; }
  }

  function startEventSource() {
    if (state.eventSource) state.eventSource.close();
    if (typeof EventSource === "undefined") return;
    try {
      state.eventSource = new EventSource(state.apiBase.replace(/\/$/, "") + "/v1/stream?after=" + state.lastSeq);
      state.eventSource.onmessage = function (e) {
        if (state.streamPaused) return;
        try {
          var fact = JSON.parse(e.data);
          state.lastSeq = fact.seq || state.lastSeq + 1;
          state.factCount += 1;
          renderFooter();
        } catch (err) { /* ignore malformed frame */ }
      };
      state.eventSource.onerror = function () { toast("事实流断开，已保留当前视图"); };
    } catch (err) { /* no SSE available */ }
  }

  /* ---------- events ---------- */

  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-act]");
    if (!el) return;
    var act = el.dataset.act, id = el.dataset.id;
    if (act === "connect") { state.apiBase = ($("api-base") || {}).value || state.apiBase; tryConnect(false); return; }
    if (act === "lane") { state.laneFilter = id || null; renderLaneTabs(); renderBoard(); return; }
    if (act === "collapse") { state.collapsed[id] = !state.collapsed[id]; renderBoard(); return; }
    if (act === "open") { openDrawer(id); return; }
    if (act === "open_trace") { openDrawer(id); return; }
    if (act === "approve") { resolveItem(id, "approve"); return; }
    if (act === "deny") { if (window.confirm("确认拒绝？该动作不可撤销。")) resolveItem(id, "deny"); return; }
    if (act === "retry") { resolveItem(id, "approve"); return; }
    if (act === "stop") { if (window.confirm("确认停止该工单？会撤回授权。")) resolveItem(id, "deny"); return; }
    if (act === "drawer-close" || act === "mask") { closeDrawer(); return; }
    if (act === "tab") { state.drawerTab = el.dataset.tab; renderDrawer(); return; }
    if (act === "replay-prev") { state.replayStep = Math.max(0, state.replayStep - 1); renderDrawer(); return; }
    if (act === "replay-next") { state.replayStep += 1; renderDrawer(); return; }
    if (act === "replay-reset") { state.replayStep = 0; stopReplay(); renderDrawer(); return; }
    if (act === "replay-play") {
      if (state.replayTimer) { stopReplay(); renderDrawer(); return; }
      state.replayTimer = setInterval(function () {
        var chain = state.selected ? chainFor(state.selected) : [];
        if (state.replayStep >= chain.length) { stopReplay(); renderDrawer(); return; }
        state.replayStep += 1;
        renderDrawer();
      }, 900);
      renderDrawer();
      return;
    }
    if (act === "bp-toggle") {
      state.breakpoints.forEach(function (bp) { if (bp.id === id) bp.active = !bp.active; });
      renderDrawer();
      return;
    }
    if (act === "revoke") {
      if (!window.confirm("确认撤销该授权？在途轮次会被取消，唤醒复验将拒绝。")) return;
      state.factCount += 1; state.lastSeq += 1;
      if (state.mode === "live") {
        fetchJSON("/v1/super/grants/" + encodeURIComponent(id) + "/revoke", { method: "POST" })
          .catch(function (err) { toast("命令失败：" + err.message); });
      }
      toast("已写 grant.revoked 事实并广播撤销"); renderAll(); return;
    }
    if (act === "toggle-processing") { toast("已发送暂停 / 恢复命令（演示模式仅提示）"); return; }
  });

  $("project-select").addEventListener("change", function (e) {
    state.projectId = e.target.value;
    state.overview = null;
    state.laneFilter = null;
    state.query = "";
    $("search-input").value = "";
    ensureItems(state.projectId);
    renderAll();
    refreshLive();
  });

  $("approval-select").addEventListener("change", function (e) {
    state.approvalMode = e.target.value;
    renderAll();
    toast("审批模式已切换为 " + state.approvalMode);
  });

  $("search-input").addEventListener("input", function (e) {
    state.query = e.target.value.trim();
    renderLaneTabs();
    renderBoard();
  });

  document.addEventListener("input", function (e) {
    if (e.target && e.target.id === "api-base") state.apiBase = e.target.value;
  });

  $("health-toggle").addEventListener("click", function () {
    state.healthOpen = !state.healthOpen;
    renderHealth();
  });

  $("drawer").querySelectorAll(".tab").forEach(function (t) { t.dataset.act = "tab"; });
  $("drawer-close").dataset.act = "drawer-close";
  $("drawer-mask").dataset.act = "mask";

  $("btn-connect").addEventListener("click", function () {
    state.apiBase = ($("api-base") || {}).value || state.apiBase;
    tryConnect(false);
  });
  $("btn-clear-filter").addEventListener("click", function () {
    state.laneFilter = null; state.query = ""; $("search-input").value = ""; renderLaneTabs(); renderBoard();
  });
  $("btn-toggle-stream").addEventListener("click", function () {
    state.streamPaused = !state.streamPaused;
    this.textContent = state.streamPaused ? "恢复事实流" : "暂停事实流";
    renderFooter();
    toast(state.streamPaused ? "事实流已暂停" : "事实流已恢复");
  });

  /* boot */
  ensureItems(state.projectId);
  state.overview = null;
  renderAll();
  startDemoStream();
  tryConnect(true);
})();
