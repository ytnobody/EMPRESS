// L10n table tests (task #34): deterministic agent comments / close notes and the
// auto-recorded landing lesson (landTask) follow the issue or [project] language
// just like LLM-authored prose does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_L10N, agentL10n } from "../src/domain/l10n.js";

test("l10n: agentL10n ships a full table for every supported language", () => {
  // Verifies: en/ja/zh/ko all carry the same deterministic comment/note/lesson
  // slots, so no tool silently falls back to English for a supported language.
  for (const lang of ["en", "ja", "zh", "ko"]) {
    const t = AGENT_L10N[lang];
    assert.ok(t, `AGENT_L10N[${lang}]`);
    assert.equal(typeof t.highRiskSkip("r"), "string");
    assert.equal(typeof t.prOpened("u"), "string");
    assert.equal(typeof t.prFailed("e"), "string");
    assert.equal(typeof t.landedNote("develop", "x"), "string");
    assert.equal(typeof t.clarifyApplied(), "string");
    assert.equal(typeof t.lessonAfterLand(1, "LOW", "r"), "string");
  }
});

test("l10n: landing lesson is written in the resolved language, not English", () => {
  // Verifies: the deterministic auto-lesson localizes per language, keeps the
  // factual tokens (task id, risk level), and never emits the English template.
  assert.ok(AGENT_L10N.ja.lessonAfterLand(34, "HIGH", "r").includes("#34"));
  assert.ok(AGENT_L10N.zh.lessonAfterLand(34, "HIGH", "r").includes("风险"));
  assert.ok(AGENT_L10N.ko.lessonAfterLand(34, "HIGH", "r").includes("랜딩"));
  assert.ok(!/After landing/.test(AGENT_L10N.zh.lessonAfterLand(34, "HIGH", "r")));
  assert.ok(agentL10n("xx").lessonAfterLand(1, "LOW", "").includes("After landing"));
});

test("l10n: HIGH-risk skip comment localizes per language", () => {
  // Verifies: the deterministic auto-land refusal comment reads in the issue's
  // language for ja/zh/ko issues, not the English default.
  assert.ok(AGENT_L10N.ja.highRiskSkip("HIGH").includes("自動ランド"));
  assert.ok(AGENT_L10N.ko.highRiskSkip("HIGH").includes("위험"));
  assert.ok(AGENT_L10N.en.highRiskSkip("HIGH").includes("HIGH risk"));
});