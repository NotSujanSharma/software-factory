/** Small HTTP helpers shared by the deploy stage and the sentinel's health checks. */

/** Resolve once the URL answers at all; any HTTP status (even 404) proves the server is listening. */
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

/** Non-throwing variant used to decide whether a redeploy left the app healthy. */
export async function isReachable(url: string, timeoutMs: number): Promise<boolean> {
  try {
    await waitForHttp(url, timeoutMs);
    return true;
  } catch {
    return false;
  }
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
