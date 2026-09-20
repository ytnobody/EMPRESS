// Ponytail debt harness: greps the repo for `ponytail:` markers and reports them
// as a ledger, flagging markers that name no upgrade path (they rot silently).
// Mirrors the ponytail-debt skill's each-hit-one-row output.
import * as fs from "node:fs";
import * as path from "node:path";
import { EMPRESS_DIR } from "../shared/config.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".cache", EMPRESS_DIR]);
const MARKER = /(?:#|\/\/)\s?ponytail:\s*(.*)$/i;
const TRIGGER_WORDS = ["if ", "when ", "until ", "once ", "if/", "upgrade", "revisit", "later", "@"];

function walk(dir, out, relBase) {
  let entries;
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
        let text = fs.readFileSync(full, "utf-8");
        text.split(/\r?\n/).forEach((line, idx) => {
          const m = MARKER.exec(line);
          if (!m) return;
          const body = (m[1] || "").trim();
          const [ceiling, ...rest] = body.split(/[,;]/).map((s) => s.trim());
          const upgrade = rest.join("; ");
          const noTrigger = !TRIGGER_WORDS.some((w) => /(if|when|until|once|if\/|upgrade|revisit|later)/i.test(body))
            || !upgrade;
          out.push({
            file: rel,
            line: idx + 1,
            ceiling: ceiling || "(unspecified)",
            upgrade: upgrade || "(none)",
            noTrigger,
            raw: `${rel}:${idx + 1}, ${body || "ponytail marker"}. ceiling: ${ceiling || "?"}${upgrade ? `. upgrade: ${upgrade}` : ""}${noTrigger ? "  [no-trigger]" : ""}`,
          });
        });
      } catch {
        /* unreadable file */
      }
    }
  }
}

/** Collect ponytail markers. Returns { rows, markers, noTrigger }. */
export function collectPonytailDebt(cwd) {
  const rows = [];
  walk(cwd, rows, ".");
  rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const grouped = groupBy(rows, (r) => r.file);
  const lines = [];
  for (const [file, fileRows] of grouped) {
    lines.push(`## ${file}`);
    for (const r of fileRows) lines.push(r.raw);
  }
  return { rows, lines, markers: rows.length, noTrigger: rows.filter((r) => r.noTrigger).length };
}

function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) {
    const k = fn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}