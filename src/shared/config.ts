// empress.toml loader + defaults. Dependency-free TOML-subset parser (no nested
// tables beyond `[section]`, no arrays-of-tables). Mirrors HARness's harness.toml
// but without any GitHub section.
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatterBlock } from "./frontmatter.ts";

export const CONFIG_FILENAME = "empress.toml";
export const EMPRESS_DIR = ".empress";

export interface Config {
  project: { base_branch: string; test_command: string; language: string };
  agent: { max_engineers: number; loop_interval: number; branch_prefix: string };
  // Per-role model overrides. Empty string = use pi's default model (no --model).
  models: { superintendent: string; engineer: string };
  // GitHub integration via the gh CLI. Strictly opt-in: unless enabled=true,
  // EMPRESS never touches gh or any git remote (local-only by default).
  github: { enabled: boolean; owner: string; repo: string };
  risk: {
    use_jev: boolean;
    high_paths: string[];
    medium_paths: string[];
    high_file_threshold: number;
    high_line_threshold: number;
    medium_file_threshold: number;
    medium_line_threshold: number;
    require_human_approval: boolean;
  };
  readiness: { use_jev: boolean; min_body_length: number; skip_acceptance_criteria_check: boolean };
  jev: { model: string };
  ci: { engine: string; image: string; network: string };
  notification: { webhook_url: string; type: string };
  run: { failure_notify_threshold: number; wake_interval: number; audit_interval: number };
}

export const DEFAULTS: Config = {
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
  // Empty = pi's default model. Set e.g. superintendent = "anthropic/claude-sonnet-4-5"
  // or a provider/id pattern pi resolves; the CLI --model flag (empress run) wins
  // over the config value for the Superintendent.
  models: {
    superintendent: "",
    engineer: "",
  },
  // Disabled by default: github integration (gh) never runs unless enabled = true.
  github: {
    enabled: false,
    owner: "",
    repo: "",
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
    model: "jev-latest",
  },
  ci: {
    engine: "host",
    image: "",
    network: "default",
  },
  notification: {
    webhook_url: "",
    type: "",
  },
  run: {
    failure_notify_threshold: 3,
    wake_interval: 60,     // fs-poll cadence (seconds); zero-LLM — event detection only
    audit_interval: 3600,  // idle self-audit LLM cadence (seconds); 0 = disabled
  },
};

/** Parse a small TOML-ish document: `key = value` or `key: value`, `[section]` tables, `#` comments. */
export function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let section: Record<string, unknown> = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1).trim();
      if (typeof root[name] !== "object" || root[name] === null) {
        root[name] = {};
      }
      section = root[name] as Record<string, unknown>;
      continue;
    }
    const idx = line.indexOf("=");
    const key = (idx >= 0 ? line.slice(0, idx) : line).trim();
    const value = idx >= 0 ? line.slice(idx + 1).trim() : line;
    section[key] = parseFrontmatterBlock(`${key}: ${value}`)[key];
  }
  return root;
}

export function loadTomlFile(p: string): Record<string, unknown> {
  if (!fs.existsSync(p)) return {};
  return parseToml(fs.readFileSync(p, "utf-8"));
}

/** Deep-merge nested config over defaults. */
export function mergeConfig<T extends object>(base: T, over: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over || {})) {
    const bk = (base as Record<string, unknown>)[k];
    if (v && typeof v === "object" && !Array.isArray(v) && bk && typeof bk === "object" && !Array.isArray(bk)) {
      out[k] = mergeConfig(bk as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * Resolve the EMPRESS project root by walking up from `start` looking for
 * `.empress/empress.toml` or `empress.toml`. This lets tools called from inside
 * a git worktree (`.empress/worktrees/N`) find the main repo's task store + config
 * instead of a worktree-local one.
 */
export function resolveProjectRoot(start: string = process.cwd()): string {
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

export type LoadedConfig = Config & { file: string | null; cwd: string };

/**
 * Load config for a project. Resolves the project root (walking up to the
 * nearest `.empress/empress.toml` / `empress.toml`) so worktree-invoked tools
 * share the main config. Returns full merged config with defaults.
 */
export function loadConfig(cwd: string = process.cwd()): LoadedConfig {
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