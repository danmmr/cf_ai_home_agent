import { createWorkersAI } from "workers-ai-provider";
import { getAgentByName, routeAgentRequest, type Connection } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  type ToolSet,
  type UIMessage
} from "ai";
import { z } from "zod";
import {
  interpolate,
  matchKnownIssue,
  parseConfig,
  type Config,
  type KnownIssue,
  type Monitor,
  type PushMonitor
} from "./config";
import { evaluateRules, probeHttp } from "./checks";
import { lastFireTime, parseCron } from "./cron";
import { notify } from "./notify";
import { dedupedAI } from "./ai-binding";
import { MODEL, type FailureKind, type TriageParams } from "./workflow";
import {
  bearerMatches,
  clearCookie,
  hasSession,
  safeEqual,
  sessionCookie
} from "./auth";

export { TriageWorkflow } from "./workflow";

// One agent instance watches everything; the chat UI talks to the same one.
const AGENT_NAME = "home";
const RETENTION_DAYS = 30;
// a triage stuck longer than this (workflow crashed) no longer blocks a new one
const TRIAGE_TIMEOUT_MS = 30 * 60_000;
const MAX_REPORT_BYTES = 64 * 1024;

type Status = "ok" | "failing" | "unknown";

export interface MonitorView {
  id: string;
  name: string;
  type: Monitor["type"];
  status: Status;
  since: number | null;
  lastSeen: number | null;
  detail: string;
}

export interface AgentState {
  configured: boolean;
  monitors: MonitorView[];
  openIncidents: number;
  updatedAt: number;
}

interface MonitorRow {
  id: string;
  status: Status;
  since: number | null;
  created: number;
  last_check: number | null;
  last_ok: number | null;
  detail: string;
  token: string | null;
  triage_started: number | null;
  due_marks: string;
}

interface IncidentRow {
  id: number;
  monitor: string;
  opened: number;
  resolved: number | null;
  title: string;
  summary: string;
  cause: string;
  fix: string;
  detail: string;
  known_issue: string | null;
  can_fix: number;
  resolution: string | null;
}

export interface TriageContext {
  stillFailing: boolean;
  name: string;
  description?: string;
  runbook: string;
  detail: string;
  failingSince?: string | null;
  lastHealthy?: string;
  knownIssue: KnownIssue | null;
  recent?: unknown[];
}

export interface IncidentInput {
  title: string;
  summary: string;
  cause: string;
  fix: string;
  detail: string;
  knownIssueId: string | null;
  canFix: boolean;
}

export class HealthAgent extends AIChatAgent<Env, AgentState> {
  initialState: AgentState = {
    configured: false,
    monitors: [],
    openIncidents: 0,
    updatedAt: 0
  };
  maxPersistedMessages = 200;

  private config: Config | null | undefined;
  private lastPrune = 0;

  async onStart() {
    this
      .sql`CREATE TABLE IF NOT EXISTS hw_config (k TEXT PRIMARY KEY, v TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS hw_monitors (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, since INTEGER, created INTEGER NOT NULL,
      last_check INTEGER, last_ok INTEGER, detail TEXT NOT NULL DEFAULT '',
      token TEXT, triage_started INTEGER, due_marks TEXT NOT NULL DEFAULT '{}')`;
    this.sql`CREATE TABLE IF NOT EXISTS hw_checks (
      ts INTEGER NOT NULL, monitor TEXT NOT NULL, ok INTEGER NOT NULL,
      latency INTEGER, detail TEXT NOT NULL)`;
    this
      .sql`CREATE INDEX IF NOT EXISTS hw_checks_idx ON hw_checks (monitor, ts)`;
    this.sql`CREATE TABLE IF NOT EXISTS hw_reports (
      ts INTEGER NOT NULL, monitor TEXT NOT NULL, ok INTEGER NOT NULL,
      message TEXT NOT NULL DEFAULT '', metrics TEXT)`;
    this
      .sql`CREATE INDEX IF NOT EXISTS hw_reports_idx ON hw_reports (monitor, ts)`;
    this.sql`CREATE TABLE IF NOT EXISTS hw_incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, monitor TEXT NOT NULL,
      opened INTEGER NOT NULL, resolved INTEGER, title TEXT NOT NULL,
      summary TEXT NOT NULL, cause TEXT NOT NULL, fix TEXT NOT NULL,
      detail TEXT NOT NULL, known_issue TEXT, can_fix INTEGER NOT NULL DEFAULT 0,
      resolution TEXT)`;
    await this.scheduleEvery(60, "tick");
  }

  // Only the server writes state; browsers just read it.
  validateStateChange(_next: AgentState, source: Connection | "server") {
    if (source !== "server") throw new Error("state is read-only");
  }

  // ── Config ──────────────────────────────────────────────────────────

  private getConfig(): Config | null {
    if (this.config !== undefined) return this.config;
    const row = this.sql<{
      v: string;
    }>`SELECT v FROM hw_config WHERE k = 'monitors'`[0];
    this.config = row ? parseConfig(JSON.parse(row.v)) : null;
    return this.config;
  }

  private monitor(id: string): Monitor | undefined {
    return this.getConfig()?.monitors.find((m) => m.id === id);
  }

  async setConfig(raw: unknown) {
    const config = parseConfig(raw);
    this
      .sql`INSERT OR REPLACE INTO hw_config (k, v) VALUES ('monitors', ${JSON.stringify(raw)})`;
    this.config = config;
    const now = Date.now();
    const ids = config.monitors.map((m) => m.id);
    for (const id of ids) {
      this
        .sql`INSERT OR IGNORE INTO hw_monitors (id, status, created) VALUES (${id}, 'unknown', ${now})`;
    }
    for (const row of this.sql<{ id: string }>`SELECT id FROM hw_monitors`) {
      if (!ids.includes(row.id)) {
        this.sql`DELETE FROM hw_monitors WHERE id = ${row.id}`;
        // a removed monitor can't recover, so close its incidents quietly
        this
          .sql`UPDATE hw_incidents SET resolved = ${now}, resolution = 'monitor removed'
          WHERE monitor = ${row.id} AND resolved IS NULL`;
      }
    }
    this.refreshState();
    return { monitors: ids };
  }

  // ── The loop ────────────────────────────────────────────────────────

  async tick() {
    const config = this.getConfig();
    if (!config) return;
    const now = Date.now();
    await Promise.all(
      config.monitors.map((m) =>
        m.type === "http"
          ? this.maybeProbe(m, now)
          : this.checkExpectations(m, now)
      )
    );
    if (now - this.lastPrune > 3_600_000) {
      const cutoff = now - RETENTION_DAYS * 86_400_000;
      this.sql`DELETE FROM hw_checks WHERE ts < ${cutoff}`;
      this.sql`DELETE FROM hw_reports WHERE ts < ${cutoff}`;
      this.lastPrune = now;
    }
    this.refreshState();
  }

  private row(id: string): MonitorRow | undefined {
    return this.sql<MonitorRow>`SELECT * FROM hw_monitors WHERE id = ${id}`[0];
  }

  private async maybeProbe(m: Monitor & { type: "http" }, now: number) {
    const row = this.row(m.id);
    if (!row) return;
    if (
      row.last_check &&
      now - row.last_check < m.intervalMinutes * 60_000 - 5_000
    )
      return;
    await this.probe(m);
  }

  private async probe(m: Monitor & { type: "http" }) {
    const row = this.row(m.id);
    const result = await probeHttp(m, this.env, row?.token ?? undefined);
    const now = Date.now();
    this.sql`INSERT INTO hw_checks (ts, monitor, ok, latency, detail)
      VALUES (${now}, ${m.id}, ${result.ok ? 1 : 0}, ${result.latencyMs}, ${result.detail})`;
    this
      .sql`UPDATE hw_monitors SET last_check = ${now}, token = ${result.token ?? null} WHERE id = ${m.id}`;
    await this.applyResult(m, result.ok, result.detail, "http");
    return result;
  }

  /** For push monitors: did every expected report arrive? */
  private async checkExpectations(m: PushMonitor, now: number) {
    const row = this.row(m.id);
    if (!row || m.expect.length === 0) return;
    const marks: Record<string, number> = JSON.parse(row.due_marks);
    const misses: string[] = [];
    const last = this.sql<{ ts: number }>`
      SELECT MAX(ts) AS ts FROM hw_reports WHERE monitor = ${m.id}`[0]?.ts;

    m.expect.forEach((e, i) => {
      if ("cron" in e) {
        const due = lastFireTime(
          parseCron(e.cron),
          new Date(now - e.graceMinutes * 60_000),
          m.timezone
        );
        if (!due) return;
        const d = due.getTime();
        // only judge each run once, and never runs from before the monitor existed
        if (d < row.created || d <= (marks[i] ?? 0)) return;
        marks[i] = d;
        const hit = this.sql`SELECT 1 FROM hw_reports WHERE monitor = ${m.id}
          AND ts BETWEEN ${d - e.earlyMinutes * 60_000} AND ${d + e.graceMinutes * 60_000} LIMIT 1`;
        if (hit.length === 0) {
          misses.push(
            `missed report: the run scheduled for ${this.localTime(d, m.timezone)} never reported (waited ${e.graceMinutes} min)`
          );
        }
      } else {
        const since = last ?? row.created;
        const silentMin = Math.floor((now - since) / 60_000);
        if (silentMin > e.everyMinutes + e.graceMinutes) {
          misses.push(
            `missed report: nothing for ${silentMin} min (expected every ${e.everyMinutes} min)`
          );
        }
      }
    });

    this
      .sql`UPDATE hw_monitors SET due_marks = ${JSON.stringify(marks)} WHERE id = ${m.id}`;
    if (misses.length)
      await this.applyResult(m, false, misses.join("; "), "missed-report");
  }

  /** Called with every check or report outcome. Opens triage or resolves incidents. */
  private async applyResult(
    m: Monitor,
    ok: boolean,
    detail: string,
    kind: FailureKind
  ) {
    const row = this.row(m.id);
    if (!row) return;
    const now = Date.now();
    const open = this.findOpenIncident(m.id);

    if (ok) {
      if (row.status !== "ok") {
        this
          .sql`UPDATE hw_monitors SET status = 'ok', since = ${now} WHERE id = ${m.id}`;
      }
      this
        .sql`UPDATE hw_monitors SET last_ok = ${now}, detail = ${detail} WHERE id = ${m.id}`;
      if (open) await this.resolveIncident(open, "recovered on its own");
      return;
    }

    if (row.status !== "failing") {
      this
        .sql`UPDATE hw_monitors SET status = 'failing', since = ${now} WHERE id = ${m.id}`;
    }
    this.sql`UPDATE hw_monitors SET detail = ${detail} WHERE id = ${m.id}`;
    const triageBusy =
      row.triage_started && now - row.triage_started < TRIAGE_TIMEOUT_MS;
    if (!open && !triageBusy) {
      this
        .sql`UPDATE hw_monitors SET triage_started = ${now} WHERE id = ${m.id}`;
      await this.runWorkflow<TriageParams>("TRIAGE_WORKFLOW", {
        monitorId: m.id,
        kind,
        detail
      });
    }
  }

  // ── Push reports from local services ────────────────────────────────

  async ingestReport(
    monitorId: string,
    body: { ok?: boolean; message?: string; metrics?: unknown }
  ) {
    const m = this.monitor(monitorId);
    if (!m || m.type !== "push")
      return { error: `unknown push monitor "${monitorId}"` };
    const now = Date.now();
    const metrics =
      body.metrics && typeof body.metrics === "object" ? body.metrics : null;
    const message = String(body.message ?? "").slice(0, 2000);

    // previous report that carried metrics, for no_increase / max_rate rules
    const prev = this.sql<{ ts: number; metrics: string }>`
      SELECT ts, metrics FROM hw_reports WHERE monitor = ${m.id} AND metrics IS NOT NULL
      ORDER BY ts DESC LIMIT 1`[0];
    const failures = metrics
      ? evaluateRules(
          m.rules,
          metrics,
          prev ? { metrics: JSON.parse(prev.metrics), at: prev.ts } : undefined,
          now
        )
      : [];
    const ok = body.ok !== false && failures.length === 0;

    this.sql`INSERT INTO hw_reports (ts, monitor, ok, message, metrics)
      VALUES (${now}, ${m.id}, ${ok ? 1 : 0}, ${message}, ${metrics ? JSON.stringify(metrics) : null})`;

    if (body.ok === false) {
      await this.applyResult(
        m,
        false,
        `the service reported a failure: ${message || "no message"}`,
        "reported"
      );
    } else if (failures.length) {
      await this.applyResult(
        m,
        false,
        failures.map((f) => f.message).join("; "),
        "rules"
      );
    } else {
      await this.applyResult(m, true, message || "report ok", "reported");
    }
    this.refreshState();
    return { ok, failures: failures.map((f) => f.message) };
  }

  // ── Called by TriageWorkflow ────────────────────────────────────────

  async recheck(monitorId: string) {
    const m = this.monitor(monitorId);
    if (!m) return { ok: true, detail: "monitor removed" };
    if (m.type !== "http") {
      return {
        ok: this.row(m.id)?.status !== "failing",
        detail: this.row(m.id)?.detail ?? ""
      };
    }
    const r = await this.probe(m);
    this.refreshState();
    return { ok: r.ok, detail: r.detail };
  }

  async endTriage(monitorId: string, _reason: string) {
    this
      .sql`UPDATE hw_monitors SET triage_started = NULL WHERE id = ${monitorId}`;
  }

  async triageContext(monitorId: string): Promise<TriageContext> {
    const m = this.monitor(monitorId);
    const row = this.row(monitorId);
    if (!m || !row)
      return {
        stillFailing: false,
        name: monitorId,
        detail: "",
        runbook: "",
        knownIssue: null
      };
    const knownIssue = matchKnownIssue(m, row.detail);
    return {
      stillFailing: row.status === "failing",
      name: m.name,
      description: m.description,
      runbook: m.runbook,
      detail: row.detail,
      failingSince: row.since ? this.localTime(row.since, this.tz) : null,
      lastHealthy: row.last_ok
        ? this.localTime(row.last_ok, this.tz)
        : "never seen healthy",
      knownIssue: knownIssue ?? null,
      recent: this.recentEvents(monitorId, 8)
    };
  }

  async openIncident(monitorId: string, d: IncidentInput) {
    const now = Date.now();
    const id = this.sql<{ id: number }>`
      INSERT INTO hw_incidents (monitor, opened, title, summary, cause, fix, detail, known_issue, can_fix)
      VALUES (${monitorId}, ${now}, ${d.title}, ${d.summary}, ${d.cause}, ${d.fix}, ${d.detail},
              ${d.knownIssueId}, ${d.canFix ? 1 : 0})
      RETURNING id`[0].id;
    this
      .sql`UPDATE hw_monitors SET triage_started = NULL WHERE id = ${monitorId}`;
    const offer = d.canFix
      ? `\n\nI can run the fix for you. Say **fix ${id}** and I'll ask you to approve it.`
      : "";
    await this.postToChat(
      `🔴 **${d.title}** (incident ${id})\n\n${d.summary}\n\n**Likely cause:** ${d.cause}\n\n**Fix:**\n${d.fix}${offer}`
    );
    this.refreshState();
    return { id };
  }

  // ── Incidents ───────────────────────────────────────────────────────

  private findOpenIncident(monitorId: string): IncidentRow | undefined {
    return this.sql<IncidentRow>`
      SELECT * FROM hw_incidents WHERE monitor = ${monitorId} AND resolved IS NULL
      ORDER BY opened DESC LIMIT 1`[0];
  }

  private async resolveIncident(incident: IncidentRow, how: string) {
    const now = Date.now();
    this
      .sql`UPDATE hw_incidents SET resolved = ${now}, resolution = ${how} WHERE id = ${incident.id}`;
    const minutes = Math.round((now - incident.opened) / 60_000);
    const name = this.monitor(incident.monitor)?.name ?? incident.monitor;
    await this.postToChat(
      `✅ **${name} is healthy again** (incident ${incident.id}, ${how}, after ${minutes} min).`
    );
    await notify(
      this.env,
      `${name} recovered`,
      `Incident ${incident.id}: ${how} after ${minutes} min.`,
      "default",
      ["white_check_mark"]
    );
    this.refreshState();
  }

  private async runFix(incidentId: number) {
    const incident = this
      .sql<IncidentRow>`SELECT * FROM hw_incidents WHERE id = ${incidentId}`[0];
    if (!incident) return { error: `no incident ${incidentId}` };
    const m = this.monitor(incident.monitor);
    const action = m?.knownIssues.find(
      (k) => k.id === incident.known_issue
    )?.action;
    if (!m || !action)
      return {
        error: "this incident has no automatic fix; follow the manual steps"
      };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(action.headers))
      headers[k] = interpolate(v, this.env);
    const res = await fetch(interpolate(action.url, this.env), {
      method: action.method,
      headers,
      body: action.body ? interpolate(action.body, this.env) : undefined,
      signal: AbortSignal.timeout(30_000)
    });
    const text = (await res.text()).slice(0, 500);
    if (!res.ok)
      return {
        ran: action.label,
        ok: false,
        status: res.status,
        response: text
      };
    // give the service a moment, then look again
    const after = m.type === "http" ? await this.recheck(m.id) : null;
    return { ran: action.label, ok: true, status: res.status, recheck: after };
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private get tz() {
    return this.getConfig()?.timezone ?? "UTC";
  }

  private localTime(ts: number, timeZone: string) {
    return new Date(ts).toLocaleString("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    });
  }

  private recentEvents(monitorId: string, limit: number) {
    const checks = this.sql<{
      ts: number;
      ok: number;
      detail: string;
      latency: number | null;
    }>`
      SELECT ts, ok, detail, latency FROM hw_checks WHERE monitor = ${monitorId} ORDER BY ts DESC LIMIT ${limit}`;
    const reports = this.sql<{
      ts: number;
      ok: number;
      message: string;
      metrics: string | null;
    }>`
      SELECT ts, ok, message, metrics FROM hw_reports WHERE monitor = ${monitorId} ORDER BY ts DESC LIMIT ${limit}`;
    return [
      ...checks.map((c) => ({
        at: c.ts,
        ok: !!c.ok,
        what: c.detail,
        latencyMs: c.latency
      })),
      ...reports.map((r) => ({
        at: r.ts,
        ok: !!r.ok,
        what: r.message || "report",
        metrics: r.metrics ? JSON.parse(r.metrics) : undefined
      }))
    ]
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
      .map((e) => ({ ...e, at: this.localTime(e.at, this.tz) }));
  }

  private async postToChat(text: string) {
    const message: UIMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text }]
    };
    await this.persistMessages([...this.messages, message]);
  }

  private refreshState() {
    const config = this.getConfig();
    const rows = new Map(
      this.sql<MonitorRow>`SELECT * FROM hw_monitors`.map((r) => [r.id, r])
    );
    const monitors: MonitorView[] = (config?.monitors ?? []).map((m) => {
      const r = rows.get(m.id);
      const lastReport = this.sql<{ ts: number | null }>`
        SELECT MAX(ts) AS ts FROM hw_reports WHERE monitor = ${m.id}`[0]?.ts;
      return {
        id: m.id,
        name: m.name,
        type: m.type,
        status: r?.status ?? "unknown",
        since: r?.since ?? null,
        lastSeen:
          m.type === "http" ? (r?.last_check ?? null) : (lastReport ?? null),
        detail: r?.detail ?? ""
      };
    });
    const openIncidents = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM hw_incidents WHERE resolved IS NULL`[0].n;
    this.setState({
      configured: !!config,
      monitors,
      openIncidents,
      updatedAt: Date.now()
    });
  }

  // Pre-digested for the model: Llama reads a headline far more reliably
  // than it scans a list of status objects.
  private statusReport() {
    const monitors = this.state.monitors ?? [];
    const broken = monitors.filter((m) => m.status === "failing");
    const waiting = monitors.filter((m) => m.status === "unknown");
    const healthy = monitors.filter((m) => m.status === "ok");
    const headline = broken.length
      ? `${broken.length} of ${monitors.length} services failing: ${broken.map((m) => m.name).join(", ")}`
      : `All ${healthy.length} reporting services are healthy` +
        (waiting.length ? `; ${waiting.length} have not reported yet` : "");
    return {
      headline,
      broken: broken.map((m) => {
        const incident = this.findOpenIncident(m.id);
        return {
          id: m.id,
          name: m.name,
          failingSince: m.since ? this.localTime(m.since, this.tz) : null,
          error: m.detail,
          incident: incident
            ? {
                id: incident.id,
                cause: incident.cause,
                fix: incident.fix,
                canAutoFix: !!incident.can_fix
              }
            : "triage in progress"
        };
      }),
      healthy: healthy.map((m) => m.name),
      notReportedYet: waiting.map((m) => m.name)
    };
  }

  // ── Chat ────────────────────────────────────────────────────────────

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: dedupedAI(this.env.AI) });
    const config = this.getConfig();
    const monitorList = (config?.monitors ?? [])
      .map((m) => {
        const known = m.knownIssues
          .map((k) => `    - known issue "${k.id}": ${k.cause}`)
          .join("\n");
        return `- ${m.id}: ${m.name} (${m.type}). ${m.description}${known ? `\n${known}` : ""}`;
      })
      .join("\n");

    // run_fix only exists while some open incident has a configured fix
    const fixable =
      this.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM hw_incidents WHERE resolved IS NULL AND can_fix = 1`[0]
        .n > 0;
    const fixTools: ToolSet = fixable
      ? {
          run_fix: tool({
            description:
              "Run the configured automatic fix for an open incident. Needs the owner's approval.",
            inputSchema: z.object({ incidentId: z.number().int() }),
            needsApproval: async () => true,
            execute: async ({ incidentId }) => this.runFix(incidentId)
          })
        }
      : {};

    const result = streamText({
      model: workersai(MODEL),
      system: `You are the on-call assistant for the owner's personal services. You watch them and explain problems in plain words.
Current time: ${this.localTime(Date.now(), this.tz)}.
Status right now: ${this.statusReport().headline}.

Monitored services:
${monitorList || "(none configured yet: tell the owner to run npm run push-config)"}

How to answer:
- Be short and plain. Lead with what is broken, then the likely cause, then the fix.
- Always use tools for facts; never guess status, times or numbers.
- Only offer to run a fix when the incident says canAutoFix is true, and only call run_fix after the owner says yes. Otherwise the fix steps are for the owner to run; say so, and never offer to run them.
- If nothing is wrong, say so in one line.
- Times are already in the owner's timezone.`,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        get_status: tool({
          description:
            "Current status: a headline, then broken services with their incident cause and fix, then healthy ones",
          inputSchema: z.object({}),
          execute: async () => this.statusReport()
        }),
        list_incidents: tool({
          description:
            "Incidents opened in the last N days, newest first, with cause and fix",
          inputSchema: z.object({
            days: z.number().int().min(1).max(30).default(7),
            openOnly: z.boolean().default(false)
          }),
          execute: async ({ days, openOnly }) => {
            const since = Date.now() - days * 86_400_000;
            const rows = this.sql<IncidentRow>`
              SELECT * FROM hw_incidents WHERE opened >= ${since} ORDER BY opened DESC LIMIT 50`;
            return rows
              .filter((r) => !openOnly || r.resolved === null)
              .map((r) => ({
                id: r.id,
                service: this.monitor(r.monitor)?.name ?? r.monitor,
                opened: this.localTime(r.opened, this.tz),
                resolved: r.resolved
                  ? this.localTime(r.resolved, this.tz)
                  : null,
                resolution: r.resolution,
                title: r.title,
                cause: r.cause,
                fix: r.fix,
                canAutoFix: !!r.can_fix && r.resolved === null
              }));
          }
        }),
        get_history: tool({
          description: "Recent checks or reports for one service, newest first",
          inputSchema: z.object({
            monitorId: z
              .string()
              .describe("Monitor id from the list in the system prompt"),
            limit: z.number().int().min(1).max(50).default(20)
          }),
          execute: async ({ monitorId, limit }) =>
            this.monitor(monitorId)
              ? this.recentEvents(monitorId, limit)
              : { error: `unknown monitor ${monitorId}` }
        }),
        get_metric_trend: tool({
          description:
            "Values of one reported metric over time, e.g. a SMART attribute, oldest first",
          inputSchema: z.object({
            monitorId: z.string(),
            metric: z
              .string()
              .describe(
                "Dotted path inside the report metrics, e.g. smart.181"
              ),
            days: z.number().int().min(1).max(30).default(14)
          }),
          execute: async ({ monitorId, metric, days }) => {
            const since = Date.now() - days * 86_400_000;
            const rows = this.sql<{ ts: number; metrics: string }>`
              SELECT ts, metrics FROM hw_reports WHERE monitor = ${monitorId}
              AND metrics IS NOT NULL AND ts >= ${since} ORDER BY ts`;
            return rows
              .map((r) => {
                let v: unknown = JSON.parse(r.metrics);
                for (const k of metric.split("."))
                  v = (v as Record<string, unknown> | undefined)?.[k];
                return { at: this.localTime(r.ts, this.tz), value: v };
              })
              .filter((p) => p.value !== undefined);
          }
        }),
        run_check: tool({
          description:
            "Probe an http service right now. Push services can't be probed; they report in.",
          inputSchema: z.object({ monitorId: z.string() }),
          execute: async ({ monitorId }) => {
            const m = this.monitor(monitorId);
            if (!m) return { error: `unknown monitor ${monitorId}` };
            if (m.type !== "http")
              return {
                error: `${m.name} reports in on its own; use get_history`
              };
            return this.recheck(monitorId);
          }
        }),
        ...fixTools,
        resolve_incident: tool({
          description:
            "Mark an incident resolved when the owner says it is handled. Needs the owner's approval.",
          // report text and probe bodies reach the model, so an injected
          // instruction must not be able to silence an alert on its own
          needsApproval: async () => true,
          inputSchema: z.object({
            incidentId: z.number().int(),
            note: z.string().default("resolved by owner")
          }),
          execute: async ({ incidentId, note }) => {
            const r = this
              .sql<IncidentRow>`SELECT * FROM hw_incidents WHERE id = ${incidentId}`[0];
            if (!r) return { error: `no incident ${incidentId}` };
            if (r.resolved) return { alreadyResolved: true };
            await this.resolveIncident(r, note);
            return { resolved: incidentId };
          }
        })
      },
      stopWhen: stepCountIs(8),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

// ── HTTP entry ────────────────────────────────────────────────────────

function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {}
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_REPORT_BYTES) throw new Error("body too large");
  const text = await request.text();
  if (text.length > MAX_REPORT_BYTES) throw new Error("body too large");
  return JSON.parse(text);
}

function isLocal(url: URL) {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const agent = () => getAgentByName(env.HealthAgent, AGENT_NAME);

  // Local services report in here: POST {"monitor": "...", "ok": true, "metrics": {...}}
  if (url.pathname === "/api/report" && request.method === "POST") {
    if (!bearerMatches(request, env.REPORT_TOKEN))
      return json({ error: "unauthorized" }, 401);
    let body: {
      monitor?: string;
      ok?: boolean;
      message?: string;
      metrics?: unknown;
    };
    try {
      body = (await readJson(request)) as typeof body;
    } catch (err) {
      return json({ error: String(err) }, 400);
    }
    if (!body.monitor) return json({ error: "monitor is required" }, 400);
    const result = await (await agent()).ingestReport(body.monitor, body);
    return json(result, "error" in result ? 404 : 200);
  }

  // Owner uploads the monitor list (npm run push-config)
  if (url.pathname === "/api/config" && request.method === "PUT") {
    if (!bearerMatches(request, env.ADMIN_TOKEN))
      return json({ error: "unauthorized" }, 401);
    try {
      return json(await (await agent()).setConfig(await readJson(request)));
    } catch (err) {
      return json({ error: String(err) }, 400);
    }
  }

  if (url.pathname === "/api/login" && request.method === "POST") {
    const ip = request.headers.get("cf-connecting-ip") ?? "local";
    if (!(await env.LOGIN_LIMITER.limit({ key: ip })).success) {
      return json({ error: "too many attempts, wait a minute" }, 429);
    }
    const { password } = (await request.json().catch(() => ({}))) as {
      password?: string;
    };
    if (
      !env.UI_PASSWORD ||
      !password ||
      !safeEqual(password, env.UI_PASSWORD)
    ) {
      return json({ error: "wrong password" }, 401);
    }
    return json({ ok: true }, 200, {
      "set-cookie": await sessionCookie(env)
    });
  }
  if (url.pathname === "/api/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  }
  if (url.pathname === "/api/session") {
    return json({ authenticated: await hasSession(request, env) });
  }

  // Chat UI: browser session required for both the WebSocket and HTTP routes
  // session cookie, and the request must come from this site's own pages
  // (stops cross-site WebSocket hijacking even if a cookie were sent)
  const gate = async (req: Request) => {
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) {
      return new Response("Forbidden", { status: 403 });
    }
    return (await hasSession(req, env))
      ? undefined
      : new Response("Unauthorized", { status: 401 });
  };
  const routed = await routeAgentRequest(request, env, {
    onBeforeConnect: gate,
    onBeforeRequest: gate
  });
  if (routed) return routed;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/agents/")) {
    return json({ error: "not found" }, 404);
  }
  // the chat UI itself
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    // HTTPS only, except local dev
    if (url.protocol === "http:" && !isLocal(url)) {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    const response = await handle(request, env);
    // WebSocket upgrades can't be rewrapped
    if (response.webSocket || isLocal(url)) return response;
    const secured = new Response(response.body, response);
    secured.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
    // no framing (the approval buttons must not be clickjackable)
    secured.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
    secured.headers.set("X-Frame-Options", "DENY");
    secured.headers.set("X-Content-Type-Options", "nosniff");
    secured.headers.set("Referrer-Policy", "no-referrer");
    return secured;
  }
} satisfies ExportedHandler<Env>;
