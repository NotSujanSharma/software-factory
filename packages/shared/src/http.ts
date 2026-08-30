/** HTTP helpers shared by the deploy stage and the sentinel's health checks. */
import type { HealthConfig } from "./types.ts";

/** Resolve once the URL answers at all; any HTTP status proves the server is listening. */
export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw new Error(`app did not come up at ${url}: ${lastErr}`);
}

/** Non-throwing variant: is anything listening? Boot detection only - not health. */
export async function isReachable(url: string, timeoutMs: number): Promise<boolean> {
  try {
    await waitForHttp(url, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

export interface HealthResult {
  healthy: boolean;
  /** Path that produced the verdict, when one answered. */
  path?: string;
  status?: number;
  detail: string;
}

/**
 * One health probe.
 *
 * "Is anything listening" is not health. An app that returns 500 to every request
 * is listening perfectly and is also completely broken - and because a dead app
 * reports no further errors, nothing would ever heal it. So a 5xx is a failure,
 * where a connection refused, a timeout, or a 5xx all read as unhealthy.
 *
 * Paths are tried in order and a 404 moves on to the next, since an API-only app
 * legitimately has no route at `/`. If every path 404s the server is still
 * answering, which is the best evidence available without a health endpoint.
 */
export async function probeHealth(baseUrl: string, cfg: HealthConfig): Promise<HealthResult> {
  const base = baseUrl.replace(/\/$/, "");
  let sawNotFound = false;
  let lastError = "no response";

  for (const path of cfg.paths) {
    let res: Response;
    try {
      res = await fetch(base + path, { signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      lastError = `${path}: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }

    if (res.status === 404) {
      sawNotFound = true;
      continue;
    }
    if (res.status >= cfg.unhealthyStatusFrom) {
      return { healthy: false, path, status: res.status, detail: `${path} returned ${res.status}` };
    }
    return { healthy: true, path, status: res.status, detail: `${path} returned ${res.status}` };
  }

  if (sawNotFound) {
    return {
      healthy: true,
      status: 404,
      detail: "server answered, but no health endpoint exists (every probed path 404s)",
    };
  }
  return { healthy: false, detail: lastError };
}

/**
 * Wait for the app to be healthy and *stay* healthy.
 *
 * A single successful probe is not enough: an app that boots, answers once and
 * then crashes would pass. `stableChecks` consecutive passes, a second apart, is
 * what distinguishes running from merely starting.
 */
export async function verifyHealthy(
  baseUrl: string,
  cfg: HealthConfig,
  onProgress?: (r: HealthResult) => void,
): Promise<HealthResult> {
  const deadline = Date.now() + cfg.timeoutMs;
  const needed = Math.max(1, cfg.stableChecks);
  let consecutive = 0;
  let last: HealthResult = { healthy: false, detail: "never probed" };

  while (Date.now() < deadline) {
    last = await probeHealth(baseUrl, cfg);
    onProgress?.(last);

    if (last.healthy) {
      if (++consecutive >= needed) return last;
    } else {
      // A failure resets the streak: flapping is not healthy.
      consecutive = 0;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  return {
    ...last,
    healthy: false,
    detail:
      consecutive > 0
        ? `only ${consecutive}/${needed} consecutive healthy probes before timeout: ${last.detail}`
        : last.detail,
  };
}

/** Sleep that logs a heartbeat, so a multi-hour limit wait never looks like a hang. */
export async function sleepWithHeartbeat(
  ms: number,
  onTick?: (remainingMs: number) => void,
  tickMs = 5 * 60_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise((r) => setTimeout(r, Math.min(tickMs, remaining)));
    const left = deadline - Date.now();
    if (left > 0) onTick?.(left);
  }
}
