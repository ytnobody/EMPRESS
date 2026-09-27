// EMPRESS — pi extension entry. Registers empress_* custom tools (mirroring
// HERMIT's GitHub MCP tools but localized: tasks live in .empress/tasks, merges
// happen on local branches, and judgments go to Jev (System One) via a native
// fetch call). No GitHub, no Claude Code.
// This file is intentionally a thin registration index: each empress_* tool's
// registration lives in its own module under tools/ so the control-plane stays
// individually reviewable. Shared helpers (reply, cfg, spawnEngineer, notify)
// live in tools/helpers.ts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { register as registerNow } from "./tools/now.ts";
import { register as registerGetConfig } from "./tools/getConfig.ts";
import { register as registerListTasks } from "./tools/listTasks.ts";
import { register as registerGetTask } from "./tools/getTask.ts";
import { register as registerReadiness } from "./tools/readiness.ts";
import { register as registerApplyClarification } from "./tools/applyClarification.ts";
import { register as registerAssignTask } from "./tools/assignTask.ts";
import { register as registerCreateWorktree } from "./tools/createWorktree.ts";
import { register as registerSpawnEngineers } from "./tools/spawnEngineers.ts";
import { register as registerCheckCi } from "./tools/checkCi.ts";
import { register as registerEvaluateRisk } from "./tools/evaluateRisk.ts";
import { register as registerLandTask } from "./tools/landTask.ts";
import { register as registerPushPr } from "./tools/pushPr.ts";
import { register as registerTaskComment } from "./tools/taskComment.ts";
import { register as registerCloseTask } from "./tools/closeTask.ts";
import { register as registerVulnCheck } from "./tools/vulnCheck.ts";
import { register as registerTriageReview } from "./tools/triageReview.ts";
import { register as registerAuditScan } from "./tools/auditScan.ts";
import { register as registerPonytailDebt } from "./tools/ponytailDebt.ts";
import { register as registerListBranches } from "./tools/listBranches.ts";
import { register as registerGetLessons } from "./tools/getLessons.ts";
import { register as registerAddLesson } from "./tools/addLesson.ts";
import { register as registerGetLoopState } from "./tools/getLoopState.ts";
import { register as registerUpdateLoopState } from "./tools/updateLoopState.ts";
import { register as registerNotify } from "./tools/notifyTool.ts";

export default function (pi: ExtensionAPI) {
  registerNow(pi);
  registerGetConfig(pi);
  registerListTasks(pi);
  registerGetTask(pi);
  registerReadiness(pi);
  registerApplyClarification(pi);
  registerAssignTask(pi);
  registerCreateWorktree(pi);
  registerSpawnEngineers(pi);
  registerCheckCi(pi);
  registerEvaluateRisk(pi);
  registerLandTask(pi);
  registerPushPr(pi);
  registerTaskComment(pi);
  registerCloseTask(pi);
  registerVulnCheck(pi);
  registerTriageReview(pi);
  registerAuditScan(pi);
  registerPonytailDebt(pi);
  registerListBranches(pi);
  registerGetLessons(pi);
  registerAddLesson(pi);
  registerGetLoopState(pi);
  registerUpdateLoopState(pi);
  registerNotify(pi);
}