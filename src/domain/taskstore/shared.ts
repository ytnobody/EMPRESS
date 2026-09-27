// Shared task-store types + backend-agnostic "spec helpers" (markdown body,
// language detection, proposal drafting, human-reply detection, task brief).
// Purely functional: no fs, shell, or gh-execution here — the local and gh
// backends live in local.ts / gh.ts and consume these.
import type { run } from "../../shared/shell.ts";

export const TASK_STATUSES: string[] = ["open", "assigned", "in-progress", "done", "blocked"];

export interface TaskComment {
  at: string;
  author: string;
  body: string;
}

export interface Task {
  id: number;
  file: string;
  title: string;
  status: string;
  assignee: string;
  labels: string[];
  needs_clarification: boolean;
  branch: string;
  pr: string;
  created: string;
  comments: TaskComment[];
  body: string;
  /** gh-backed tasks carry the resolved `owner/repo`; undefined for local tasks. */
  repo?: string;
}

export interface TaskInput {
  title: string;
  purpose?: string;
  scope?: string;
  acceptance?: string[];
  nongoals?: string[];
  labels?: string[];
}

export interface TaskListOpts {
  includeAll?: boolean;
}

export interface TaskStore {
  create(input: TaskInput): Task;
  list(opts?: TaskListOpts): Task[];
  get(id: number): Task | null;
  update(id: number, patch: Partial<Task>, newBody?: string): Task | null;
  addComment(id: number, author: string, body: string): Task | null;
  close(id: number, note?: string): Task | null;
  remove(id: number): boolean;
}

/** Dependencies that may be overridden in tests (fake runner / fake gh availability). */
export interface StoreDeps {
  run?: typeof run;
  ghAvailable?: () => boolean;
}

/**
 * Build the human markdown body for a task (Purpose / Scope / Acceptance / Non-Goals).
 * Purpose and Scope are always filled: when the caller omits them, they are derived
 * from the title (and acceptance) so an auto-filed task never reads as a bare
 * "_to be filled_" placeholders — that placeholder was the root cause of the
 * readiness/gate flagging idle-audit tasks as needs_clarification (Jev sees an
 * unreadable spec). If a task genuinely needs human specification, the Jev noul
 * can still flag it; but a coherent stub is a much better default to start from.
 */
export function buildMarkdown(input: TaskInput): string {
  const title = input.title && input.title.trim() ? input.title.trim() : "Untitled task";
  const ac = input.acceptance && input.acceptance.filter((a) => a && a.trim()).map((a) => a.trim());
  const purpose =
    input.purpose && input.purpose.trim()
      ? input.purpose.trim()
      : `The harness should address: \"${title}\"${
          ac && ac.length ? ` so the acceptance criteria below are met` : ""
        }.`;
  const scope =
    input.scope && input.scope.trim()
      ? input.scope.trim()
      : `Covers only the change needed to satisfy the acceptance criteria for \"${title}\".`;
  const acceptance = ac && ac.length ? ac : ["_to be filled_"];
  const nongoals = input.nongoals && input.nongoals.filter((n) => n && n.trim()).map((n) => n.trim());
  return [
    `# ${title}`,
    "",
    "## Purpose",
    purpose,
    "",
    "## Scope",
    scope,
    "",
    "## Acceptance Criteria",
    ...acceptance.map((a) => `- [ ] ${a}`),
    "",
    "## Non-Goals",
    ...(nongoals && nongoals.length ? nongoals.map((n) => `- ${n}`) : ["- _none yet_"]),
    "",
  ].join("\n");
}

/**
 * True when the task's LATEST comment is a human reply rather than an agent
 * comment. Comments posted by the harness carry a `**[agent]**` marker prefix
 * (e.g. `**[empress]**`, `**[superintendent]**`, `**[engineer]**`); on GitHub all
 * comments are authored by the CLI token account, so this prefix convention is
 * how we tell agent comments apart from a genuine human reply.
 */
export function hasHumanReply(t: Task): boolean {
  if (!t.comments || t.comments.length === 0) return false;
  const last = t.comments[t.comments.length - 1];
  return !/^\*\*\[[^\]]+\]\*\*/.test(String(last.body || "").trim());
}

/**
 * Best-effort language detection from issue text (Japanese / Chinese / Korean /
 * English). Used so proposal comments and the Q&A match the issue's language.
 * The "en" result is ambiguous: a genuinely-English issue and any
 * unrecognized-script text both land here — see resolveLang for the default.
 */
export function detectLanguage(text: string): string {
  const t = text || "";
  if (/[\u3040-\u30ff]/.test(t)) return "ja"; // hiragana / katakana
  if (/[\uac00-\ud7af]/.test(t)) return "ko";
  if (/[\u4e00-\u9fff]/.test(t)) return "zh"; // han
  return "en";
}

/**
 * Effective output language for prose. A clear CJK detection (ja/zh/ko) is the
 * issue language and always wins; the detector's ambiguous "en" slot (English
 * issue OR unrecognized script OR no issue text at all) falls back to the
 * `[project] language` — the config default ("en" when unset).
 */
// ponytail: detector's "en" conflates English with unknown scripts — [project]
// language fills that slot; a script-level detector would separate them (ceiling),
// add one if a non-en-default project starts receiving foreign-script issues.
export function resolveLang(detected: string, projectLang: string): string {
  return detected === "en" ? projectLang || "en" : detected;
}

/**
 * Resolved output language for a task's issue-bound prose (comments, hearings,
 * engineer reports): detected non-en issue language wins, else [project] language.
 */
export function issueLang(title: string, body: string, projectLang: string): string {
  return resolveLang(detectLanguage(`${title || ""} ${body || ""}`), projectLang || "en");
}

/** Clarification strings keyed by language code (falls back to en). */
const PROPOSAL_L10N: Record<string, { purpose: (t: string) => string; scope: (t: string) => string; acceptance: string; questions: (t: string) => string[] }> = {
  en: {
    purpose: (t) => `The harness should address: \"${t}\" so the acceptance criteria below are met.`,
    scope: (t) => `Covers only the change needed to satisfy the acceptance criteria for \"${t}\".`,
    acceptance: "(to be pinned once the questions below are answered)",
    questions: (t) => [
      `What should \"${t}\" concretely do, and why? (I inferred this from the title — correct me.)`,
      "What is the acceptance criterion / testable condition that marks it done?",
      "Anything explicitly out of scope (non-goals)?",
    ],
  },
  ja: {
    purpose: (t) => `ハーネスが「${t}」を実現できるよう、下記の受け入れ条件を満たすこと。`,
    scope: (t) => `「${t}」の受け入れ条件を満たすために必要な変更のみに限定する。`,
    acceptance: "（下記の質問への回答後に確定）",
    questions: (t) => [
      `「${t}」は具体的に何をすべきで、なぜですか？（タイトルからの推測です——違えば訂正してください）`,
      "完了とみなす、テスト可能な受け入れ条件は何ですか？",
      "対象外（Non-Goals）にしたいことはありますか？",
    ],
  },
  zh: {
    purpose: (t) => `应让系统实现「${t}」，以满足下列验收标准。`,
    scope: (t) => `仅限为满足「${t}」的验收标准所需的变更。`,
    acceptance: "（待回答下列问题后确定）",
    questions: (t) => [
      `「${t}」具体应做什么、为什么？（这是根据标题的推测——如有误请指正）`,
      "视为完成的、可测试的验收标准是什么？",
      "有没有希望明确排除在范围之外（Non-Goals）的事项？",
    ],
  },
  ko: {
    purpose: (t) => `시스템이「${t}」을(를) 실현할 수 있도록 아래 수락 기준을 충족해야 합니다.`,
    scope: (t) => `「${t}」의 수락 기준을 충족하는 데 필요한 변경만으로 한정합니다.`,
    acceptance: "（아래 질문에 답변한 후 확정）",
    questions: (t) => [
      `「${t}」은(는) 구체적으로 무엇을 해야 하며, 왜 그런가요？（제목에서 추측한 것입니다——틀리면 정정해 주세요）`,
      "완료로 간주할 수 있는 테스트 가능한 수락 기준은 무엇인가요？",
      "범위에서 명시적으로 제외하고 싶은 것（Non-Goals）이 있나요？",
    ],
  },
};

/**
 * Per-language framing strings for the readiness hearing comment (the prose
 * around the drafted proposal + open questions). Falls back to en by callers.
 */
export const CLARIFY_FRAME: Record<string, { header: string; proposed: string; questions: string }> = {
  en: {
    header: "**[empress]** This task looks under-specified. Here is a **draft spec I inferred from the title** — please **answer the open questions below** in a reply (or confirm / adjust):",
    proposed: "**Proposed:**",
    questions: "**Open questions:**",
  },
  ja: {
    header: "**[empress]** このタスクは仕様が不足しています。タイトルから推測した**ドラフト仕様**です。以下の**未解決の質問**に**返信で回答**（または確認・修正）してください：",
    proposed: "**提案（ドラフト）:**",
    questions: "**未解決の質問:**",
  },
  zh: {
    header: "**[empress]** 此任务的规格不足。这是根据标题推测的**草稿规格**——请在**回复中回答**以下**未解决的问题**（或确认/修正）：",
    proposed: "**提案（草稿）:**",
    questions: "**未解决的问题:**",
  },
  ko: {
    header: "**[empress]** 이 작업은 사양이 부족합니다. 제목에서 추측한 **초안 사양**입니다. 아래 **미해결 질문**에 **답글로 답변**（또는 확인·수정）해 주세요：",
    proposed: "**제안（초안）:**",
    questions: "**미해결 질문:**",
  },
};

/** Draft clarification: a proposed Purpose/Scope/Acceptance/Non-Goals + open questions. */
export interface SpecProposal {
  purpose: string;
  scope: string;
  acceptance: string[];
  nongoals: string[];
  questions: string[];
}

/**
 * Deterministic starting point for the clarification Q&A. Derives a draft spec
 * from the task's title/body (in the issue's detected language) and lists the
 * open questions the human should answer. The Superintendent posts this as a
 * proposal comment; when the answers resolve the open questions, the
 * Superintendent rewrites the issue body (via empress_apply_clarification) and
 * clears needs_clarification.
 */
export function proposeSpec(t: Pick<Task, "title" | "body">, lang: string = detectLanguage(`${t.title || ""} ${t.body || ""}`)): SpecProposal {
  const l = PROPOSAL_L10N[lang] || PROPOSAL_L10N.en;
  const title = (t.title || "this task").trim();
  return {
    purpose: l.purpose(title),
    scope: l.scope(title),
    acceptance: [l.acceptance],
    nongoals: ["_none yet_"],
    questions: l.questions(title),
  };
}

/**
 * Human-readable single-line summary of a task for passing to an Engineer.
 * (Defined here and re-exported by tasks.ts for compatibility.) */
export function taskBrief(t: Task): string {
  return [
    `Task #${t.id}: ${t.title}`,
    `Status: ${t.status}`,
    t.branch ? `Branch/worktree: ${t.branch}` : "",
    t.pr ? `PR: ${t.pr}` : "",
    "",
    t.body,
    "",
    t.comments.length ? `Comments:\n${t.comments.map((c) => `- [${c.author}] ${c.body}`).join("\n")}` : "",
  ]
    .filter((s) => s !== "")
    .join("\n");
}