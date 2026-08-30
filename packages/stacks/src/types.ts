/**
 * Stack definitions.
 *
 * The factory used to be a Node.js factory: `npm install`, `npm test`, `npm start`
 * were written into the orchestrator, the healer, the scheduler and six prompts.
 * Supporting another language by adding a branch for it does not scale - there are
 * too many languages, and far too many frameworks inside each one.
 *
 * So the commands are *data*. A built-in definition supplies sensible defaults per
 * ecosystem, the architect agent overrides them with whatever the app it designed
 * actually needs, and the result is written to `.factory/stack.json`. Every part of
 * the pipeline reads its commands from there. Nothing downstream knows or cares
 * what language it is dealing with.
 */
import { z } from "zod";

/**
 * A command as an argv array - never a shell string.
 *
 * `["python", "-m", "pytest"]` rather than `"python -m pytest"`, because these
 * come from an agent and are executed by the orchestrator, outside the sandbox
 * that constrains the agent itself. An array has no quoting and no metacharacters.
 */
export const CommandSchema = z.array(z.string().min(1)).min(1);
export type Command = string[];

export const StackCommandsSchema = z.object({
  /** Fetch dependencies. Optional: some stacks vendor everything. */
  install: CommandSchema.optional(),
  /** Compile or bundle. Optional. Run before start, after install. */
  build: CommandSchema.optional(),
  /** Run the test suite. Required - it is the gate every healing fix must pass. */
  test: CommandSchema,
  /** Start the long-running app. Required, and it must honour the port env var. */
  start: CommandSchema,
  /** Optional static analysis, run by the review gate when present. */
  lint: CommandSchema.optional(),
});
export type StackCommands = z.infer<typeof StackCommandsSchema>;

/** How runtime errors get from a running app to the sentinel. */
export const ErrorSdkSchema = z.enum([
  /** Vendored Node/Express handler. */
  "node",
  /** Vendored Python handler (Flask / FastAPI / Django / bare). */
  "python",
  /** No vendored SDK: the deploy agent writes the integration against the wire contract. */
  "http",
]);
export type ErrorSdkKind = z.infer<typeof ErrorSdkSchema>;

/**
 * The stack an app actually uses, stored at `.factory/stack.json` and committed.
 * This is the contract between the architect agent and the rest of the pipeline.
 */
export const AppStackSchema = z.object({
  /** Built-in definition this is based on, or "custom". */
  id: z.string().min(1),
  /** Human label, e.g. "Python 3.12 + FastAPI". */
  label: z.string().min(1),
  language: z.string().min(1),
  framework: z.string().optional(),
  database: z.string().optional(),
  commands: StackCommandsSchema,
  /** Environment variable the app reads its port from. */
  portEnv: z.string().min(1).default("PORT"),
  errorSdk: ErrorSdkSchema.default("http"),
  /** Executables that must exist for this app to build and run. */
  requires: z.array(z.string()).default([]),
  /** Paths the generated repo should not commit. */
  ignore: z.array(z.string()).default([]),
});
export type AppStack = z.infer<typeof AppStackSchema>;

/** A built-in template: defaults for one ecosystem. */
export interface StackDefinition {
  id: string;
  label: string;
  language: string;
  /** Files that identify this stack in an existing directory, most specific first. */
  manifests: string[];
  commands: StackCommands;
  portEnv: string;
  errorSdk: ErrorSdkKind;
  requires: string[];
  ignore: string[];
  /** Guidance handed to agents building in this stack. */
  notes: string;
}
