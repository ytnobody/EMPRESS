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
 * Resolve the EMPRESS project root by walking up from `start` looking for
 * `.empress/empress.toml` or `empress.toml`. This lets tools called from inside
 * a git worktree (`.empress/worktrees/N`) find the main repo's task store + config
 * instead of a worktree-local one.
 */
export function resolveProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, EMPRESS_DIR, CONFIG_FILENAME))) {
      return dir; // dir/.empress/empress.toml — this is the project root
    }
    // Bare empress.toml is also a root marker, but never the .empress data dir
    // itself (it would self-match its own empress.toml and stop one level early).
    if (path.basename(dir) !== EMPRESS_DIR && fs.existsSync(path.join(dir, CONFIG_FILENAME))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/**
 * Load config for a project. Resolves the project root (walking up to the
 * nearest `.empress/empress.toml` / `empress.toml`) so worktree-invoked tools
 * share the main config. Returns full merged config with defaults.
 */
export function loadConfig(cwd = process.cwd()) {
  const root = resolveProjectRoot(cwd);
  let file = "";
  for (const candidate of [
    path.join(root, EMPRESS_DIR, CONFIG_FILENAME),
    path.join(root, CONFIG_FILENAME),
  ]) {
    if (fs.existsSync(candidate)) {
      file = candidate;
      break;
    }
  }
  if (!file) return { ...structuredClone(DEFAULTS), file: null, cwd: root };
  return { ...mergeConfig(structuredClone(DEFAULTS), loadTomlFile(file)), file, cwd: root };
}