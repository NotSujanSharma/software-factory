import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  AppStackSchema,
  assertCommandAllowed,
  describeCommand,
  detectStack,
  fromDefinition,
  loadStack,
  missingTools,
  resolveStack,
  saveStack,
  stackBrief,
  stackById,
  withPort,
} = await import("../packages/stacks/src/index.ts");
const { loadConfig } = await import("../packages/shared/src/config.ts");

const cfg = loadConfig();

function scratch(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stack-test-"));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return dir;
}

// ---------- detection ----------

test("each ecosystem is recognised by its manifest", () => {
  const cases: [string, string][] = [
    ["package.json", "node"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["go.mod", "go"],
    ["Cargo.toml", "rust"],
    ["Gemfile", "ruby"],
    ["pom.xml", "java-maven"],
    ["build.gradle", "java-gradle"],
    ["composer.json", "php"],
  ];
  for (const [manifest, expected] of cases) {
    const dir = scratch({ [manifest]: "{}" });
    assert.equal(detectStack(dir)?.id, expected, `${manifest} should detect ${expected}`);
  }
});

test("a wildcard manifest matches by extension", () => {
  assert.equal(detectStack(scratch({ "Api.csproj": "<Project/>" }))?.id, "dotnet");
});

test("a real backend that happens to ship an index.html is not called a static site", () => {
  const dir = scratch({ "go.mod": "module x", "index.html": "<html></html>" });
  assert.equal(detectStack(dir)?.id, "go");
  // Only when there is nothing else does static win.
  assert.equal(detectStack(scratch({ "index.html": "<html></html>" }))?.id, "static");
});

test("an unrecognised directory detects nothing", () => {
  assert.equal(detectStack(scratch({ "notes.txt": "hi" })), null);
});

// ---------- resolution ----------

test("a declared stack beats detection", () => {
  const dir = scratch({ "package.json": "{}" });
  const declared = fromDefinition(stackById("python")!, { label: "Python 3.12 + FastAPI", framework: "FastAPI" });
  saveStack(dir, declared);

  const resolved = resolveStack(dir);
  assert.equal(resolved.id, "python");
  assert.equal(resolved.framework, "FastAPI");
  assert.equal(loadStack(dir)?.label, "Python 3.12 + FastAPI");
});

test("detection is the fallback, and node is the fallback of last resort", () => {
  assert.equal(resolveStack(scratch({ "Cargo.toml": "" })).id, "rust");
  assert.equal(resolveStack(scratch()).id, "node");
});

test("a corrupt stack file falls back instead of throwing", () => {
  const dir = scratch({ "go.mod": "module x" });
  fs.mkdirSync(path.join(dir, ".factory"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".factory", "stack.json"), "{ not json");
  assert.equal(resolveStack(dir).id, "go");
});

// ---------- the contract with the architect ----------

test("a stack needs a test and a start command", () => {
  assert.throws(() => AppStackSchema.parse({ id: "x", label: "X", language: "X", commands: {} }));
  assert.throws(() =>
    AppStackSchema.parse({ id: "x", label: "X", language: "X", commands: { test: ["a"] } }),
  );
});

test("commands must be argv arrays, never shell strings", () => {
  assert.throws(
    () =>
      AppStackSchema.parse({
        id: "x",
        label: "X",
        language: "X",
        commands: { test: "pytest -q", start: ["python", "main.py"] },
      }),
    /expected array|Expected array/i,
  );
});

test("an empty argument is rejected", () => {
  assert.throws(() =>
    AppStackSchema.parse({ id: "x", label: "X", language: "X", commands: { test: [""], start: ["x"] } }),
  );
});

test("optional phases stay optional", () => {
  const stack = AppStackSchema.parse({
    id: "go",
    label: "Go",
    language: "Go",
    commands: { test: ["go", "test", "./..."], start: ["go", "run", "."] },
  });
  assert.equal(stack.commands.install, undefined);
  assert.equal(stack.commands.build, undefined);
  assert.equal(stack.portEnv, "PORT", "portEnv should default");
  assert.equal(stack.errorSdk, "http", "errorSdk should default to the wire contract");
});

// ---------- running commands ----------

test("the port is substituted where it has to appear on the command line", () => {
  const stack = fromDefinition(stackById("python")!, {
    commands: { test: ["pytest"], start: ["uvicorn", "app:app", "--port", "${PORT}"] },
  });
  assert.deepEqual(withPort(stack.commands.start, stack, 5123), ["uvicorn", "app:app", "--port", "5123"]);
});

test("both $PORT spellings and a custom port variable are substituted", () => {
  const stack = fromDefinition(stackById("static")!, {
    portEnv: "SERVER_PORT",
    commands: { test: ["true"], start: ["php", "-S", "0.0.0.0:$PORT", "-t", "${SERVER_PORT}"] },
  });
  assert.deepEqual(withPort(stack.commands.start, stack, 8080), ["php", "-S", "0.0.0.0:8080", "-t", "8080"]);
});

test("a command with no port placeholder is left alone", () => {
  const stack = fromDefinition(stackById("node")!);
  assert.deepEqual(withPort(stack.commands.start, stack, 5100), ["npm", "start"]);
});

// ---------- guarding agent-supplied commands ----------

test("a destructive stack command is refused", () => {
  // These are chosen by an agent but run by the orchestrator, outside the sandbox.
  for (const command of [
    ["pkill", "-f", "node"],
    ["shutdown", "/s"],
    ["taskkill", "/IM", "node.exe"],
  ]) {
    assert.throws(() => assertCommandAllowed(cfg, "start", command), /not allowed/, command.join(" "));
  }
});

test("ordinary build and run commands are allowed", () => {
  for (const command of [
    ["npm", "test"],
    ["python", "-m", "pytest", "-q"],
    ["go", "test", "./..."],
    ["cargo", "run", "--release"],
    ["mvn", "-q", "test"],
    ["bundle", "exec", "rspec"],
    ["dotnet", "run", "-c", "Release"],
  ]) {
    assert.doesNotThrow(() => assertCommandAllowed(cfg, "test", command), command.join(" "));
  }
});

test("an empty command is refused rather than run", () => {
  assert.throws(() => assertCommandAllowed(cfg, "start", []), /empty or malformed/);
});

// ---------- toolchain ----------

test("missing tools are reported so the failure lands before any code is written", () => {
  const real = fromDefinition(stackById("node")!);
  assert.deepEqual(missingTools(real), [], "node and npm are present in this environment");

  const imaginary = fromDefinition(stackById("node")!, { requires: ["definitely-not-installed-xyz"] });
  assert.deepEqual(missingTools(imaginary), ["definitely-not-installed-xyz"]);
});

// ---------- prompt context ----------

test("the stack brief hands agents the exact commands the factory will run", () => {
  const stack = fromDefinition(stackById("python")!, {
    label: "Python 3.12 + FastAPI",
    framework: "FastAPI",
    database: "SQLite",
    commands: { test: ["python", "-m", "pytest", "-q"], start: ["uvicorn", "app:app"] },
  });
  const brief = stackBrief(stack);
  assert.match(brief, /Python 3\.12 \+ FastAPI/);
  assert.match(brief, /FastAPI/);
  assert.match(brief, /SQLite/);
  assert.match(brief, /python -m pytest -q/);
  assert.match(brief, /uvicorn app:app/);
  assert.match(brief, /PORT/);
});

test("a stack with no install or build step says so rather than inventing one", () => {
  const stack = fromDefinition(stackById("rust")!, {
    commands: { test: ["cargo", "test"], start: ["cargo", "run"] },
  });
  assert.equal(describeCommand(stack.commands.install), "(none)");
  assert.match(stackBrief(stack), /\| install \| `\(none\)` \|/);
});

// ---------- the prompt and the schema must not drift ----------

test("the architect prompt's own example validates against the schema", () => {
  // The example is what an agent copies. If it does not parse, the most expensive
  // stage in the pipeline burns a retry before anyone finds out.
  const md = fs.readFileSync(path.join("packages", "agents", "prompts", "architect.md"), "utf8");
  const block = md.match(/```json\n([\s\S]*?)```/)?.[1];
  assert.ok(block, "architect.md should contain a json example");

  const objStart = block.indexOf("{", block.indexOf('"stack"'));
  let depth = 0;
  let end = objStart;
  for (let i = objStart; i < block.length; i++) {
    if (block[i] === "{") depth++;
    if (block[i] === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  const example = JSON.parse(block.slice(objStart, end));
  const parsed = AppStackSchema.parse(example);
  assert.equal(parsed.errorSdk, "python");
  assert.ok(parsed.commands.start.includes("${PORT}"), "the example should show the port placeholder");
});
