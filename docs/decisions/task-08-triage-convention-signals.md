# Design — triage conventionSignals from diffBetween changed list

## Behavior spec
`runTriage(cwd, config, task, opts)` must compute convention signals from the
**authoritative changed-file list** returned by `git diff --numstat` (via
`diffBetween(...).changed`), not from fragile `--stat` header parsing.

- `conv = conventionSignals(_diffBetween(cwd, base, branch).changed)`.
- The deterministic secret/dangerous scan and the Jev state still use the raw
  patch text (`_diffPatch`) — unchanged behavior.
- `extractChangedPaths` (--stat header parser) is removed.

## Interface change
- `runTriage` opts gains injectable `_diffBetween` (defaults to `diffBetween` from git.js).
- `_diffPatch` remains for the Jev/patch path.

## Verification arithmetic
Test that `runTriage` with injected `_diffBetween` returning a `{changed:[...]}`
list computes `conv` from that list (code-without-tests), independent of the
`--stat` header shape in the patch text.