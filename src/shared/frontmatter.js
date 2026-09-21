// Minimal YAML-like frontmatter parsing for task files and empress.toml.
// Deliberately dependency-free. Handles the subset we emit/consume.
import * as fs from "node:fs";

/**
 * Parse a compact block of `key: value` frontmatter into a plain object.
 * Supports strings (bare or quoted), numbers, booleans, null, and simple
 * arrays (`[a, b]` / `["a", "b"]`), plus nested one-line `key: { ... }`.
 * Sections / long-form YAML are NOT supported — keep values on one line.
 */
export function parseFrontmatterBlock(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = findColon(trimmed);
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    out[key] = coerce(value);
  }
  return out;
}

function findColon(s) {
  let inStr = false;
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === quote) inStr = false;
    } else if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
    } else if (c === ":") {
      return i;
    }
  }
  return -1;
}

function coerce(value) {
  // JSON-parseable (objects or arrays) parse as-is — needed for comment objects.
  const t = value.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      /* fall through to the scalar path below */
    }
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    // split on commas not inside quotes
    const items = [];
    let cur = "";
    let inStr = false;
    let quote = "";
    for (const c of inner) {
      if (inStr) {
        cur += c;
        if (c === quote) inStr = false;
      } else if (c === '"' || c === "'") {
        inStr = true;
        quote = c;
        cur += c;
      } else if (c === ",") {
        items.push(cur.trim());
        cur = "";
      } else {
        cur += c;
      }
    }
    if (cur.trim()) items.push(cur.trim());
    return items.map((it) => coerce(String(it).replace(/^["']|["']$/g, "") || ""));
  }
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value === "~") return null;
  if (value !== "" && !Number.isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/** Serialize a value to the compact frontmatter subset. */
export function serializeScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return JSON.stringify(String(value));
}

/**
 * Parse a full markdown file that begins with `---\n...\n---`.
 * Returns { frontmatter, body }. If no frontmatter, returns {} and full text.
 */
export function parseMdFile(text) {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { frontmatter: {}, body: text };
  }
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: {}, body: text };
  const fm = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  return { frontmatter: parseFrontmatterBlock(fm), body };
}

export function serializeMdFile(frontmatter, body) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) {
    lines.push(`${k}: ${serializeScalar(v)}`);
  }
  lines.push("---", "", body.replace(/^\s*\n?/, ""));
  return lines.join("\n");
}

/** Read + parse a markdown file with frontmatter. Throws if missing. */
export function readMd(path) {
  const text = fs.readFileSync(path, "utf-8");
  return parseMdFile(text);
}

export function writeMd(path, frontmatter, body) {
  fs.writeFileSync(path, serializeMdFile(frontmatter, body));
}