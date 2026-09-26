// empress CLI entry: argument dispatch for init / run / task / list / pause /
// resume / quit / status / doctor / dry-run / version.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, EMPRESS_DIR } from "../shared/config.ts";
import { initProject, type InitOpts } from "./init.ts";
import { runLoop } from "./run.ts";
import { doctor } from "./doctor.ts";
import { readLoopState, patchLoopState } from "./state.ts";
import { createTask, listTasks, removeTask } from "../domain/tasks.ts";
import { syncLocalToGh } from "../domain/taskstore.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** A parsed CLI flag value: always a string or a boolean true (bare flag). `_` holds positional args. */
type FlagValue = string | boolean;
interface Flags {
  [key: string]: FlagValue | string[] | undefined;
  _?: string[];
}

function version(): string {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "package.json"), "utf-8")) as { version: string };
  return pkg.version;
}

export async function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "init": {
      const opts = parseFlags(rest);
      const res = await initProject(cwd, opts as InitOpts);
      console.log("empress: project initialized.");
      console.log(`  config   : ${res.config}`);
      console.log(`  tasks    : ${res.tasksDir}`);
      console.log(`  agents   : ${res.agentsDir}  (edit the role prompts here)`);
      console.log(`\nNext steps:`);
      console.log(`  1. empress task "Some work" --acceptance "tests pass"   # create a task`);
      console.log(`  2. empress run                                          # start the loop`);
      break;
    }
    case "run": {
      const o = parseFlags(rest);
      await runLoop(cwd, {
        model: typeof o.model === "string" ? o.model : undefined,
        thinking: typeof o.thinking === "string" ? o.thinking : undefined,
        once: Boolean(o.once),
        // event-driven driver: wake cadence from [run] wake_interval ('--interval' intentionally dropped)
      });
      break;
    }
    case "task": {
      const o = parseFlags(rest);
      if (o.list || (o._ && o._[0] === "list")) {
        const t = listTasks(cwd, { includeAll: true });
        for (const task of t) {
          const flag = task.needs_clarification ? " [needs-clarification]" : "";
          console.log(`#${task.id} [${task.status}]${flag} ${task.title}`);
        }
        break;
      }
      const title = typeof o.title === "string" ? o.title : o._ ? o._.join(" ") : "";
      if (!title) {
        console.error("usage: empress task \"<title>\" [--acceptance \"...\"] [--purpose \"...\"] [--scope \"...\"] [--remove <id>]");
        process.exitCode = 1;
        break;
      }
      if (o.remove) {
        const ok = removeTask(cwd, Number(o.remove));
        console.log(ok ? `empress: removed task #${o.remove}` : `empress: task #${o.remove} not found`);
        break;
      }
      const task = createTask(cwd, {
        title,
        purpose: typeof o.purpose === "string" ? o.purpose : undefined,
        scope: typeof o.scope === "string" ? o.scope : undefined,
        acceptance: typeof o.acceptance === "string" ? [o.acceptance] : [],
        nongoals: typeof o.nongoal === "string" ? [o.nongoal] : [],
      });
      console.log(`empress: created task #${task.id} -> ${task.file}`);
      break;
    }
    case "list": {
      const t = listTasks(cwd, { includeAll: rest.includes("--all") });
      if (!t.length) {
        console.log("empress: no actionable tasks.");
        break;
      }
      for (const task of t) {
        console.log(`#${task.id} [${task.status}] ${task.title}${task.assignee ? ` (${task.assignee})` : ""}`);
      }
      break;
    }
    case "pause":
      patchLoopState(cwd, { status: "paused" });
      console.log("empress: paused (resume with `empress resume`).");
      break;
    case "resume":
      patchLoopState(cwd, { status: "running" });
      console.log("empress: resumed. `empress run` will pick it up.");
      break;
    case "quit":
      patchLoopState(cwd, { status: "quit" });
      // also create a marker for the interactive /empress prompt
      fs.writeFileSync(path.join(cwd, EMPRESS_DIR, "quit"), "");
      console.log("empress: quit requested. `empress run` will stop at next tick.");
      break;
    case "status": {
      const s = readLoopState(cwd);
      console.log(`status: ${s.status}`);
      console.log(`last pass: ${s.last_pass_at ?? "never"}`);
      console.log(`consecutive failures: ${s.consecutive_failures ?? 0}`);
      break;
    }
    case "sync": {
      const cfgSync = loadConfig(cwd);
      if (!cfgSync.github?.enabled) {
        console.error("empress: [github] enabled=false — nothing to sync. Set [github] enabled=true first.");
        break;
      }
      try {
        const created = syncLocalToGh(cwd, cfgSync);
        if (!created.length) {
          console.log("empress: no open local tasks to sync.");
          break;
        }
        for (const c of created) console.log(`  local #${c.id} -> GitHub issue #${c.ghNumber}: ${c.title}`);
      } catch (e) {
        console.error(`empress: sync failed: ${(e as { message?: unknown }).message}`);
        process.exitCode = 1;
      }
      break;
    }
    case "doctor":
      await doctor(cwd);
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(`empress ${version()}`);
      break;
    case "help":
    case "--help":
    case "-h":
    default:
      printHelp(version());
      break;
  }
}

function printHelp(ver: string) {
  console.log(`empress ${ver} — fully-automatic development harness on pi (local git + Jev).`);
  console.log("");
  console.log("Usage:");
  console.log("  empress init                       Scaffold empress.toml, .empress/, role prompts");
  console.log("  empress task \"<title>\" [opts]      Create a task file");
  console.log("  empress list [--all]               List open tasks");
  console.log("  empress run [--once] [--model M]   Start the Superintendent tick loop");
  console.log("  empress pause|resume|quit|status   Control autonomous operation");
  console.log("  empress sync                         Migrate open local tasks to GitHub issues ([github] enabled)");
  console.log("  empress doctor                     Check prerequisites");
  console.log("  empress version                    Print version");
  console.log("");
  console.log("Inside pi, run a Superintendent pass with /empress.");
}

/** Light-weight flag parser. Supports `--flag`, `--flag=value`, and `--flag value`. */
function parseFlags(args: string[]): Flags {
  const out: Flags = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        // boolean-ish flags
        if (["once", "list", "remove", "force", "all", "help"].includes(key)) {
          out[key] = true;
        } else if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
          out[key] = args[++i];
        } else {
          out[key] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      out[arg.slice(1)] = true;
    } else {
      rest.push(arg);
    }
  }
  if (rest.length) out._ = rest;
  return out;
}