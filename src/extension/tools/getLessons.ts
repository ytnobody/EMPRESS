import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getLessons } from "../../domain/lessons.ts";
import { projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_get_lessons",
    label: "Empress Get Lessons",
    description: "Return lessons learned from past tasks, to avoid repeating mistakes.",
    parameters: Type.Object({}),
    async execute() {
      const lessons = getLessons(projectDir());
      return reply(JSON.stringify(lessons));
    },
  });
}