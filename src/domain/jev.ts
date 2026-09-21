// Jev (TypeSafe System One) access, native to EMPRESS.
//
// This used to shell out to a separate CHARIOT CLI (Go). The Jev client is a
// single POST to https://api.typesafe.ai/v1/systemone, so it is implemented
// here directly with fetch (Node 18+). The only external input is the
// TYPESAFE_API_KEY environment variable; without it, callers fall back to
// deterministic rules (see jevAvailable).
//
// Design (Pure Function Testing): request construction and answer mapping are
// pure functions, testable by verification arithmetic without any network.
// The only side effect is the HTTP call, which is injectable (fetchFn) so the
// request/response contract can be asserted without hitting the real API.

const API_URL = "https://api.typesafe.ai/v1/systemone";

const TYPES = ["choice", "score", "noul"];

export type JevType = "choice" | "score" | "noul";

/** Criteria shape: ordered list (score) or name->description dict (choice/noul). */
export type JevCriteria = string[] | Record<string, string>;

export interface SystemOneRequest {
  state: string;
  model: string;
  questions: {
    q: { type: string; instructions: string; criteria?: JevCriteria };
  };
}

export function buildSystemOneRequest({
  type,
  instructions,
  state,
  model = "jev-latest",
  criteria,
  options = [],
}: {
  type: string;
  instructions: string;
  state: unknown;
  model?: string;
  criteria?: JevCriteria;
  options?: string[];
}): SystemOneRequest {
  if (!TYPES.includes(type)) throw new Error(`invalid Jev type "${type}"`);
  const q: SystemOneRequest["questions"]["q"] = { type, instructions };
  if (criteria) q.criteria = criteria;
  else if (options.length) q.criteria = buildCriteria(type, options);
  return { state: String(state ?? ""), model, questions: { q } };
}

/** Pure: choice wants a dict (name->description), score wants an ordered list. */
export function buildCriteria(type: string, options: string[]): JevCriteria {
  if (type === "score") return options.slice();
  const dict: Record<string, string> = {};
  for (const o of options) dict[o] = o;
  return dict;
}

// --- Pure: map a System One answer to a scalar + confidence ------------------

export interface SystemOneAnswer {
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
}

/**
 * Reduce a raw System One answer object to { value, confidence, raw }.
 * noul -> probability number; choice -> picked string; score -> weighted number.
 */
export function parseAnswer(
  answer: unknown
): { value: number | string | null; confidence: number | null; raw: unknown } {
  if (answer === null || typeof answer !== "object") {
    return { value: null, confidence: null, raw: answer };
  }
  const a = answer as SystemOneAnswer;
  return {
    value: a.noul ?? a.choice ?? a.score ?? null,
    confidence: typeof a.confidence === "number" ? a.confidence : null,
    raw: answer,
  };
}

// --- Transport (injectable) ---------------------------------------------------

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

async function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}

// --- Public batch API ----------------------------------------------------------

export interface JevOptions {
  type: string;
  instructions: string;
  states?: string[];
  options?: string[];
  criteria?: JevCriteria;
  model?: string;
  apiKey?: string;
  fetchFn?: FetchFn;
}

export interface JevEntry {
  line: number;
  input: string;
  answer: SystemOneAnswer | null;
}

export interface JevBatchResult {
  ok: boolean;
  results: JevEntry[];
  error?: string;
}

/**
 * Run one or more judgments for a batch of states, in parallel.
 */
export async function jevJudge({
  type,
  instructions,
  states = [],
  options = [],
  criteria,
  model = "jev-latest",
  apiKey,
  fetchFn = defaultFetch,
}: JevOptions): Promise<JevBatchResult> {
  if (!TYPES.includes(type)) return { ok: false, results: [], error: `invalid type "${type}"` };
  const key = apiKey ?? process.env.TYPESAFE_API_KEY;

  const results: JevEntry[] = [];
  let failed: string | null = null;
  await Promise.all(
    states.map(async (state, i) => {
      const body = buildSystemOneRequest({ type, instructions, state, model, criteria, options });
      try {
        const res = await fetchFn(API_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Jev HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
        const parsed = (await res.json()) as { answers?: { q?: SystemOneAnswer | null } };
        const answer = parsed?.answers?.["q"] ?? null;
        // map by input line, not completion order: parallel fetches may settle in
        // any order, so assign at results[i] (input index) rather than push().
        results[i] = { line: i + 1, input: state, answer };
      } catch (e) {
        failed = failed || `state ${i + 1}: ${e instanceof Error ? e.message : String(e)}`;
      }
    })
  );

  if (failed) return { ok: false, results, error: failed };
  return { ok: results.length === states.length, results, error: undefined };
}

/**
 * Convenience: single-judgment call. Returns { ok, value, confidence, raw, error }.
 */
export async function jevOne(
  opts: JevOptions & { state?: string }
): Promise<{
  ok: boolean;
  value: number | string | null;
  confidence: number | null;
  raw: unknown;
  error?: string;
}> {
  const r = await jevJudge({ ...opts, states: [opts.state ?? ""] });
  if (!r.ok || !r.results[0]) {
    return { ok: false, value: null, confidence: null, raw: null, error: r.error || "no result" };
  }
  return { ok: true, ...parseAnswer(r.results[0].answer) };
}

/**
 * Whether Jev is usable at all (requires TYPESAFE_API_KEY). Without it callers
 * fall back to deterministic rules. The old `command` arg is accepted and ignored
 * (kept for call-compat during the chariot removal).
 */
export function jevAvailable(
  command?: string
): { chariot: boolean; apiKey: boolean; available: boolean } {
  const apiKey = Boolean(process.env.TYPESAFE_API_KEY);
  return { chariot: command !== "", apiKey, available: apiKey };
}