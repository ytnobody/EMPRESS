# Task 10 — Type src/shared/* (shell.ts, frontmatter.ts, config.ts)

Pure typing task: add TS annotations to the three shared-layer modules so
`bunx tsc --noEmit` reports **zero** errors in them. No behavior changes, no new
deps, no edits outside src/shared, no new exports.

## Interface map (the shapes that verification is derived from)

### shell.ts
```ts
interface RunOpts { cwd?: string; env?: Record<string,string|undefined>; timeout?: number }
interface RunResult { code: number; stdout: string; stderr: string; signal: string | null }
run(cmd: string, args: string[], opts?: RunOpts): RunResult        // never throws
ok(cmd: string, args: string[], opts?: RunOpts): boolean           // run(...).code === 0
git(cwd: string, ...args: string[]): string | null                 // null on failure
stderrOf(res?: RunResult | null): string                           // nullable-safe trim
runSyncString(cmd: string, args: string[], opts?: RunOpts): string // trimmed, throws
```

### frontmatter.ts
```ts
parseFrontmatterBlock(raw: string): Record<string, unknown>
serializeScalar(value: unknown): string
parseMdFile(text: string): { frontmatter: Record<string, unknown>; body: string }
serializeMdFile(frontmatter: Record<string, unknown>, body: string): string
readMd(path: string): { frontmatter: Record<string, unknown>; body: string }
writeMd(path: string, frontmatter: Record<string, unknown>, body: string): void
```
Internal `findColon(s: string): number`; `coerce(value: string): unknown` (recursive
coercion — needs explicit `unknown` annotation so TS7023 resolves).

### config.ts
```ts
parseToml(text: string): Record<string, unknown>          // nested sections
loadTomlFile(p: string): Record<string, unknown>
mergeConfig(base: Record<string,unknown>, over: Record<string,unknown>): Record<string,unknown>
resolveProjectRoot(start?: string): string
loadConfig(cwd?: string): Config & { file: string | null; cwd: string }
```
`Config = DEFAULTS` shape (typed literal from `DEFAULTS`).

All `[ASSUMPTION]`: none — pure typing, behavior-preserving. The only risky
`unknown` is in `parseToml`/`mergeConfig`/`coerce` internals, externalized only
through `Record<string, unknown>`, which is as permissive as the current implicit
`any` for consumers (all consumers are already-erroring `src/domain|cli|extension`
files being fixed by other tasks).