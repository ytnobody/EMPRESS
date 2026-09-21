# Design doc — triage scanDiff: SSRF / XXE / sh -c injection patterns

Tracks `test/triage.test.mjs`. Source of truth for the new L1 deterministic
patterns (§11 / §13). Behavior + interface only.

## Behavior spec

`scanDiff(patchText) -> { secrets: string[], dangerous: string[] }` gains three
new `DANGEROUS_PATTERNS` entries (mapped to the `injection:` security category in
`.empress/agents/coding-guidelines-security.md`):

1. **SSRF** — HTTP(S) request to an internal/private host
   (`localhost`, `127.0.0.1`, `0.0.0.0`, `169.254.169.254` cloud metadata,
   `10.*`, `192.168.*`, `172.16–31.*`, `[::1]`). Name: `ssrf-internal-host`.
2. **XXE** — XML `<!DOCTYPE ... ENTITY ...>` or `<!ENTITY ...>` declaration that
   enables external entity expansion. Name: `xxe`.
3. **sh -c injection** — `sh|bash|zsh -c "..."` invocation whose payload contains
   a `${...}` template interpolation (`sh -c ${var}`), i.e. a shell string built
   from runtime input rather than a fixed literal. Name: `sh-c-injection`.

## Interface spec

Each entry: `{ name: string, re: RegExp }`. `scanDiff` iterates `SECRET_PATTERNS`
then `DANGEROUS_PATTERNS`, pushing each matched `name`. Pushing logic already
exists — no new function surface. `decideTriage` already escalates any
`dangerous` hit regardless of Jev.

## Deliberate/intended heuristics

Regex hit is a *signal*, not proof. False negatives (e.g. SSRF built via host
lookup, `sh -c` via array form, dynamic schemas) are out of scope; L3 LLM review
remains the backstop. `ponytail: regex heuristic`, upgrade = semantic/taint
analysis.