# Design: drop doomed origin-merge in `git.landBranch`

## Behavior spec

- `landBranch(cwd, base, branch)` updates base from origin **before** fast-forwarding.
- In local-only repos there is no `refs/remotes/origin/<base>`, so a
  `git merge --ff-only origin/<base>` is doomed (noise + confusion). It must not run.
- When `refs/remotes/origin/<base>` **does** exist, the origin update should still run
  (guarded), so landing keeps pulling origin in the remote case.
- Local fast-forward into base (`git merge --no-edit --ff-only branch`) is unchanged.

## Interface spec (command verification)

Pure decision: given a boolean "does refs/remotes/origin/<base> exist", decide the
update Command to emit.

- `originUpdateCommand(base, originBaseExists)`:
  - `originBaseExists === false` → return `null` (no doomed command).
  - `originBaseExists === true` → return `{ cmd: "git", args: ["merge", "--ff-only", "origin/" + base] }`.

Execution shell (`landBranch`) stays thin: detect existence via
`git -C cwd show-ref --verify --quiet refs/remotes/origin/<base>`, and if the Command
is non-null run `cmd` with `-C cwd` prepended to `args`.