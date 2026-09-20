// Jev judgment layer: shells out to the CHARIOT CLI (TypeSafe System One).
// chariot reads one state per stdin line and streams NDJSON results to stdout.
// See ../CHARIOT/README.md for CLI semantics.
import { spawn } from "node:child_process";

const TYPES = ["choice", "score", "noul"];

/**
 * Run one Jev judgment for a batch of states.
 *
 * @param {object} opts
 * @param {string} opts.type  - "choice" | "score" | "noul"
 * @param {string} opts.instructions - the natural-language question
 * @param {string[]} opts.states     - one input line per judgment
 * @param {string[]} [opts.options]  - criteria options (choice/score)
 * @param {string} [opts.criteria]   - raw criteria (overrides options)
 * @param {string} [opts.command]    - chariot binary (default "chariot")
 * @param {string} [opts.model]      - default jev-latest
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok: boolean, results: object[], error?: string}>}
 */
export function jevJudge({ type, instructions, states, options = [], criteria, command = "chariot", model = "jev-latest", timeoutMs = 60000 }) {
  return new Promise((resolve) => {
    if (!TYPES.includes(type)) {
      return resolve({ ok: false, results: [], error: `invalid type "${type}"` });
    }
    const args = [type];
    if (criteria) {
      args.push("-c", criteria);
    } else if (options && options.length > 0) {
      args.push("-c", options.join(", "));
    }
    if (model !== "jev-latest") args.push("-m", model);
    args.push(instructions);

    // capacity: chariot streams a result as soon as it completes, so we collect
    // by matching the `line` field, which is 1-based in input order.
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, results: [], error: `cannot spawn ${command}: ${e.message}` });
    }

    const results = [];
    let buf = "";
    let errBuf = "";
    let done = false;

    const finish = (error) => {
      if (done) return;
      done = true;
      resolve({ ok: !error && results.length === states.length, results, error });
    };

    child.stdout.on("data", (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          results.push(JSON.parse(line));
        } catch {
          /* ignore malformed */
        }
      }
    });

    child.stderr.on("data", (d) => {
      errBuf += d.toString();
    });

    child.on("error", (e) => finish(`failed to launch Jev (${command}): ${e.message}. Is chariot installed and TYPESAFE_API_KEY set?`));
    child.on("close", (code) => {
      if (code === 0) finish(errBuf.trim() || undefined);
      else finish(`Jev (${command}) exited ${code}: ${errBuf.trim()}`);
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(`Jev timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    timer.unref?.();

    child.stdin.on("error", () => {});
    for (const s of states) child.stdin.write((s || "") + "\n");
    child.stdin.end();
  });
}

/**
 * Convenience: single-judgment call. Returns { value, confidence, raw, ok, error }.
 * `value` is normalized: noul → probability number, choice → chosen string,
 * score → weighted numeric score.
 */
export async function jevOne(opts) {
  const r = await jevJudge({ ...opts, states: [opts.state ?? ""] });
  if (!r.ok || !r.results[0]) {
    return { ok: false, value: null, confidence: null, raw: null, error: r.error || "no result" };
  }
  const raw = r.results[0];
  const answer = raw.answer;
  let value = null;
  let confidence = null;
  if (answer && typeof answer === "object") {
    value = answer.noul ?? answer.choice ?? answer.score ?? null;
    confidence = answer.confidence ?? null;
  }
  return { ok: true, value, confidence: typeof confidence === "number" ? confidence : null, raw };
}

/** Detect whether Jev is usable at all (chariot present + API key set). */
export function jevAvailable(command = "chariot") {
  const key = process.env.TYPESAFE_API_KEY;
  return { chariot: command !== "", apiKey: Boolean(key), available: Boolean(key) };
}