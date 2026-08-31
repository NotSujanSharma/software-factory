import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCodexAgent } from "../packages/agents/src/codex.ts";
import { makeGuard } from "../packages/agents/src/guard.ts";
import { loadConfig } from "../packages/shared/src/config.ts";
import { makeLogger } from "../packages/shared/src/log.ts";

test("Codex JSONL events are translated into a factory agent result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-adapter-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bin-"));
  const executable = path.join(bin, "codex");
  fs.writeFileSync(
    executable,
    "#!/usr/bin/env node\n" +
      'console.log(JSON.stringify({type:"item.started",item:{type:"command_execution",command:"node --version"}}));\n' +
      'console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"finished the requested work"}}));\n' +
      'console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,output_tokens:5}}));\n',
  );
  fs.chmodSync(executable, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  try {
    const guard = makeGuard(loadConfig(), dir);
    const lines: string[] = [];
    const result = await runCodexAgent({
      prompt: "test prompt",
      cwd: dir,
      model: "test-model",
      maxTurns: 3,
      rolePrompt: "test role",
      guard,
      log: makeLogger("codex-test"),
      record: (line) => lines.push(line),
    });

    assert.equal(result.isError, false);
    assert.equal(result.text, "finished the requested work");
    assert.equal(result.turns, 1);
    assert.equal(result.denials.length, 0);
    assert.equal(guard.calls, 1);
    assert.ok(lines.some((line) => line.includes("finished the requested work")));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});
