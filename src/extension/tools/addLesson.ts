import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { addLesson } from "../../domain/lessons.ts";
import { projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_add_lesson",
    label: "Empress Add Lesson",
    description: "Append a lesson learned to .empress/lessons.md.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params) {
      const ok = addLesson(projectDir(), params.text);
      return reply(JSON.stringify({ added: ok }));
    },
  });
}