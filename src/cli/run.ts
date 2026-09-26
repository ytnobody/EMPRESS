// `empress run`: event-driven Superintendent driver.
//
// Cost model (cheapest first):
//   1. zero-LLM fs poll (tasksHash) — wake only when the task queue changed
//   2. preflight readiness (deterministic + ONE Jev batch call) — LLM is only
//      spawned when at least one task is actually READY
//   3. LLM pass (pi Superintendent) — only for real work; plus an idle
//      self-audit LLM pass on the `audit_interval` cadence (0 = disabled)
//
// No LLM is ever spawned just because the clock ticked past some interval with
// nothing to do (unless the idle audit is enabled).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig, type LoadedConfig } from "../shared/config.ts";
import { readLoopState, patchLoopState, type LoopStatePatch } from "./state.ts";
import { tasksHash } from "../domain/wake.ts";
import { listTasks } from "../domain/tasks.ts";
import { checkReadyTasks, nextJevFailures, JEV_DEGRADED_REASON } from "../domain/readiness.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.resolve(__dirname, "..", "extension", "empress.ts");

const SUPER_MSG =
  "You are the EMPRESS Superintendent. Run exactly one Superintendent cycle now: " +
  "use the empress_* tools to list actionable tasks, judge readiness, assign, create worktrees, " +
  "spawn Engineers in parallel, wait for them, check the test command, triage + evaluate risk, " +
  "land safe tasks, and record lessons. End with a short human-readable report of this pass.";

const AUDIT_MSG =
  "You are the EMPRESS Superintendent running an IDLE AUDIT pass (no ready work — this pass is scheduled by the run driver's audit_interval). " +
  "Follow .empress/agents/superintendent.md's Idle audit pass. Aim to make the repo " +
  "MORE MODERN (rotate rot: TODO/FIXME/HACK, stale patterns), MORE SECURE (CVEs, " +
  "secrets, dangerous patterns, tracked secret-ish files), and LIGHTER/FASTER (large " +
  "files, dead weight) — `empress_audit_scan` gives deterministic findings per axis. " +
  "File REAL findings as tasks via bash `bun bin/empress.ts task \"<title>\" --acceptance \"...\"` " +
  "(dedupe by simple title match; prefer auto-landable LOW/MEDIUM tasks, separate control-plane HIGH ones) " +
  "and report what you did. Do NOT spawn Engineers or land anything during an audit pass.";

const CLARIFY_MSG =
  "You are the EMPRESS Superintendent running a CLARIFICATION pass. The following tasks are marked needs_clarification and have a pending human reply in their comments. " +
  "Drive the Q&A **entirely via the issue's comments** — do NOT rewrite the body directly yet. " +
  "For each: `empress_get_task` to read the full comment thread (the human's answers are the plain-text replies without a [agent] marker prefix, per hasHumanReply). " +
  "Incorporate the answers into a refined understanding, then either (a) post a follow-up question as a comment if something is still ambiguous, or (b) if the open questions are resolved, " +
  "**rewrite the issue body once with the resolved Purpose/Scope/Acceptance/Non-Goals via `empress_apply_clarification`** (which clears needs_clarification). " +
  "Do not spawn Engineers or land anything in this pass. End with a short report of what you asked / clarified.";

interface RunPassOptions {
  cwd: string;
  config: LoadedConfig;
  model?: string;
  thinking?: string;
  mode?: "run" | "audit" | "clarify";
  audit?: boolean;
  clarificationIds?: number[];
}

interface RunPassResult {
  code: number;
  out: string;
  err: string;
}

function runPass({ cwd, config, model, thinking, audit = false, mode = "run", clarificationIds = [] }: RunPassOptions): Promise<RunPassResult> {
  const agentPrompt = path.join(cwd, ".empress", "agents", "superintendent.md");
  const args: string[] = ["--print", "--no-session", "-e", EXTENSION];
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  if (config.project?.test_command) process.env.EMPRESS_TEST_COMMAND = config.project.test_command;
  args.push("--append-system-prompt", agentPrompt);
  if (mode === "audit") args.push(AUDIT_MSG);
  else if (mode === "clarify") args.push(`${CLARIFY_MSG}\n\nTasks to clarify (ids): ${clarificationIds.join(", ") || "<none>"}`);
  else args.push(SUPER_MSG);

  return new Promise((resolve) => {
    const proc = spawn("pi", args, { cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    // Stall guard: a Superintendent/Engineer pass must not hang the loop forever.
    // If the child hasn't exited within pass_timeout we SIGKILL it and resolve as
    // a failed (stalled) pass; the loop's next wake then retries the queue.
    const timeoutMs = Math.max(1, Number(config.run?.pass_timeout ?? 1800)) * 1000;
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve({ code: -1, out, err: `${err}\n[empress] pass stalled: no exit within ${timeoutMs / 1000}s — killed; loop continues on next wake.` });
    }, timeoutMs);
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e.message) });
    });
  });
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function handleResult(cwd: string, res: RunPassResult, started: string, pass: number, config: LoadedConfig) {
  const stateNow = readLoopState(cwd);
  if (res.code === 0) {
    patchLoopState(cwd, { last_pass_at: started, last_success_tick: started, consecutive_failures: 0, pass_count: pass });
    if (res.out) console.log(res.out.slice(0, 5000));
    if (res.err) console.error(res.err.slice(0, 2000));
  } else {
    console.error(`pass ${pass} failed (exit ${res.code})`);
    if (res.err) console.error(res.err.slice(0, 4000));
    const fails = (stateNow.consecutive_failures || 0) + 1;
    patchLoopState(cwd, { last_pass_at: started, consecutive_failures: fails });
    const threshold = Number(config.run?.failure_notify_threshold ?? 3);
    if (fails >= threshold) console.error(`empress: ${fails} consecutive failed passes (threshold ${threshold}). Consider intervening.`);
  }
}

export async function runLoop(
  cwd: string,
  { model, thinking, once = false }: { model?: string; thinking?: string; once?: boolean } = {}
) {
  const config = loadConfig(cwd);
  if (!config.file) {
    console.error("empress: no empress.toml found (run `empress init` first).");
    process.exitCode = 1;
    return;
  }

  const wakeMs = Math.max(1, Number(config.run?.wake_interval ?? 60)) * 1000;
  const auditMs = Number(config.run?.audit_interval ?? 3600) * 1000;
  const auditEnabled = auditMs > 0;
  // Superintendent model: explicit CLI --model wins; else [models] superintendent;
  // else unset → pi's default model.
  const superModel = model || (config.models && config.models.superintendent) || undefined;
  console.log(
    `empress run: project=${cwd} wake=${wakeMs / 1000}s audit=${auditEnabled ? auditMs / 1000 + "s" : "off"}` +
      (superModel ? ` superintendent-model=${superModel}` : " superintendent-model=pi-default")
  );

  let prevHash: string | null = null;
  let lastAuditAt = Date.now();
  let pass = 0;

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
      await sleepFor(wakeMs);
      continue;
    }

    if (once) {
      // legacy single-pass mode: always run exactly one Superintendent cycle
      pass++;
      const started = new Date().toISOString();
      console.log(`\n--- pass ${pass} (${started}) ---`);
      const res = await runPass({ cwd, config, model: superModel, thinking });
      await handleResult(cwd, res, started, pass, config);
      break;
    }

    const now = Date.now();
    const auditDue = auditEnabled && now - lastAuditAt >= auditMs;
    const hash = tasksHash(cwd);
    const changed = prevHash === null || hash !== prevHash; // first tick checks too
    prevHash = hash;

    // If nothing happened and no audit is due, sleep — zero LLM, zero Jev.
    if (!changed && !auditDue) {
      await sleepFor(wakeMs);
      continue;
    }

    if (changed && !auditDue) {
      const actionable = listTasks(cwd);
      if (actionable.length === 0) {
        console.log(`\n[wake ${new Date().toISOString()}] queue changed but no actionable tasks — skip (zero LLM)`);
        patchLoopState(cwd, { last_skip_reason: "tasks changed, none actionable" });
      } else {
        // preflight: ONE Jev batch call; spawn LLM only if something is ready
        const checks = await checkReadyTasks(cwd, config, actionable);
        // Visible degradation: count consecutive Jev-failure preflights and log them
        // via last_skip_reason (deterministic-only readiness still lets the loop run).
        const jevDegraded = checks.some((c) => c.reasons.includes(JEV_DEGRADED_REASON));
        const prior = readLoopState(cwd);
        if (jevDegraded || prior.consecutive_jev_failures) {
          const patch: LoopStatePatch = { consecutive_jev_failures: nextJevFailures(jevDegraded, prior.consecutive_jev_failures) };
          if (jevDegraded) patch.last_skip_reason = JEV_DEGRADED_REASON;
          patchLoopState(cwd, patch);
        }
        const readyIds = checks.filter((c) => c.ready).map((c) => c.task.id);
        if (readyIds.length === 0) {
          const notReady = checks.filter((c) => !c.ready).map((c) => c.task);
          if (notReady.length) {
            // Clarification Q&A pass: thin/under-specified tasks (incl. fresh
            // human-created issues) — the Superintendent drives the Q&A via
            // comments and, when resolved, rewrites the issue body + clears
            // needs_clarification so the next pass can implement.
            pass++;
            const started = new Date().toISOString();
            const ids = notReady.map((t) => t.id);
            console.log(`\n--- clarify pass ${pass} (${started}) clarification: #${ids.join(", #")} ---`);
            const cres = await runPass({ cwd, config, model: superModel, thinking, mode: "clarify", clarificationIds: ids });
            await handleResult(cwd, cres, started, pass, config);
          } else {
            console.log(`\n[wake ${new Date().toISOString()}] ${actionable.length} actionable, 0 ready (${checks.filter((c) => !c.ready).length} not-ready) — skip (zero LLM)`);
            patchLoopState(cwd, { last_skip_reason: `no ready work (${actionable.length} actionable)` });
          }
        } else {
          pass++;
          const started = new Date().toISOString();
          console.log(`\n--- pass ${pass} (${started}) ready: #${readyIds.join(", #")} ---`);
          const res = await runPass({ cwd, config, model: superModel, thinking });
          await handleResult(cwd, res, started, pass, config);
        }
      }
    }

    if (auditDue) {
      lastAuditAt = Date.now();
      pass++;
      const started = new Date().toISOString();
      console.log(`\n--- audit pass ${pass} (${started}) ---`);
      const res = await runPass({ cwd, config, model: superModel, thinking, mode: "audit" });
      await handleResult(cwd, res, started, pass, config);
    }

    await sleepFor(wakeMs);
  } while (true);
}