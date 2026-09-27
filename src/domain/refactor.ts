// Mechanical behavior-preservation detection for pure relocations. A change is a
// "pure refactor" if it can be proven from the diff's file contents alone not to
// change behavior: equal exported-name surface, unchanged registerTool name set,
// and every behavior line in the diff is a verbatim move (no net-new behavior).
//
// Conservative by construction: any uncertainty fails toward pure=false (stays
// HIGH for human review), so a lone behavior change is never auto-landed.
import { git } from "../shared/shell.ts";

export interface FileContentDiff {
  path: string;
  before: string; // file content at base
  after: string;  // file content at branch
}

export interface RefactorVerdict {
  pure: boolean;
  reasons: string[];
}

// ---------- pure string helpers ----------

function normalizeLine(l: string): string {
  // trim + collapse whitespace runs so line-wrapping / leading-space changes in a
  // relocation don't read as behavior differences.
  return l.replace(/[ \t]+/g, " ").trim();
}

// Structural boilerplate a relocation may legitimately add/remove asymmetrically
// (scaffolding, imports, export-declaration headers, braces, comments). Kept narrow:
// an unmatched line that isn't clearly structural keeps the change non-pure.
function isBoilerplate(norm: string): boolean {
  // ponytail: narrow-structural filter, exact behavior-line bag parity — ceiling: misses
  // pure relocations that also tweak type-only/comment/whitespace lines (they stay HIGH);
  // upgrade: token-level AST comparison if we want to accept those without risking a
  // false-pure auto-land.
  if (!norm) return true;
  if (norm.startsWith("//") || norm.startsWith("/*") || norm.startsWith("*")) return true;
  if (/^import\b/.test(norm)) return true;
  if (/^export\s+(async\s+)?function\s+\w+\s*\(/.test(norm)) return true;
  if (/^export\s+(const|let|var|class|enum|interface|type|namespace)\s+\w+/.test(norm)) return true;
  if (/^export\s+type\s*\{/.test(norm)) return true;
  if (/^export\s*\{/.test(norm)) return true;
  if (/from\s+["'][^"']+["'];?\s*$/.test(norm)) return true; // `... } from "x";`
  if (/^\{,?\}\s*$/.test(norm) || /^[{}]+\s*$/.test(norm)) return true;
  return false;
}

/** Multiset (bag) of non-boilerplate (behavior) lines in content. */
export function behaviorBag(content: string): Map<string, number> {
  const bag = new Map<string, number>();
  for (const raw of content.split("\n")) {
    const norm = normalizeLine(raw);
    if (isBoilerplate(norm)) continue;
    bag.set(norm, (bag.get(norm) || 0) + 1);
  }
  return bag;
}

function mergeBag(dst: Map<string, number>, src: Map<string, number>): void {
  for (const [k, v] of src) dst.set(k, (dst.get(k) || 0) + v);
}

function bagsEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

const EXPORT_PATTERNS: RegExp[] = [
  /export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g,
  /export\s+(?:default\s+)?(const|let|var|class|enum|namespace)\s+([A-Za-z0-9_$]+)/g,
  /export\s+(?:default\s+)?(interface|type)\s+([A-Za-z0-9_$]+)/g,
  /export\s+(?:default\s+)?([A-Za-z0-9_$]+)/g,
  /export\s*\*\s*from\s+["']([^"']+)["']/g,
];

/** Set of exported names (functions/consts/types + re-export lists + export * targets). */
export function exportedSurface(content: string): Set<string> {
  const s = new Set<string>();
  for (const re of EXPORT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content))) {
      const name = m[m.length - 1];
      if (name) s.add(name);
    }
  }
  // re-export object lists: `export { A, B as C } from "…"`
  const block = /export\s+(?:type\s+)?\{([^}]*)\}/g;
  block.lastIndex = 0;
  let b;
  while ((b = block.exec(content))) {
    const list = b[1];
    const id = /([A-Za-z0-9_$]+)\s*(?::\s*["'][^"']+["'])?/g; // value or 'x' as y
    let t;
    while ((t = id.exec(list))) {
      const n = t[1].split(/\s+/).pop()!;
      if (n && n !== "as" && n !== "type") s.add(n);
    }
  }
  return s;
}

/** Set of tool-registration names in content (first `name:` within a registerTool call). */
export function registerToolNames(content: string): Set<string> {
  const s = new Set<string>();
  const re = /registerTool\b[\s\S]{0,400}?name:\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(content))) s.add(m[1]);
  return s;
}

// ---------- decision (pure) ----------

/** Prove (or not) that a set of file-content diffs is a behavior-preserving relocation. */
export function detectPureRefactor(files: FileContentDiff[]): RefactorVerdict {
  const reasons: string[] = [];

  // 1. Export-surface parity (union across all touched files).
  const beforeExports = new Set<string>();
  const afterExports = new Set<string>();
  for (const f of files) {
    for (const n of exportedSurface(f.before)) beforeExports.add(n);
    for (const n of exportedSurface(f.after)) afterExports.add(n);
  }
  if (!setsEqual(beforeExports, afterExports)) {
    reasons.push(`export surface changed (${[...beforeExports].sort().join(",")} -> ${[...afterExports].sort().join(",")})`);
  }

  // 2. registerTool-name parity (union across all touched files).
  const beforeTools = new Set<string>();
  const afterTools = new Set<string>();
  for (const f of files) {
    for (const n of registerToolNames(f.before)) beforeTools.add(n);
    for (const n of registerToolNames(f.after)) afterTools.add(n);
  }
  if (!setsEqual(beforeTools, afterTools)) {
    reasons.push(`registerTool name set changed (${[...beforeTools].sort().join(",")} -> ${[...afterTools].sort().join(",")})`);
  }

  // 3. No behavior-only hunks: every behavior line present in the diff must be a
  // verbatim move (appears equally in the added and removed multisets).
  const beforeBag = new Map<string, number>();
  const afterBag = new Map<string, number>();
  for (const f of files) {
    mergeBag(beforeBag, behaviorBag(f.before));
    mergeBag(afterBag, behaviorBag(f.after));
  }
  if (!bagsEqual(beforeBag, afterBag)) {
    reasons.push("behavior lines not purely relocated (net-new or modified executable statements)");
  }

  return { pure: reasons.length === 0, reasons };
}

// ---------- execution layer (sources file contents from git) ----------

function isSourceFile(p: string): boolean {
  return /\.[tj]sx?$/.test(p);
}

/** Fetch before/after content for each changed source file from git. */
export function gatherFileDiffs(
  cwd: string,
  base: string,
  branch: string,
  changed: string[],
): FileContentDiff[] {
  const diffs: FileContentDiff[] = [];
  for (const p of changed) {
    if (!isSourceFile(p)) continue;
    const before = git(cwd, "show", `${base}:${p}`) ?? "";
    const after = git(cwd, "show", `${branch}:${p}`) ?? "";
    diffs.push({ path: p, before, after });
  }
  return diffs;
}