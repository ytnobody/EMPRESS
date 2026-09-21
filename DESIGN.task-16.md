# Design — empress_vuln_check: detect bun.lock so dep-CVE scan is not a silent no-op

## Behavior spec

`detectStack` must recognize a bun-managed project (marker: `package.json` +
`bun.lock`) as a dedicated `"bun"` stack, so `empress_vuln_check` runs a real
scan instead of returning `no supported dependency stack detected`.

`bun audit --json` (bun 1.4.2, verified live today: this repo reports
`No vulnerabilities found (checked 162 packages)`):
- clean → stdout `{}`, exit 0
- vulnerable → stdout `{ "<pkg>": [ { id, url, title, severity,
  vulnerable_versions, cwe, cvss }, ... ] }`, exit 1
- no `--omit=dev`; JSON shape differs from npm's `{vulnerabilities:{...}}`
  (npm audit field names/`parseNpmAudit` do NOT match → dedicated parser)

- `parseBunAudit(text) -> Finding[]`: flatten `{pkg -> advisories[]}` into one
  Finding per advisory (`name`, `severity`, `range`=vulnerable_versions, `url`,
  `title`), sorted by severity desc (`SEVERITY_RANK`). `{}`, malformed JSON, or
  non-object data → `[]` (clean scan must not crash or invent findings).
- exit code 1 on findings is **not** an error: findings are parsed and reported
  (same policy as the existing npm branch).

## Interface change

- `Stack` gains `"bun"`: `type Stack = "go" | "npm" | "pip" | "bun"`.
- `detectStack(root)`: `package.json && bun.lock` → `"bun"` (checked before the
  npm-lock check; bun wins when both a bun.lock and an npm lockfile exist —
  bun.lock signals bun-managed).
- `buildVulnCommand("bun")` → `{ bin: "bun", args: ["audit", "--json"] }`.
- new pure `parseBunAudit(text: string): Finding[]`.
- `runVulnCheck`: dispatch `detected === "bun"` → `parseBunAudit(res.stdout)`.
  Probe `bun --version` already flows through the existing availability check.

## Verification arithmetic

- Stack: `tmpdir(package.json + bun.lock)` → `"bun"`; npm locks still → `"npm"`.
- Command: `buildVulnCommand("bun")` deep-equals `{ bin: "bun", args: ["audit", "--json"] }`.
- Parse: `{}` (observed clean output) → `[]`; hand-shaped vulnerable JSON
  (fields as observed from real `bun audit --json`, values chosen by hand) →
  findings with expected name/severity/range/url/title, sorted severity desc.
- Run: injected `_run` on a bun.lock dir → second call is
  `["bun", ["audit", "--json"]]`; clean stdout `{}` → `ok:true, stack:"bun",
  findings:[]`; vulnerable stdout → findings parsed (passing + failing audit).