/**
 * Session / usage limit handling.
 *
 * When an agent run comes back as "You've hit your session limit - resets 8pm
 * (America/Toronto)" the framework must sleep until that moment and retry rather
 * than failing the work item. Everything here is pure and side-effect free so it
 * can be unit tested without an agent.
 */

/**
 * Deliberately strict. A false positive puts the whole pipeline to sleep, while a
 * false negative only costs one retry, so these must not match ordinary agent
 * prose like "added rate limiting to the API".
 */
const LIMIT_PATTERNS: RegExp[] = [
  /you'?ve hit your (?:session|usage|account) limit/i,
  /(?:session|usage|account) limit reached/i,
  /claude (?:code )?usage limit reached/i,
  /\blimit (?:will )?reset[s]?\b/i,
  /upgrade to increase your usage limit/i,
  /rate_limit_error/i,
  /overloaded_error/i,
  /429 too many requests/i,
  /quota exceeded/i,
];

/** Does this agent result / error text mean "come back later" rather than "this failed"? */
export function isLimitMessage(text: string | undefined | null): boolean {
  if (!text) return false;
  return LIMIT_PATTERNS.some((re) => re.test(text));
}

/** Milliseconds to add to a UTC instant to get the wall-clock time in `tz`. */
function tzOffsetMs(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(instant)) if (part.type !== "literal") p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - instant.getTime();
}

/** The next instant at which the wall clock in `tz` reads hour:minute. */
function nextLocalTime(now: Date, tz: string | null, hour: number, minute: number): Date {
  const zone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  let offset: number;
  try {
    offset = tzOffsetMs(now, zone);
  } catch {
    offset = tzOffsetMs(now, "UTC"); // unknown zone name -> treat as UTC
  }
  const local = new Date(now.getTime() + offset);
  let target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute, 0);
  if (target - offset <= now.getTime()) target += 86_400_000; // already passed today -> tomorrow

  // Re-resolve the offset at the candidate instant so a DST change in between does not skew it.
  let utc = target - offset;
  try {
    const refined = target - tzOffsetMs(new Date(utc), zone);
    if (refined > now.getTime()) utc = refined;
  } catch {
    /* keep the first estimate */
  }
  return new Date(utc);
}

/**
 * Extract the reset instant from a limit message. Handles the three shapes seen
 * in practice: a wall-clock time with optional timezone, a relative duration,
 * and an absolute ISO timestamp. Returns null when nothing is parseable.
 */
export function parseLimitReset(text: string, now: Date = new Date()): Date | null {
  // "resets in 45 minutes" / "try again in 2 hours"
  const rel = text.match(/(?:reset[s]?|try again|available again|retry)\s+in\s+(\d+)\s*(second|minute|hour)s?/i);
  if (rel) {
    const unit = rel[2].toLowerCase();
    const ms = unit === "second" ? 1000 : unit === "minute" ? 60_000 : 3_600_000;
    return new Date(now.getTime() + Number(rel[1]) * ms);
  }

  // "resets at 2026-08-30T01:00:00Z"
  const iso = text.match(/reset[s]?\s*(?:at\s+)?(\d{4}-\d{2}-\d{2}[T ][\d:]{5,8}(?:\.\d+)?Z?)/i);
  if (iso) {
    const d = new Date(iso[1].replace(" ", "T"));
    if (!Number.isNaN(d.getTime())) return d;
  }

  // "resets 8pm (America/Toronto)" / "resets at 8:30 pm"
  const m = text.match(/reset[s]?\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;

  const tz = text.match(/\(([A-Za-z]+\/[A-Za-z_+-]+)\)/)?.[1] ?? null;
  return nextLocalTime(now, tz, hour, minute);
}

export interface LimitWaitOptions {
  bufferMs: number;
  maxWaitMs: number;
  fallbackMs: number;
}

export interface LimitWaitPlan {
  ms: number;
  until: Date;
  reason: string;
}

/**
 * Decide how long to sleep before retrying. Waking early is harmless - the retry
 * simply hits the limit again and re-plans - so the cap is applied without fuss.
 */
export function planLimitWait(text: string, opts: LimitWaitOptions, now: Date = new Date()): LimitWaitPlan {
  const reset = parseLimitReset(text, now);
  let ms: number;
  let reason: string;

  if (reset && reset.getTime() > now.getTime()) {
    ms = reset.getTime() - now.getTime() + opts.bufferMs;
    reason = `limit resets ${reset.toISOString()}`;
  } else {
    ms = opts.fallbackMs;
    reason = "no reset time in the message; using fallback backoff";
  }

  if (ms > opts.maxWaitMs) {
    ms = opts.maxWaitMs;
    reason += ` (capped at ${Math.round(opts.maxWaitMs / 60_000)}m; will re-check and wait again if still limited)`;
  }
  if (ms < 1000) ms = 1000;

  return { ms, until: new Date(now.getTime() + ms), reason };
}

/** Human-readable duration for logs: 2h 05m. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
