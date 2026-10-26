import { z } from "zod";

// Monitors are data, not code. The deployed agent loads them from a JSON file
// pushed with `npm run push-config`, so the repo never has to know what it is
// watching. See monitors.example.json.

const comparison = z.enum(["==", "!=", "<", "<=", ">", ">="]);

export const ruleSchema = z.discriminatedUnion("op", [
  // metric <op> value, e.g. { metric: "smart.5", op: "==", value: 0 }
  z.object({
    op: comparison,
    metric: z.string(),
    value: z.union([z.number(), z.string(), z.boolean()])
  }),
  // metric must never go up between two reports
  z.object({
    op: z.literal("no_increase"),
    metric: z.string()
  }),
  // growth between two reports, divided by growth of `per` (another metric)
  // or by wall clock hours when `per` is omitted
  z.object({
    op: z.literal("max_rate"),
    metric: z.string(),
    value: z.number(),
    per: z.string().optional()
  })
]);
export type Rule = z.infer<typeof ruleSchema>;

const jsonCheck = z.object({
  path: z.string(),
  op: comparison.or(z.literal("exists")),
  value: z.union([z.number(), z.string(), z.boolean()]).optional()
});

// A fix the agent may run, only after the user approves it in chat.
const fixActionSchema = z.object({
  label: z.string(),
  url: z.string(),
  method: z.enum(["GET", "POST", "PUT"]).default("POST"),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional()
});
export type FixAction = z.infer<typeof fixActionSchema>;

// A failure the owner has seen before: match it, explain it, offer the fix.
const knownIssueSchema = z.object({
  id: z.string(),
  // case-insensitive regex tested against the failure detail
  match: z.string(),
  cause: z.string(),
  fix: z.string(),
  action: fixActionSchema.optional()
});
export type KnownIssue = z.infer<typeof knownIssueSchema>;

const base = {
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string(),
  description: z.string().default(""),
  // free text handed to the LLM when this monitor fails
  runbook: z.string().default(""),
  knownIssues: z.array(knownIssueSchema).default([])
};

export const httpMonitorSchema = z.object({
  ...base,
  type: z.literal("http"),
  intervalMinutes: z.number().int().min(1).default(60),
  timeoutMs: z.number().int().min(500).default(10000),
  // optional login step: POST json, read a bearer token out of the response
  login: z
    .object({
      url: z.string(),
      body: z.record(z.string(), z.string()),
      tokenPath: z.string().default("access_token")
    })
    .optional(),
  request: z.object({
    url: z.string(),
    method: z.enum(["GET", "POST", "HEAD"]).default("GET"),
    headers: z.record(z.string(), z.string()).default({})
  }),
  expect: z
    .object({
      status: z.number().int().default(200),
      maxLatencyMs: z.number().int().optional(),
      json: z.array(jsonCheck).default([])
    })
    .default({ status: 200, json: [] })
});

export const pushMonitorSchema = z.object({
  ...base,
  type: z.literal("push"),
  timezone: z.string().default("UTC"),
  // when reports are expected; a miss opens an incident
  expect: z
    .array(
      z.union([
        // a report should land near each time this cron fires
        z.object({
          cron: z.string(),
          graceMinutes: z.number().int().min(1).default(10),
          earlyMinutes: z.number().int().min(0).default(2)
        }),
        // a report at least this often
        z.object({
          everyMinutes: z.number().int().min(1),
          graceMinutes: z.number().int().min(0).default(5)
        })
      ])
    )
    .default([]),
  rules: z.array(ruleSchema).default([])
});

export const monitorSchema = z.discriminatedUnion("type", [
  httpMonitorSchema,
  pushMonitorSchema
]);
export type Monitor = z.infer<typeof monitorSchema>;
export type HttpMonitor = z.infer<typeof httpMonitorSchema>;
export type PushMonitor = z.infer<typeof pushMonitorSchema>;

export const configSchema = z.object({
  // used for chat answers ("last night", "this morning")
  timezone: z.string().default("UTC"),
  monitors: z.array(monitorSchema)
});
export type Config = z.infer<typeof configSchema>;

export function parseConfig(raw: unknown): Config {
  const config = configSchema.parse(raw);
  const ids = new Set<string>();
  for (const m of config.monitors) {
    if (ids.has(m.id)) throw new Error(`duplicate monitor id: ${m.id}`);
    ids.add(m.id);
    for (const k of m.knownIssues) new RegExp(k.match, "i");
    for (const name of JSON.stringify(m).matchAll(/\$\{env:([A-Z0-9_]+)\}/g)) {
      if (RESERVED.has(name[1]))
        throw new Error(`${m.id}: secret ${name[1]} is reserved`);
    }
  }
  return config;
}

export function matchKnownIssue(
  m: Monitor,
  detail: string
): KnownIssue | undefined {
  return m.knownIssues.find((k) => new RegExp(k.match, "i").test(detail));
}

// "${env:NAME}" in any string is replaced with the Worker secret NAME, so
// credentials stay in secrets instead of the uploaded config.
// The agent's own credentials can never be pulled into a URL, header or
// body, so a bad config can't send them anywhere.
const RESERVED = new Set([
  "UI_PASSWORD",
  "SESSION_SECRET",
  "REPORT_TOKEN",
  "ADMIN_TOKEN",
  "NTFY_TOPIC"
]);

export function interpolate(value: string, env: object): string {
  return value.replace(/\$\{env:([A-Z0-9_]+)\}/g, (_, name: string) => {
    if (RESERVED.has(name)) throw new Error(`secret ${name} is reserved`);
    const v = (env as Record<string, unknown>)[name];
    if (typeof v !== "string") throw new Error(`missing secret ${name}`);
    return v;
  });
}
