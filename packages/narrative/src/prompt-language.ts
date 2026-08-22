import type { ProjectLanguage } from "@narralume/contracts";

/** AI 指令与产出跟随作品语言（project.language），与界面语言无关。
 *  未知值回落中文，覆盖存量数据与缺省路径。 */
export function promptLanguageOf(
  language: string | null | undefined,
): ProjectLanguage {
  return language === "en" ? "en" : "zh-CN";
}

/** 按项目语言取双语指令表并拼接为 system instructions。 */
export function instructionsFor(
  language: string | null | undefined,
  table: Record<ProjectLanguage, readonly string[]>,
): string {
  return table[promptLanguageOf(language)].join("\n");
}
