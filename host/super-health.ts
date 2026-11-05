// L1 host. A closed, testable health loop with no external dependencies:
//   component reports -> HealthBoard (one writer per entry) -> Watchdog ladder
//   -> HealingActor interface -> in-memory action log -> recovery report.
//
// The actor is an interface on purpose. A production host can inject an actor that really
// restarts a worker or rebuilds a projection; this module never touches a process, the network
// or the filesystem. Health is runtime state, not a fact: transient errors must not enter the
// append-only log or occupy the person's board.
import type { HealthEntry, HealingAction, Level, WatchdogPolicy } from "./super-watchdog.ts";
import { HealthBoard, Watchdog } from "./super-watchdog.ts";

/** The only extension point a real host needs to implement. */
export interface HealingActor {
  apply(action: HealingAction, entry: HealthEntry, now: number): void;
}

/** Default actor: records the action. Deliberately does nothing to the outside world. */
export class InMemoryHealingActor implements HealingActor {
  readonly applied: Array<{ at: number; action: HealingAction }> = [];

  apply(action: HealingAction, _entry: HealthEntry, now: number): void {
    this.applied.push({ at: now, action });
  }
}

export interface HealthReportInput {
  component: string;
  owner: string;
  ok: boolean;
  code?: string;
  now: number;
}

export interface HealthActionRecord {
  at: number;
  level: Level;
  component: string;
  action: HealingAction["action"];
  code?: string;
  delay_ms?: number;
}

export interface HealthCardRecord {
  key: string;
  title: string;
  text: string;
  options: string[];
  at: number;
  component: string;
}

export interface HealthPlaneOptions {
  components: string[];
  policy: WatchdogPolicy;
  now: () => number;
  actor?: HealingActor;
}

const NAME_RE = /^[A-Za-z0-9_:.-]{1,64}$/;

export class HealthPlane {
  readonly board: HealthBoard;
  readonly watchdog: Watchdog;
  private readonly actor: HealingActor;
  private readonly nowFn: () => number;
  private readonly actionLog: HealthActionRecord[] = [];
  private readonly cardLog: HealthCardRecord[] = [];
  private transientAbsorbed = 0;

  constructor(options: HealthPlaneOptions) {
    this.nowFn = options.now;
    this.actor = options.actor ?? new InMemoryHealingActor();
    this.board = new HealthBoard(options.policy.transient_failure_threshold);
    for (const name of options.components) this.board.claim(name, name, options.now());
    this.watchdog = new Watchdog(this.board, options.policy, options.now);
  }

  static validName(value: unknown): value is string {
    return typeof value === "string" && NAME_RE.test(value);
  }

  /** A component's first report registers its entry; later reports must come from the same owner. */
  report(input: HealthReportInput): { entry: HealthEntry; actions: HealthActionRecord[] } {
    if (!this.board.get(input.component)) this.board.claim(input.component, input.owner, input.now);
    const entry = this.board.report(input.component, input.owner, input.ok, input.code, input.now);
    return { entry, actions: this.evaluateOne(entry, input.now) };
  }

  /** Explicit check, driven by a request and never by a timer: a suspended plane costs zero processes. */
  evaluateAll(now = this.nowFn()): HealthActionRecord[] {
    const actions: HealthActionRecord[] = [];
    for (const entry of this.board.all()) actions.push(...this.evaluateOne(entry, now));
    return actions;
  }

  private evaluateOne(entry: HealthEntry, now: number): HealthActionRecord[] {
    const action = this.watchdog.evaluate(entry);
    if (!action) return [];
    this.actor.apply(action, entry, now);
    const record: HealthActionRecord = {
      at: now,
      level: action.level,
      component: action.entry,
      action: action.action,
      code: entry.last_error_code,
      delay_ms: action.delay_ms,
    };
    this.actionLog.push(record);
    if (action.level === 0) this.transientAbsorbed += 1;
    if (action.card) this.cardLog.push({ ...action.card, at: now, component: action.entry });
    return [record];
  }

  entries(): HealthEntry[] {
    return this.board.all();
  }
  actions(): HealthActionRecord[] {
    return [...this.actionLog];
  }
  cards(): HealthCardRecord[] {
    return [...this.cardLog];
  }
  /** Transient failures absorbed by L0 retries: one number, never a wall of errors. */
  suppressed(): number {
    return this.transientAbsorbed;
  }
  status(): "ok" | "degraded" | "failing" {
    const entries = this.board.all();
    if (entries.some((entry) => entry.state === "failing")) return "failing";
    return entries.some((entry) => entry.state !== "ok") ? "degraded" : "ok";
  }
}
