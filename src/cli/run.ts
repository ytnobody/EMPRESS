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
import { shouldStallKill } from "../domain/stall.ts";
import { readLoopState, patchLoopState, type LoopStatePatch } from "./state.ts";
import { tasksHash } from "../domain/wake.ts";
import { listTasks, getTask, hasHumanReply, detectLanguage, type Task } from "../domain/tasks.ts";
import { checkReadyTasks, nextJevFailures, JEV_DEGRADED_REASON, postClarifyProposals } from "../domain/readiness.ts";

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
  clarifyLang?: Record<number, string>;
}

interface RunPassResult {
  code: number;
  out: string;
  err: string;
}

function runPass({ cwd, config, model, thinking, audit = false, mode = "run", clarificationIds = [], clarifyLang = {} }: RunPassOptions): Promise<RunPassResult> {
  const agentPrompt = path.join(cwd, ".empress", "agents", "superintendent.md");
  const args: string[] = ["--print", "--no-session", "-e", EXTENSION];
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  if (config.project?.test_command) process.env.EMPRESS_TEST_COMMAND = config.project.test_command;
  args.push("--append-system-prompt", agentPrompt);
  if (mode === "audit") args.push(AUDIT_MSG);
  else if (mode === "clarify") {
    const langHint = Object.entries(clarifyLang).length
      ? `Issue languages (detected) to match in ALL your comments/questions: ${Object.entries(clarifyLang).map(([id, l]) => `#${id}=${l}`).join(", ")}.`
      : "Respond in the language of each issue's title/body (detected: ja for Japanese, zh, ko, else en).";
    args.push(`${CLARIFY_MSG}\n\nTasks to clarify (ids): ${clarificationIds.join(", ") || "<none>"}\n${langHint}`);
  } else args.push(SUPER_MSG);

  return new Promise((resolve) => {
    const proc = spawn("pi", args, { cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";

    let settled = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    // Single settle path: whichever guard fires first wins; later guards are no-ops.
    const settle = (code: number, note?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (stallTimer) clearTimeout(stallTimer);
      resolve({ code, out, err: note ? `${err}\n${note}` : err });
    };

    // Absolute wall-clock cap: no matter what, a pass must not hang the loop
    // forever (e.g. an always-talking-but-spinning pass).
    const timeoutMs = Math.max(1, Number(config.run?.pass_timeout ?? 600)) * 1000;
    const timeoutTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      settle(-1, `[empress] pass stalled: no exit within ${timeoutMs / 1000}s — killed; loop continues on next wake.`);
    }, timeoutMs);

    // Activity watchdog: distinguishes "slow but working" (child alive, producing
    // output) from "stalled" (child alive yet silent for the whole stall window).
    // Debounce timer re-armed on every output; the kill decision is delegated to
    // the pure shouldStallKill.
    // ponytail: I/O-activity only (no CPU/proc accounting) — a pass that spins CPU
    // with zero output is caught only by pass_timeout; add per-pid/cpu sampling of
    // the child if that case ever matters.
    const stallMs = Math.max(1, Number(config.run?.pass_stall_seconds ?? 300)) * 1000;
    let lastActivityAt = Date.now();
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (shouldStallKill({ childAlive: proc.exitCode === null, lastActivityAt, now: Date.now(), stallMs })) {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          settle(-1, `[empress] pass stalled: no child-process/output activity within ${stallMs / 1000}s — killed; loop continues on next wake.`);
        }
      }, stallMs);
    };

    const onActivity = (d: string) => (lastActivityAt = Date.now(), armStall(), d);
    proc.stdout.on("data", (d) => (out += onActivity(d.toString())));
    proc.stderr.on("data", (d) => (err += onActivity(d.toString())));
    proc.on("close", (code) => settle(code ?? -1));
    proc.on("error", (e) => settle(-1, String(e.message)));
    armStall();
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
      // Actionable-for-preflight: not-done tasks PLUS needs_clarification tasks that
      // have a pending human reply. Once a proposal is posted and the task marked
      // blocked (driver or empress_readiness), the default list hides it — so the
      // reply must still be picked up here on the next wake, or a single human reply
      // could never resolve the task. gh's issue list carries no comments, so tasks
      // needing the reply check are re-read fresh (cheap, deterministic).
      const actionable: Task[] = [];
      for (const t of listTasks(cwd, { includeAll: true })) {
        if (t.status === "done") continue;
        if (!t.needs_clarification) {
          actionable.push(t);
        } else {
          const fresh = getTask(cwd, t.id);
          if (fresh && hasHumanReply(fresh)) actionable.push(fresh);
        }
      }
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
        const notReady = checks.filter((c) => !c.ready);
        // Proposal-first immediate response (Task #35): any not-ready task gets its
        // draft spec + open questions posted NOW (deduped by the marker), before any
        // LLM round trip — a fresh title-only issue costs zero LLM on first detection.
        let pendingReply: number[] = [];
        if (notReady.length) {
          const posted = postClarifyProposals(cwd, notReady.map((c) => ({ task: c.task, reasons: c.reasons })));
          pendingReply = posted.pendingReply;
          console.log(
            `\n[wake ${new Date().toISOString()}] not-ready: ${notReady.length} (${posted.posted} clarify proposal(s) posted)` +
              (pendingReply.length ? `; ${pendingReply.length} with pending human reply` : "")
          );
        }
        if (readyIds.length > 0) {
          pass++;
          const started = new Date().toISOString();
          console.log(`\n--- pass ${pass} (${started}) ready: #${readyIds.join(", #")} ---`);
          const res = await runPass({ cwd, config, model: superModel, thinking });
          await handleResult(cwd, res, started, pass, config);
        } else if (pendingReply.length > 0) {
          // Clarification Q&A pass: only tasks with an actual pending human reply
          // (the rest keep their posted proposal until the human answers). The
          // Superintendent drives the Q&A via comments and, when resolved, rewrites
          // the issue body + clears needs_clarification so the next pass can implement.
          pass++;
          const started = new Date().toISOString();
          const ids = pendingReply;
          const langMap: Record<number, string> = {};
          for (const c of checks) if (pendingReply.includes(c.task.id)) langMap[c.task.id] = detectLanguage(`${c.task.title || ""} ${c.task.body || ""}`);
          console.log(`\n--- clarify pass ${pass} (${started}) clarification: #${ids.join(", #")} ---`);
          const cres = await runPass({ cwd, config, model: superModel, thinking, mode: "clarify", clarificationIds: ids, clarifyLang: langMap });
          await handleResult(cwd, cres, started, pass, config);
        } else {
          console.log(`\n[wake ${new Date().toISOString()}] 0 ready ${notReady.length ? "— awaiting human reply on clarification" : ""} — skip (zero LLM)`);
          patchLoopState(cwd, { last_skip_reason: notReady.length ? "awaiting human reply on clarification" : `no ready work (${actionable.length} actionable)` });
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