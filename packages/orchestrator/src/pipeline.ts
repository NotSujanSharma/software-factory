import fs from "node:fs";
import path from "node:path";
import type { AppMeta, FactoryConfig } from "@factory/shared";
import { ensureRepo, commitAll, loadConfig, workspaceRoot, makeLogger } from "@factory/shared";
import { loadState, newState, saveState, stageRec, STAGE_ORDER } from "./state.ts";
import { makeCtx, type Ctx } from "./stages/context.ts";
import { requirementsStage } from "./stages/requirements.ts";
import { architectureStage } from "./stages/architecture.ts";
import { developmentStage } from "./stages/development.ts";
import { gateStage } from "./stages/gates.ts";
import { validationStage } from "./stages/validation.ts";
import { deployStage } from "./stages/deploy.ts";
import { evolutionStage } from "./stages/evolution.ts";

const log = makeLogger("factory");

export function appDirFor(cfg: FactoryConfig, name: string): string {
  return path.join(workspaceRoot(cfg), name);
}

export async function createApp(cfg: FactoryConfig, name: string, prompt: string): Promise<Ctx> {
  const dir = appDirFor(cfg, name);
  if (fs.existsSync(path.join(dir, ".factory", "state.json"))) {
    throw new Error(`app "${name}" already exists - use factory resume ${name}`);
  }
  fs.mkdirSync(path.join(dir, ".factory", "out"), { recursive: true });
  const app: AppMeta = { id: `${name}-${Date.now().toString(36)}`, name, prompt, dir };
  const state = newState(app);
  saveState(dir, state);
  await ensureRepo(dir);
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n.factory/logs/\n.factory/app.log\n.factory/run.json\n");
  await commitAll(dir, "chore: factory pipeline initialized");
  return makeCtx(cfg, state, dir);
}

export function openApp(cfg: FactoryConfig, name: string): Ctx {
  const dir = appDirFor(cfg, name);
  const state = loadState(dir);
  return makeCtx(cfg, state, dir);
}

/** Run all pipeline stages, skipping ones already passed (resume-safe). */
export async function runPipeline(ctx: Ctx, extraContext = ""): Promise<void> {
  const started = Date.now();
  for (const name of STAGE_ORDER) {
    const rec = stageRec(ctx.state, name);
    if (rec.status === "passed") {
      log.info(`stage ${name}: already passed, skipping`);
      continue;
    }
    switch (name) {
      case "requirements":
        await requirementsStage(ctx, extraContext);
        break;
      case "architecture":
        await architectureStage(ctx);
        break;
      case "development":
        await developmentStage(ctx);
        break;
      case "qa":
      case "review":
      case "security":
        await gateStage(ctx, name);
        break;
      case "validation":
        await validationStage(ctx);
        break;
      case "deploy":
        await deployStage(ctx);
        break;
      case "evolution":
        await evolutionStage(ctx);
        break;
    }
  }
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  log.ok(`pipeline complete for ${ctx.state.app.name} in ${mins} min`);
  log.ok(`app: http://localhost:${ctx.state.app.port}  repo: ${ctx.state.app.repoUrl ?? "(local only)"}`);
}
