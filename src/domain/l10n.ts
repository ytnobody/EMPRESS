// Harness-side l10n (task #34): deterministic agent comments, close notes, and
// the auto-recorded landing lesson follow the issue / [project] language just
// like LLM-authored prose. No translation backend: fixed literal tables.
//
// Issue-bound prose (comments on a task) resolves via issueLang(); repo-bound
// prose (the lessons.md auto-lesson) uses the [project] language directly.

export interface AgentL10n {
  /** Auto-land refusal comment (issue-bound, written by empress_land_task). */
  highRiskSkip: (reasons: string) => string;
  prOpened: (url: string) => string;
  prFailed: (err: string) => string;
  /** Land comment when origin/<base> could not be reconciled (#94 push failed). */
  originPushFailed: (base: string, err: string) => string;
  /** Task close note after a successful land. */
  landedNote: (base: string, note: string) => string;
  /** Comment after apply_clarification rewrote the issue body. */
  clarifyApplied: () => string;
  /** Repo-bound auto-lesson recorded on landing (uses the [project] language). */
  lessonAfterLand: (id: number, level: string, reasons: string) => string;
}

export const AGENT_L10N: Record<string, AgentL10n> = {
  en: {
    highRiskSkip: (reasons) => `⚠️ HIGH risk — skipping auto-land. Reasons: ${reasons}`,
    prOpened: (url) => `PR opened: ${url}`,
    prFailed: (err) => `PR step failed: ${err}`,
    originPushFailed: (base, err) => `⚠️ Landed into local ${base}, but pushing ${base} to origin failed (${err}); origin/${base} is behind — retry the land.`,
    landedNote: (base, note) => `Landed into ${base} (${note}).`,
    clarifyApplied: () => "Clarified — drafted the resolved spec into the task body (needs_clarification cleared). The next pass can implement it.",
    lessonAfterLand: (id, level, reasons) => `After landing task #${id}, the result was ${level} risk — ${reasons || "no concerns"}.`,
  },
  ja: {
    highRiskSkip: (reasons) => `⚠️ リスク HIGH — 自動ランドをスキップします。理由: ${reasons}`,
    prOpened: (url) => `PR をオープンしました: ${url}`,
    prFailed: (err) => `PR 作成に失敗しました: ${err}`,
    originPushFailed: (base, err) => `⚠️ ローカル ${base} にはランドしましたが、${base} の origin への push に失敗しました（${err}）。origin/${base} が遅れています — 再ランドしてください。`,
    landedNote: (base, note) => `${base} にランドしました（${note}）。`,
    clarifyApplied: () => "仕様を確定し、タスク本文に反映しました（needs_clarification 解除）。次のパスで実装できます。",
    lessonAfterLand: (id, level, reasons) => `タスク #${id} のランド結果は ${level} リスクでした — ${reasons || "懸念なし"}。`,
  },
  zh: {
    highRiskSkip: (reasons) => `⚠️ 风险 HIGH — 跳过自动合并。原因: ${reasons}`,
    prOpened: (url) => `已创建 PR: ${url}`,
    prFailed: (err) => `创建 PR 失败: ${err}`,
    originPushFailed: (base, err) => `⚠️ 已合并到本地 ${base}，但推送 ${base} 到 origin 失败（${err}）；origin/${base} 落后 — 请重新合并。`,
    landedNote: (base, note) => `已合并到 ${base}（${note}）。`,
    clarifyApplied: () => "已确认规格并写入任务正文（needs_clarification 已清除）。下一次循环即可实现。",
    lessonAfterLand: (id, level, reasons) => `任务 #${id} 的合并结果为 ${level} 风险 — ${reasons || "无顾虑"}。`,
  },
  ko: {
    highRiskSkip: (reasons) => `⚠️ HIGH 위험 — 자동 랜딩을 건너뜁니다. 이유: ${reasons}`,
    prOpened: (url) => `PR이 열렸습니다: ${url}`,
    prFailed: (err) => `PR 생성 실패: ${err}`,
    originPushFailed: (base, err) => `⚠️ 로컬 ${base}에 랜딩했지만 ${base}를 origin으로 push하지 못했습니다（${err}）. origin/${base}가 뒤처졌습니다 — 다시 랜딩하세요.`,
    landedNote: (base, note) => `${base}에 랜딩했습니다（${note}）。`,
    clarifyApplied: () => "사양을 확정하여 작업 본문에 반영했습니다（needs_clarification 해제）. 다음 패스에서 구현할 수 있습니다.",
    lessonAfterLand: (id, level, reasons) => `작업 #${id} 랜딩 결과는 ${level} 위험이었습니다 — ${reasons || "우려 없음"}。`,
  },
};

/** Table for a language code, falling back to English for unknown codes. */
export function agentL10n(lang: string): AgentL10n {
  return AGENT_L10N[lang] || AGENT_L10N.en;
}