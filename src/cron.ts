// Minimal 5 field cron matcher (minute hour day-of-month month day-of-week)
// evaluated in an IANA timezone. Supports *, lists, ranges and steps, which
// is all the heartbeat expectations need.

type Field = Set<number>;

function parseField(spec: string, min: number, max: number): Field {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = b === undefined ? (stepText ? max : lo) : Number(b);
    }
    if ([lo, hi, step].some(Number.isNaN) || lo < min || hi > max || step < 1) {
      throw new Error(`bad cron field "${spec}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface Cron {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
  domAny: boolean;
  dowAny: boolean;
}

export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron needs 5 fields: "${expr}"`);
  const dow = parseField(f[4], 0, 7);
  if (dow.has(7)) dow.add(0);
  return {
    minute: parseField(f[0], 0, 59),
    hour: parseField(f[1], 0, 23),
    dom: parseField(f[2], 1, 31),
    month: parseField(f[3], 1, 12),
    dow,
    domAny: f[2] === "*",
    dowAny: f[4] === "*"
  };
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

export function localParts(date: Date, timeZone: string): LocalParts {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short"
    });
    formatters.set(timeZone, fmt);
  }
  const p: Record<string, string> = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAYS[p.weekday]
  };
}

export function cronMatches(cron: Cron, t: LocalParts): boolean {
  if (!cron.minute.has(t.minute) || !cron.hour.has(t.hour)) return false;
  if (!cron.month.has(t.month)) return false;
  const domOk = cron.dom.has(t.day);
  const dowOk = cron.dow.has(t.weekday);
  // standard cron: if both day fields are restricted, either may match
  if (!cron.domAny && !cron.dowAny) return domOk || dowOk;
  return domOk && dowOk;
}

/** Most recent minute at or before `at` that the cron fires, within 8 days. */
export function lastFireTime(
  cron: Cron,
  at: Date,
  timeZone: string
): Date | null {
  const start = Math.floor(at.getTime() / 60000) * 60000;
  for (let i = 0; i < 8 * 24 * 60; i++) {
    const t = new Date(start - i * 60000);
    if (cronMatches(cron, localParts(t, timeZone))) return t;
  }
  return null;
}
