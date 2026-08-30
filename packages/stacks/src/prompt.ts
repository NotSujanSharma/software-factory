/**
 * Stack context for agent prompts.
 *
 * Role prompts used to hard-code `npm test` and `npm start`. They now describe the
 * job in the abstract and receive the concrete commands from here, so the same
 * prompt works whether the agent is holding a package.json or a Cargo.toml.
 */
import { describeCommand } from "./resolve.ts";
import type { AppStack } from "./types.ts";

/** A block appended to a role prompt telling the agent what it is working in. */
export function stackBrief(stack: AppStack): string {
  const lines = [
    `## Stack`,
    ``,
    `- Stack: ${stack.label} (${stack.language})`,
    stack.framework ? `- Framework: ${stack.framework}` : "",
    stack.database ? `- Data store: ${stack.database}` : "",
    `- Port comes from the \`${stack.portEnv}\` environment variable.`,
    ``,
    `Use exactly these commands. They are what the factory itself runs, so an app`,
    `that only works with some other invocation will fail its gates.`,
    ``,
    `| phase | command |`,
    `| --- | --- |`,
    `| install | \`${describeCommand(stack.commands.install)}\` |`,
    `| build | \`${describeCommand(stack.commands.build)}\` |`,
    `| test | \`${describeCommand(stack.commands.test)}\` |`,
    `| start | \`${describeCommand(stack.commands.start)}\` |`,
    stack.commands.lint ? `| lint | \`${describeCommand(stack.commands.lint)}\` |` : "",
  ];
  return lines.filter((l) => l !== "").join("\n");
}
