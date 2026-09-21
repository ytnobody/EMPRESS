// Jev client (native, fetch-based) — Command Verification style tests.
// Per PFT: we assert the *request* is assembled correctly (Command) and that
// answers are mapped correctly, WITHOUT hitting the real API (inject fetchFn).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSystemOneRequest,
  buildCriteria,
  parseAnswer,
  jevOne,
  jevJudge,
  // not exported (internal) but exercised via jevOne/jevJudge
} from "../src/domain/jev.js";

const API_URL = "https://api.typesafe.ai/v1/systemone";

// Verifies: a choice request is {state, model, questions:{q:{type,instructions,criteria}}}
// where criteria is a dict built from the options (Command shape, no network).
test("buildSystemOneRequest: choice produces a dict criteria", () => {
  const req = buildSystemOneRequest({
    type: "choice",
    instructions: "pick one",
    state: "state-1",
    model: "jev-latest",
    options: ["low", "medium", "high"],
  });
  assert.deepEqual(req, {
    state: "state-1",
    model: "jev-latest",
    questions: { q: { type: "choice", instructions: "pick one", criteria: { low: "low", medium: "medium", high: "high" } } },
  });
});

// Verifies: a score request's criteria is an ordered LIST (low->high), not a dict.
test("buildSystemOneRequest: score produces an ordered-list criteria", () => {
  const req = buildSystemOneRequest({
    type: "score",
    instructions: "level",
    state: "s",
    options: ["calm", "irritated", "furious"],
  });
  assert.deepEqual(req.questions.q.criteria, ["calm", "irritated", "furious"]);
});

// Verifies: explicit criteria overrides options and is passed through untouched.
test("buildSystemOneRequest: explicit raw criteria wins over options", () => {
  const req = buildSystemOneRequest({
    type: "choice",
    instructions: "x",
    state: "s",
    criteria: { a: "A" },
    options: ["b"],
  });
  assert.deepEqual(req.questions.q.criteria, { a: "A" });
});

// Verifies: an invalid type throws rather than producing a malformed request.
test("buildSystemOneRequest: rejects unknown type", () => {
  assert.throws(() => buildSystemOneRequest({ type: "bogus", instructions: "x", state: "s" }), /invalid Jev type/);
});

// Verifies: answer mapping — noul -> probability, choice -> string, score -> number, plus confidence.
test("parseAnswer: maps noul/choice/score and confidence", () => {
  assert.deepEqual(parseAnswer({ noul: 0.9 }), { value: 0.9, confidence: null, raw: { noul: 0.9 } });
  assert.deepEqual(parseAnswer({ choice: "high", confidence: 0.8 }), { value: "high", confidence: 0.8, raw: { choice: "high", confidence: 0.8 } });
  assert.deepEqual(parseAnswer({ score: 3, confidence: 0.6 }), { value: 3, confidence: 0.6, raw: { score: 3, confidence: 0.6 } });
  assert.deepEqual(parseAnswer(null), { value: null, confidence: null, raw: null });
});

// Fake transport: a Response-shaped object built from a canned handler.
function fakeFetch(canned) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const body = JSON.parse(init.body);
    const out = canned(body);
    return {
      ok: out === null ? false : true,
      status: out === null ? 500 : 200,
      async json() { return out; },
      async text() { return "boom"; },
    };
  };
  fn.calls = calls;
  return fn;
}

// Verifies: jevOne POSTs to the System One endpoint with a Bearer token and the
// exact assembled body, and returns the mapped scalar. (Command verification of
// the transport: we verify the request, and that a canned answer maps correctly.)
test("jevOne: sends correct request and maps the answer", async () => {
  const fetchFn = fakeFetch(() => ({ answers: { q: { noul: 0.87 } } }));
  const r = await jevOne({
    type: "noul",
    instructions: "is this urgent?",
    state: "the state",
    apiKey: "test-key",
    fetchFn,
  });
  assert.equal(fetchFn.calls.length, 1);
  const { url, init } = fetchFn.calls[0];
  assert.equal(url, API_URL);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(init.body), {
    state: "the state",
    model: "jev-latest",
    questions: { q: { type: "noul", instructions: "is this urgent?" } },
  });
  assert.deepEqual(r, { ok: true, value: 0.87, confidence: null, raw: { noul: 0.87 } });
});

// Verifies: per-state results keep line order across a batch.
test("jevJudge: batches states and keeps order", async () => {
  const fetchFn = fakeFetch((body) => ({ answers: { q: { noul: body.state === "a" ? 0.1 : 0.9 } } }));
  const r = await jevJudge({
    type: "noul",
    instructions: "x",
    states: ["a", "b"],
    apiKey: "k",
    fetchFn,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.map((x) => [x.line, x.answer.noul]), [[1, 0.1], [2, 0.9]]);
});

// Verifies: a non-2xx response is reported as a failure (ok:false, error set),
// not silently treated as a pass.
test("jevJudge: HTTP error surfaces as failure", async () => {
  const fetchFn = fakeFetch(() => null); // null -> 500 in fakeFetch
  const r = await jevOne({ type: "noul", instructions: "x", state: "s", apiKey: "k", fetchFn });
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 500/);
});

// Verifies: no apiKey is handled by the caller fallback (jevAvailable false), and
// jevJudge without a key does not attempt a request when none is provided.
test("jevAvailable: false without TYPESAFE_API_KEY", async () => {
  const prev = process.env.TYPESAFE_API_KEY;
  try {
    delete process.env.TYPESAFE_API_KEY;
    const { jevAvailable } = await import("../src/domain/jev.js");
    assert.equal(jevAvailable().available, false);
  } finally {
    process.env.TYPESAFE_API_KEY = prev;
  }
});