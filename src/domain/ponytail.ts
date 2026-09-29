// Ponytail debt harness: greps the repo for `ponytail:` markers and reports them
// as a ledger, flagging markers that name no upgrade path (they rot silently).
// Mirrors the ponytail-debt skill's each-hit-one-row output.
import * as fs from "node:fs";
import * as path from "node:path";
import { EMPRESS_DIR } from "../shared/config.ts";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".cache", EMPRESS_DIR]);
const MARKER = /(?:#|\/\/)\s?ponytail:\s*(.*)$/i;
const CONT_LINE = /^\s*(?:\/\/|#)\s*/; // a following comment line may be a wrapped continuation
const TRIGGER_RE = /(if|when|until|once|if\/|upgrade|revisit|later)/i;
const UPGRADE_PREFIX = /^upgrade\s*(?:path)?\s*:/i; // explicit upgrade paragraph opener
const UPGRADE_KEYWORD = /upgrade\s*(?:path)?\s*:/i; // search anywhere in a joined body

export interface PonytailRow {
  file: string;
  line: number;
  ceiling: string;
  upgrade: string;
  noTrigger: boolean;
  raw: string;
}

function walk(dir: string, out: PonytailRow[], relBase: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = path.join(relBase, e.name);
    if (e.isDirectory()) walk(full, out, rel);
    else if (e.isFile()) {
      const ext = path.extname(e.name);
      if (!/\.(js|ts|jsx|tsx|py|go|rb|rs|java|cs|c|cpp|sh|pl|php|swift)$/.test(ext)) continue;
      try {
        const lines = fs.readFileSync(full, "utf-8").split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const m = MARKER.exec(lines[i]);
          if (!m) continue;
          const markerLine = i; // row reports the marker's first line
          // Join wrapped continuation comment lines (marker text spilled onto the
          // next comment line). Stop after a non-upgrade paragraph so a following
          // standalone comment is not swallowed; resume joining for an explicit
          // "upgrade:"/"upgrade path:" paragraph that opens AFTER the marker
          // sentence's terminal '.'. Stop at a new ponytail: marker.
          const cont: string[] = [];
          let sentenceEnded = /[.!?]$/.test(m[1].trim()); // marker's own sentence may already have ended
          let upgradePara = false;   // inside an explicitly prefixed upgrade paragraph
          for (let j = i + 1; j < lines.length; j++) {
            const c = CONT_LINE.exec(lines[j]);
            if (!c) break;
            const t = lines[j].slice(c[0].length).trim();
            if (/^ponytail:/i.test(t)) break;
            if (sentenceEnded && !upgradePara) {
              if (!UPGRADE_PREFIX.test(t)) break; // non-upgrade standalone note -> stop
              upgradePara = true; // explicit upgrade paragraph opens across the break
            }
            cont.push(t);
            if (/[.!?]$/.test(t)) sentenceEnded = true;
            i = j; // continuation consumed; skip it in the outer scan
          }
          const body = [m[1].trim(), ...cont].join(" ").trim();
          // Split ceiling/upgrade. An explicit "upgrade:"/"upgrade path:" keyword
          // wins over the comma-split: a comma inside the ceiling must not shadow
          // it (refactor.ts:33). Otherwise split at the first comma that is NOT
          // inside parentheses — a comma within a parenthetical is part of the
          // ceiling (ci.ts:100's "(3 ups, matches createWorktree)").
          let ceiling = body.trim();
          let upgrade = "";
          const upIdx = body.search(UPGRADE_KEYWORD);
          if (upIdx >= 0) {
            ceiling = body.slice(0, upIdx).trim().replace(/,\s*$/, "");
            upgrade = body.slice(upIdx).trim();
          } else {
            let depth = 0;
            for (let i = 0; i < body.length; i++) {
              const ch = body[i];
              if (ch === "(") depth++;
              else if (ch === ")") depth--;
              else if (ch === "," && depth === 0) {
                ceiling = body.slice(0, i).trim();
                upgrade = body.slice(i + 1).trim();
                break;
              }
            }
          }
          const noTrigger = !TRIGGER_RE.test(body) || !upgrade;
          // raw render: do NOT embed the full joined body AND re-append the split
          // fields (issue #78) — that duplicated the ceiling/upgrade text for
          // continuation-upgrade markers. Render each labeled field exactly once:
          // "file:line, ceiling: X. upgrade: Y". The keyword-split upgrade field
          // already carries its own "upgrade:"/"upgrade path:" prefix (joined from a
          // continuation line), so strip it here to yield a single "upgrade:" label
          // prefix — never "upgrade: upgrade:".
          const upgradeText =
            upgrade && upgrade !== "(none)" ? upgrade.replace(UPGRADE_PREFIX, "").trim() : upgrade;
          out.push({
            file: rel,
            line: markerLine + 1,
            ceiling: ceiling || "(unspecified)",
            upgrade: upgrade || "(none)",
            noTrigger,
            raw: `${rel}:${markerLine + 1}, ceiling: ${ceiling || "?"}${upgrade ? `. upgrade: ${upgradeText}` : ""}${noTrigger ? "  [no-trigger]" : ""}`,
          });
        }
      } catch {
        /* unreadable file */
      }
    }
  }
}

/** Collect ponytail markers. Returns { rows, markers, noTrigger }. */
export function collectPonytailDebt(cwd: string): { rows: PonytailRow[]; lines: string[]; markers: number; noTrigger: number } {
  const rows: PonytailRow[] = [];
  walk(cwd, rows, ".");
  rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const grouped = groupBy(rows, (r) => r.file);
  const lines: string[] = [];
  for (const [file, fileRows] of grouped) {
    lines.push(`## ${file}`);
    for (const r of fileRows) lines.push(r.raw);
  }
  return { rows, lines, markers: rows.length, noTrigger: rows.filter((r) => r.noTrigger).length };
}

function groupBy<T>(arr: T[], fn: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of arr) {
    const k = fn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
}