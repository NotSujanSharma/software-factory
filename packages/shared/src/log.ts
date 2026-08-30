const COLORS: Record<string, string> = {
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  agent: "\x1b[35m",
  ok: "\x1b[32m",
};
const RESET = "\x1b[0m";

export function makeLogger(scope: string) {
  const emit = (level: string, ...args: unknown[]) => {
    const ts = new Date().toISOString().slice(11, 19);
    const color = COLORS[level] ?? "";
    console.log(`${color}[${ts}] [${scope}] ${level.toUpperCase()}${RESET}`, ...args);
  };
  return {
    info: (...a: unknown[]) => emit("info", ...a),
    warn: (...a: unknown[]) => emit("warn", ...a),
    error: (...a: unknown[]) => emit("error", ...a),
    agent: (...a: unknown[]) => emit("agent", ...a),
    ok: (...a: unknown[]) => emit("ok", ...a),
  };
}

export type Logger = ReturnType<typeof makeLogger>;
