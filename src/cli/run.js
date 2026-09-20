// `empress run`: the Superintendent tick loop driver.
// Each pass spawns one non-interactive pi session (JSON mode) that runs a single
// Superintendent cycle using the empress_* tools, then sleeps loop_interval.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig } from "../shared/config.js";
import { readLoopState, patchLoopState } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.resolve(__dirname, "..", "extension", "empress.ts");

/** Spawn one pi Superintendent pass. Resolves { code, output }. */
function runPass({ cwd, config, model, thinking }) {
  const agentPrompt = path.join(cwd, ".empress", "agents", "superintendent.md");
  const args = [
    "--print",
    "--no-session",
    "-e", EXTENSION,
  ];
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  if (config.project?.test_command) {
    // surface the configured test command so the superintendent/ptools can reuse it
    process.env.EMPRESS_TEST_COMMAND = config.project.test_command;
  }
  args.push("--append-system-prompt", agentPrompt);
  args.push(
    "You are the EMPRESS Superintendent. Run exactly one Superintendent cycle now: " +
      "use the empress_* tools to list actionable tasks, judge readiness, assign, create worktrees, " +
      "spawn Engineers in parallel, wait for them, check the test command, evaluate risk, land safe tasks, " +
      "and record lessons. End with a short human-readable report of this pass."
  );

  return new Promise((resolve) => {
    const proc = spawn("pi", args, {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) => resolve({ code: code ?? -1, out, err }));
    proc.on("error", (e) => resolve({ code: -1, out, err: String(e.message) }));
  });
}

function sleepFor(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runLoop(cwd, { model, thinking, once = false, interval } = {}) {
  const config = loadConfig(cwd);
  const loopInterval = interval ?? Number(config.agent?.loop_interval ?? 120);

  if (!config.file) {
    console.error("empress: no empress.toml found (run `empress init` first).");
    process.exitCode = 1;
    return;
  }

  console.log(`empress run: project=${cwd} loop_interval=${loopInterval}s`);
  let pass = 0;

  // If --once, do a single synchronous pass (for debugging / one-off supervision).
  do {
    const state = readLoopState(cwd);
    if (state.status === "quit") {
      console.log("empress run: status=quit — stopping. Clear it with `empress resume` or by editing state.");
      break;
    }
    if (state.status === "paused") {
      if (once) {
        console.log("empress run: paused — skipping pass.");
        break;
      }
      await sleepFor(loopInterval * 1000);
      continue;
    }

    pass++;
    const started = new Date().toISOString();
    console.log(`\n--- pass ${pass} (${started}) ---`);
    const res = await runPass({ cwd, config, model, thinking });

    const stateNow = readLoopState(cwd);
    if (res.code === 0) {
      patchLoopState(cwd, {
        last_pass_at: started,
        last_success_tick: started,
        consecutive_failures: 0,
        pass_count: pass,
      });
      if (res.out) console.log(res.out.slice(0, 4000));
      if (res.err) console.error(res.err.slice(0, 2000));
    } else {
      console.error(`pass ${pass} failed (exit ${res.code})`);
      if (res.err) console.error(res.err.slice(0, 4000));
      const fails = (stateNow.consecutive_failures || 0) + 1;
      patchLoopState(cwd, { last_pass_at: started, consecutive_failures: fails });
      const threshold = Number(config.run?.failure_notify_threshold ?? 3);
      if (fails >= threshold) {
        console.error(`empress: ${fails} consecutive failed passes (threshold ${threshold}). Consider intervening.`);
      }
    }

    if (once) break;
    await sleepFor(loopInterval * 1000);
  } while (!once);
}