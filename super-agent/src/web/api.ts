// Reserved Web API contract. Types only, no implementation. Sits under /v1/super/* so the
// upstream /v1 protocol stays byte-for-byte compatible. Every write is an explicit command.
export const PREFIX = "/v1/super";

export type Method = "GET" | "POST" | "DELETE";
export type Access = "read" | "command" | "debug";

export interface Route {
  method: Method;
  path: string;
  access: Access;
  auth: "owner" | "owner-or-source" | "owner-or-worker";
  summary: string;
}

/** Reused upstream: unchanged, kept here so a frontend has one typed catalog. */
export const UPSTREAM_ROUTES: Route[] = [
  { method: "GET", path: "/v1/state", access: "read", auth: "owner", summary: "全局状态（保持兼容）" },
  { method: "GET", path: "/v1/stream", access: "read", auth: "owner", summary: "事实 SSE，支持 after/branch/project" },
  { method: "GET", path: "/v1/runs/:id/why", access: "read", auth: "owner", summary: "一轮的来龙去脉" },
  { method: "POST", path: "/v1/cards/:id/answer", access: "command", auth: "owner-or-source", summary: "回答卡片" },
  { method: "POST", path: "/v1/runs/:id/cancel", access: "command", auth: "owner", summary: "取消一轮" },
  { method: "DELETE", path: "/v1/keys/:kind/:name", access: "command", auth: "owner", summary: "立即撤销密钥" },
  { method: "POST", path: "/v1/events", access: "command", auth: "owner-or-source", summary: "来源提交事件" },
  { method: "POST", path: "/v1/in/:source", access: "command", auth: "owner-or-source", summary: "Webhook 入口" },
];

export const RESERVED_ROUTES: Route[] = [
  // Dashboard + Blackboard (read-mostly)
  { method: "GET", path: `${PREFIX}/overview`, access: "read", auth: "owner", summary: "仪表盘三问" },
  { method: "GET", path: `${PREFIX}/blackboard`, access: "read", auth: "owner", summary: "看板泳道" },
  { method: "GET", path: `${PREFIX}/projects`, access: "read", auth: "owner", summary: "项目、预算、健康" },
  { method: "GET", path: `${PREFIX}/health`, access: "read", auth: "owner", summary: "HealthBoard 全量" },
  { method: "GET", path: `${PREFIX}/policy`, access: "read", auth: "owner", summary: "当前策略与版本" },
  { method: "GET", path: `${PREFIX}/policy/history`, access: "read", auth: "owner", summary: "策略版本历史" },
  { method: "GET", path: `${PREFIX}/grants/:id`, access: "read", auth: "owner", summary: "授权与复验记录" },

  // Audit / trace
  { method: "GET", path: `${PREFIX}/trace/:correlation_id`, access: "read", auth: "owner", summary: "完整因果链" },
  { method: "GET", path: `${PREFIX}/audit/trace/:run_id`, access: "read", auth: "owner", summary: "审计视图" },
  { method: "GET", path: `${PREFIX}/attention`, access: "read", auth: "owner", summary: "注意力预算计量" },

  // Commands (write). Same HTTP interface as CLI / MCP.
  {
    method: "POST",
    path: `${PREFIX}/eval/:id/decision`,
    access: "command",
    auth: "owner",
    summary: "主会话评估结论写回",
  },
  { method: "POST", path: `${PREFIX}/approvals/:id/answer`, access: "command", auth: "owner", summary: "审批回答" },
  { method: "POST", path: `${PREFIX}/grants/:id/revoke`, access: "command", auth: "owner", summary: "撤销授权" },
  { method: "POST", path: `${PREFIX}/policy/save`, access: "command", auth: "owner", summary: "CAS 保存策略" },
  { method: "POST", path: `${PREFIX}/processing/pause`, access: "command", auth: "owner", summary: "暂停/恢复处理" },
  { method: "POST", path: `${PREFIX}/watchdog/check`, access: "command", auth: "owner", summary: "手动健康检查" },

  // Debug (branches only; never affects main)
  { method: "GET", path: `${PREFIX}/breakpoints`, access: "read", auth: "owner", summary: "分支断点" },
  { method: "GET", path: `${PREFIX}/debug/stream`, access: "read", auth: "owner", summary: "重放/断点 SSE" },
  { method: "POST", path: `${PREFIX}/replay`, access: "debug", auth: "owner", summary: "只读重放" },
  { method: "POST", path: `${PREFIX}/fork`, access: "debug", auth: "owner", summary: "创建分支" },
  { method: "POST", path: `${PREFIX}/breakpoints`, access: "debug", auth: "owner", summary: "注册/清除断点" },
];

/** Common envelope. New fields are optional; old clients ignore unknown fields. */
export interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
  policy_version?: string;
  stream_after?: number; // client uses this with GET /v1/stream?after=
  now: number;
}

export interface TraceResponse {
  correlation_id: string;
  project_id: string;
  chain: Array<{
    seq: number;
    type: string;
    actor?: string;
    trust?: string;
    hops: number;
    policy_version?: string;
    grant_id?: string;
    reason?: string;
  }>;
  attention: { cards: number; questions: number; words: number };
  cost: { tokens: number; usd: number };
  policy_versions: string[];
  verdict: "consistent" | "inconsistent";
}

/**
 * Hard constraints. M3 implements them in host/super-api.ts: same-origin with a loopback
 * exception for file:// pages (reads only), owner-key auth for every command on every host,
 * a 64 KB body limit, instruction-field rejection, and a recursive response scrub for
 * neverExpose. Every command produces exactly one fact through commit().
 */
export const CONSTRAINTS = {
  sameOriginOnly: true,
  maxBodyBytes: 64 * 1024,
  defaultListen: "127.0.0.1",
  neverExpose: [
    "key_hash",
    "run_token",
    "card_link_token",
    "master_key",
    "prompt_text",
    "credentials",
    "model_call_details",
  ],
  writesRequireExplicitCommand: true,
} as const;
