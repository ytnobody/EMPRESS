// empress.toml loader + defaults. Dependency-free TOML-subset parser (no nested
// tables beyond `[section]`, no arrays-of-tables). Mirrors HARness's harness.toml
// but without any GitHub section.
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatterBlock } from "./frontmatter.js";

export const CONFIG_FILENAME = "empress.toml";
export const EMPRESS_DIR = ".empress";

export const DEFAULTS = {
  project: {
    base_branch: "main",
    test_command: "",
    language: "en",
  },
  agent: {
    max_engineers: 4,
    loop_interval: 120,
    branch_prefix: "empress/task",
  },
  risk: {
    use_jev: true,
    high_paths: ["cmd/", "go.mod", ".github/", "src/extension/", "src/risk/", "empress.toml", "CLAUDE.md"],
    medium_paths: ["internal/", "src/"],
    high_file_threshold: 20,
    high_line_threshold: 500,
    medium_file_threshold: 10,
    medium_line_threshold: 200,
    require_human_approval: false,
  },
  readiness: {
    use_jev: true,
    min_body_length: 40,
    skip_acceptance_criteria_check: false,
  },
  jev: {
    command: "chariot",
    model: "jev-latest",
  },
  notification: {
    webhook_url: "",
    type: "",
  },
  run: {
    failure_notify_threshold: 3,
  },
};

/** Parse a small TOML-ish document: `key = value` or `key: value`, `[section]` tables, `#` comments. */
export function parseToml(text) {
  const root = {};
  let section = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1).trim();
      section = root[name] || (root[name] = {});
      continue;
    }
    const idx = line.indexOf("=");
    const key = (idx >= 0 ? line.slice(0, idx) : line).trim();
    const value = idx >= 0 ? line.slice(idx + 1).trim() : line;
    section[key] = parseFrontmatterBlock(`${key}: ${value}`)[key];
  }
  return root;
}

export function loadTomlFile(p) {
  if (!fs.existsSync(p)) return {};
  return parseToml(fs.readFileSync(p, "utf-8"));
}

/** Deep-merge nested config over defaults. */
export function mergeConfig(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object") {
      out[k] = mergeConfig(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Load config for a project. Looks up `.empress/empress.toml` then `empress.toml`
 * in the given (or current) directory. Returns full merged config with defaults.
 */
export function loadConfig(cwd = process.cwd()) {
  let file = "";
  for (const candidate of [
    path.join(cwd, EMPRESS_DIR, CONFIG_FILENAME),
    path.join(cwd, CONFIG_FILENAME),
  ]) {
    if (fs.existsSync(candidate)) {
      file = candidate;
      break;
    }
  }
  if (!file) return { ...structuredClone(DEFAULTS), file: null, cwd };
  return { ...mergeConfig(structuredClone(DEFAULTS), loadTomlFile(file)), file, cwd };
}