# Task #33 — Auto-land behavior-preserving pure refactors

## Behaviour spec
Large mechanical relocations (#23 taskstore split, #25 empress/tools split) trip the
≥500-line / high-path heuristics and are rated HIGH, blocking auto-land even though
the loop can mechanically prove behavior is preserved. When a change is *proven* to be
a pure relocation, downgrade its HIGH so the loop auto-lands after full review. Any
real behavior difference stays HIGH.

## Decision rule (pure function over a diff's file contents)
A change is a **behavior-preserving pure refactor** iff ALL three hold:

1. **Export-surface parity** — the union of exported names (`export function/const/
   class/type/interface`, re-export `export { … }`, `export * from`) across all touched
   source files is identical before vs after.
2. **registerTool parity** — the set of `registerTool(… name:"X")` tool names across
   all touched source files is identical before vs after.
3. **No behavior-only hunks** — after dropping structural boilerplate (blank, `//`
   comments, `import`, export-declaration headers, `{}` braces), the multiset of
   *behavior* lines added equals the multiset removed (verbatim relocation); any new
   executable statement with no matching removal fails this.

Guarded operationally: file contents are sourced from git (`before` = `<base>:<path>`,
`after` = `<branch>:<path>`). Detection is conservative — uncertainty fails toward
`pure=false`, keeping HIGH (human), never auto-lands a behavior change.

## Wiring
`evaluateRisk` (src/domain/risk.ts) computes the deterministic HIGH; if it is HIGH and
the pure-refactor detector proves behavior preservation for the changed source files,
downgrade the level to MEDIUM with a reason noting the mechanical proof + that full
review still applies. `deterministicRisk` stays untouched.

## Interface shapes
- `detectPureRefactor(files: FileContentDiff[]): { pure: boolean; reasons: string[] }`
- `FileContentDiff = { path: string; before: string; after: string }`
- `gatherFileDiffs(cwd, base, branch, changed): FileContentDiff[]` (thin git shell)