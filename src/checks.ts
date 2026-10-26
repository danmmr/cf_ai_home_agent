import { interpolate, type HttpMonitor, type Rule } from "./config";

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  detail: string;
  // bearer token from the login step, cached by the caller between probes
  token?: string;
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function compare(actual: unknown, op: string, expected: unknown): boolean {
  if (op === "exists") return actual !== undefined && actual !== null;
  const a = typeof expected === "number" ? Number(actual) : actual;
  switch (op) {
    case "==":
      return a === expected;
    case "!=":
      return a !== expected;
    case "<":
      return (a as number) < (expected as number);
    case "<=":
      return (a as number) <= (expected as number);
    case ">":
      return (a as number) > (expected as number);
    case ">=":
      return (a as number) >= (expected as number);
  }
  return false;
}

function snippet(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 300);
}

async function timedFetch(url: string, init: RequestInit, timeoutMs: number) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function login(m: HttpMonitor, env: object): Promise<string> {
  const l = m.login!;
  const body: Record<string, string> = {};
  for (const [k, v] of Object.entries(l.body)) body[k] = interpolate(v, env);
  const res = await timedFetch(
    interpolate(l.url, env),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    },
    m.timeoutMs
  );
  if (!res.ok) {
    throw new Error(
      `login returned ${res.status}: ${snippet(await res.text())}`
    );
  }
  const token = getPath(await res.json(), l.tokenPath);
  if (typeof token !== "string")
    throw new Error(`login response has no ${l.tokenPath}`);
  return token;
}

export async function probeHttp(
  m: HttpMonitor,
  env: object,
  cachedToken?: string
): Promise<ProbeResult> {
  const started = Date.now();
  const fail = (status: number | null, detail: string): ProbeResult => ({
    ok: false,
    status,
    latencyMs: Date.now() - started,
    detail
  });

  let token = cachedToken;
  try {
    if (m.login && !token) token = await login(m, env);
  } catch (err) {
    return fail(null, `login failed: ${String(err)}`);
  }

  const send = async (bearer?: string) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.request.headers)) {
      headers[k] = interpolate(v, env);
    }
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    return timedFetch(
      interpolate(m.request.url, env),
      { method: m.request.method, headers },
      m.timeoutMs
    );
  };

  let res: Response;
  try {
    res = await send(token);
    // a cached token may have expired: log in again once
    if (res.status === 401 && m.login && cachedToken) {
      token = await login(m, env);
      res = await send(token);
    }
  } catch (err) {
    return fail(null, `request failed: ${String(err)}`);
  }

  const latencyMs = Date.now() - started;
  const text = m.request.method === "HEAD" ? "" : await res.text();
  if (res.status !== m.expect.status) {
    return {
      ...fail(
        res.status,
        `expected ${m.expect.status}, got ${res.status}: ${snippet(text)}`
      ),
      token
    };
  }
  if (m.expect.maxLatencyMs && latencyMs > m.expect.maxLatencyMs) {
    return {
      ...fail(
        res.status,
        `slow: ${latencyMs} ms > ${m.expect.maxLatencyMs} ms`
      ),
      token
    };
  }
  if (m.expect.json.length) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        ...fail(res.status, `response is not JSON: ${snippet(text)}`),
        token
      };
    }
    for (const c of m.expect.json) {
      const actual = getPath(body, c.path);
      if (!compare(actual, c.op, c.value)) {
        return {
          ...fail(
            res.status,
            `${c.path} is ${JSON.stringify(actual)}, expected ${c.op} ${JSON.stringify(c.value ?? "")}`
          ),
          token
        };
      }
    }
  }
  return { ok: true, status: res.status, latencyMs, detail: "ok", token };
}

export interface RuleFailure {
  rule: Rule;
  message: string;
}

/** Check a report's metrics against the monitor rules, using the previous report for deltas. */
export function evaluateRules(
  rules: Rule[],
  metrics: unknown,
  previous?: { metrics: unknown; at: number },
  now = Date.now()
): RuleFailure[] {
  const failures: RuleFailure[] = [];
  for (const rule of rules) {
    const actual = getPath(metrics, rule.metric);
    if (actual === undefined) continue; // reporters may skip a metric, e.g. SMART when busy
    if (rule.op === "no_increase" || rule.op === "max_rate") {
      if (!previous) continue;
      const before = Number(getPath(previous.metrics, rule.metric));
      if (Number.isNaN(before)) continue;
      const delta = Number(actual) - before;
      if (rule.op === "no_increase") {
        if (delta > 0) {
          failures.push({
            rule,
            message: `${rule.metric} rose from ${before} to ${actual}`
          });
        }
        continue;
      }
      let span: number;
      if (rule.per) {
        span =
          Number(getPath(metrics, rule.per)) -
          Number(getPath(previous.metrics, rule.per));
      } else {
        span = (now - previous.at) / 3_600_000;
      }
      if (!(span > 0)) continue;
      const rate = delta / span;
      if (rate > rule.value) {
        failures.push({
          rule,
          message: `${rule.metric} rate ${rate.toFixed(2)} per ${rule.per ?? "hour"} exceeds ${rule.value}`
        });
      }
      continue;
    }
    if (!compare(actual, rule.op, rule.value)) {
      failures.push({
        rule,
        message: `${rule.metric} is ${JSON.stringify(actual)}, expected ${rule.op} ${JSON.stringify(rule.value)}`
      });
    }
  }
  return failures;
}
