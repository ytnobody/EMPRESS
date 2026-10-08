// Install-in-sync gate (Task #81): the runtime copies `empress init` installs
// (`.empress/agents`, `.pi/prompts`) must stay byte-identical to their bundled
// sources (`src/agents`, `src/prompts`). A stale installed prompt silently runs
// outdated instructions (e.g. task-34 output-language, task-37 dedupe text), so
// this deterministic check surfaces drift in `empress doctor` and selfcheck.
import * as fs from "node:fs";
import * as path from "node:path";

export interface InstallPair {
  label: string;
  src: string;
  dest: string;
}

/**
 * Pure comparison of a source dir's files against the installed copies.
 * Reports a `stale` file when the installed bytes differ and a `missing` file
 * when the installed counterpart is absent. In sync -> [].
 */
export function compareInstall(
  src: Map<string, Buffer>,
  installed: Map<string, Buffer>,
  label: string
): string[] {
  const drift: string[] = [];
  for (const [name, bytes] of src) {
    const got = installed.get(name);
    if (!got) drift.push(`${label}: missing installed "${name}"`);
    else if (!got.equals(bytes)) drift.push(`${label}: stale installed "${name}"`);
  }
  return drift;
}

/** Regular files in a dir, name -> bytes (a missing dir is simply empty). */
function readDirFiles(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile()) out.set(e.name, fs.readFileSync(path.join(dir, e.name)));
  }
  return out;
}

/** Thin shell: compare every file the installer copies against its installed copy. */
export function installDrift(pairs: InstallPair[]): string[] {
  const drift: string[] = [];
  for (const p of pairs) {
    drift.push(...compareInstall(readDirFiles(p.src), readDirFiles(p.dest), p.label));
  }
  return drift;
}

/** Human-readable drift summary (empty string = clean). */
export function installReport(drift: string[]): string {
  if (!drift.length) return "";
  return `Installed runtime prompts are stale vs src: ${drift.join("; ")}. Run \`empress init\` (or copy src/agents, src/prompts) to resync.`;
}
