// `empress init`: scaffold a project with config, .empress store, role prompts,
// and .pi wiring. Non-interactive when all needed options are provided via CLI.
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { CONFIG_FILENAME, EMPRESS_DIR } from "../shared/config.js";
import { writeLoopState as persistState } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_SRC = path.resolve(__dirname, "..", "agents");
const PROMPTS_SRC = path.resolve(__dirname, "..", "prompts");

function prompt(question, def) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question}${def ? ` [${def}]` : ""}: `, (ans) => {
      rl.close();
      resolve(ans.trim() || def || "");
    });
  });
}

const DEFAULT_TOML = (o) => `# EMPRESS project config. Shared with the team.
# No GitHub, no Claude Code. Everything runs on local git + local task files.

[project]
base_branch = "${o.base_branch}"
test_command = "${o.test_command}"
language = "${o.language}"

[agent]
max_engineers = ${o.max_engineers}
loop_interval = ${o.loop_interval}
branch_prefix = "empress/task"

# Jev (System One) drives judgments natively via HTTPS (TYPESAFE_API_KEY).
# If the key is unset, EMPRESS falls back to deterministic rules.
[jev]
model = "jev-latest"

[risk]
use_jev = true
high_file_threshold = 20
high_line_threshold = 500
medium_file_threshold = 10
medium_line_threshold = 200
high_paths = ["cmd/", "go.mod", "src/", "empress.toml", "CLAUDE.md"]
medium_paths = ["internal/", "lib/"]

[readiness]
use_jev = true
min_body_length = 40

# [notification]
# webhook_url = "https://hooks.example.com/..."
# type = "generic"   # slack | discord | generic (auto-detected from URL if omitted)

[run]
failure_notify_threshold = 3
`;

function copyAgents(root) {
  const dest = path.join(root, EMPRESS_DIR, "agents");
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(AGENTS_SRC)) {
    const src = path.join(AGENTS_SRC, f);
    if (!fs.statSync(src).isFile()) continue;
    fs.copyFileSync(src, path.join(dest, f));
  }
  return dest;
}

function wirePrompts(root) {
  // Project-scoped /empress prompt template pointing at the per-project role prompt.
  const dir = path.join(root, ".pi", "prompts");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(
    path.join(PROMPTS_SRC, "empress.md"),
    path.join(dir, "empress.md")
  );
  // Placeholder: real prompt template is authored in src/prompts; ensure exists
  if (!fs.existsSync(path.join(dir, "empress.md"))) {
    fs.writeFileSync(
      path.join(dir, "empress.md"),
      "---\ndescription: Run one EMPRESS Superintendent cycle now\n---\nYou are the EMPRESS Superintendent. Run one full cycle now using the empress_* tools.\n"
    );
  }
}

export async function initProject(cwd, opts = {}) {
  const dest = cwd;
  fs.mkdirSync(path.join(dest, EMPRESS_DIR, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(dest, EMPRESS_DIR, "worktrees"), { recursive: true });

  // interactive fill for missing options (only when stdin is a TTY)
  const interactive = Boolean(process.stdin.isTTY);
  if (!opts.base_branch) opts.base_branch = interactive ? await prompt("Base branch for landing work", "main") : "main";
  if (!opts.test_command) opts.test_command = interactive ? await prompt("Test command (e.g. `go test ./...` or `npm test`)", "") : "";
  if (opts.max_engineers == null) opts.max_engineers = interactive ? Number(await prompt("Max parallel Engineers", "4")) || 4 : 4;
  if (!opts.loop_interval) opts.loop_interval = interactive ? Number(await prompt("Loop interval (seconds)", "120")) || 120 : 120;
  if (!opts.language) opts.language = interactive ? (await prompt("Language for agent instructions (en|ja)", "en")).slice(0, 2) : "en";

  const toml = opts.toml || DEFAULT_TOML({
    base_branch: opts.base_branch,
    test_command: opts.test_command,
    max_engineers: opts.max_engineers,
    loop_interval: opts.loop_interval,
    language: opts.language,
  });

  // Put config inside .empress/ (also check a root-level empress.toml).
  if (!opts.noConfigFile) {
    fs.writeFileSync(path.join(dest, EMPRESS_DIR, CONFIG_FILENAME), toml);
  }

  copyAgents(dest);
  wirePrompts(dest);

  fs.writeFileSync(path.join(dest, EMPRESS_DIR, ".gitignore"), "worktrees/\nsuperintendent-state.json\n");
  persistState(dest, {
    status: "running",
    pr_comments_since: null,
    task_comments_since: null,
    last_pass_at: null,
    consecutive_failures: 0,
    last_success_tick: null,
  });

  return {
    config: path.join(dest, EMPRESS_DIR, CONFIG_FILENAME),
    agentsDir: path.join(dest, EMPRESS_DIR, "agents"),
    tasksDir: path.join(dest, EMPRESS_DIR, "tasks"),
  };
}