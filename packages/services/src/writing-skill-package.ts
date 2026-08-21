import { CreateWritingSkillRequestSchema } from "@narralume/contracts";
import type { WritingSkill, WritingSkillScope } from "@narralume/domain";
import JSZip from "jszip";

import { declaredUncompressedSize } from "./internal/zip.js";
import { ServiceError } from "./service-error.js";

export class WritingSkillPackageError extends ServiceError {
  constructor(code: string, message: string, statusCode: number) {
    super(code, message, statusCode);
    this.name = "WritingSkillPackageError";
  }
}

/**
 * 解析写作 Skill 包（.zip 或 .md）：ZIP 走安全路径检查、引用数量与
 * 大小限制；SKILL.md frontmatter 提取元数据。bytes 用 Uint8Array（浏览器
 * ArrayBuffer 与 Node Buffer 都可传入）。
 */
export async function parseWritingSkillPackage(
  filename: string,
  bytes: Uint8Array,
) {
  let markdown: string;
  const references: Array<{ path: string; content: string }> = [];
  const referencePaths = new Set<string>();
  if (filename.toLocaleLowerCase().endsWith(".zip")) {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      throw new WritingSkillPackageError(
        "skill.package.invalid_zip",
        "The skill ZIP cannot be read",
        422,
      );
    }
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    if (entries.length > 200)
      throw new WritingSkillPackageError(
        "skill.package.too_many_entries",
        "The skill ZIP entry count exceeds the safety limit",
        422,
      );
    if (
      entries.reduce(
        (sum, entry) =>
          sum + declaredUncompressedSize(entry, Number.POSITIVE_INFINITY),
        0,
      ) >
      8 * 1024 * 1024
    )
      throw new WritingSkillPackageError(
        "skill.package.too_large",
        "The skill ZIP declares an uncompressed size above the safety limit",
        422,
      );
    const skillEntry = entries.find(
      (entry) =>
        entry.name.replaceAll("\\", "/").toLocaleLowerCase() === "skill.md",
    );
    if (!skillEntry)
      throw new WritingSkillPackageError(
        "skill.package.missing_manifest",
        "The skill ZIP root is missing SKILL.md",
        422,
      );
    if (
      declaredUncompressedSize(skillEntry, Number.POSITIVE_INFINITY) >
      1024 * 1024
    )
      throw new WritingSkillPackageError(
        "skill.package.manifest_too_large",
        "SKILL.md declares an uncompressed size above the safety limit",
        422,
      );
    markdown = await skillEntry.async("string");
    let totalCharacters = markdown.length;
    for (const entry of entries) {
      const path = safeSkillPath(entry.name);
      if (!path.toLocaleLowerCase().startsWith("references/")) continue;
      if (
        declaredUncompressedSize(entry, Number.POSITIVE_INFINITY) >
        2 * 1024 * 1024
      )
        throw new WritingSkillPackageError(
          "skill.package.too_large",
          `Skill reference declares an excessive uncompressed size: ${path}`,
          422,
        );
      if (referencePaths.has(path))
        throw new WritingSkillPackageError(
          "skill.package.duplicate_reference",
          `The skill ZIP contains a duplicate reference path: ${path}`,
          422,
        );
      if (references.length >= 100)
        throw new WritingSkillPackageError(
          "skill.package.too_many_references",
          "Reference documents must not exceed 100",
          422,
        );
      const content = await entry.async("string");
      totalCharacters += content.length;
      if (content.length > 500_000 || totalCharacters > 2_000_000)
        throw new WritingSkillPackageError(
          "skill.package.too_large",
          "The extracted skill reference content is too large",
          422,
        );
      referencePaths.add(path);
      references.push({ path, content });
    }
  } else {
    markdown = new TextDecoder("utf-8").decode(bytes);
  }
  if (markdown.length > 150_000)
    throw new WritingSkillPackageError(
      "skill.package.manifest_too_large",
      "SKILL.md content is too large",
      422,
    );
  const parsed = parseSkillMarkdown(filename, markdown);
  const validated = CreateWritingSkillRequestSchema.parse(parsed);
  return { ...validated, references };
}

/** 导出 Skill 为 markdown 文件内容。 */
export function renderSkillMarkdown(skill: WritingSkill): string {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description ?? ""}`,
    `scopes: [${skill.scopes.join(", ")}]`,
    `priority: ${skill.priority}`,
    "---",
    "",
    skill.instructions,
    "",
  ].join("\n");
}

function parseSkillMarkdown(filename: string, markdown: string) {
  const normalized = markdown.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n");
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---\n?/u);
  const metadata: Record<string, string> = {};
  if (frontmatter?.[1]) {
    for (const line of frontmatter[1].split("\n")) {
      const separator = line.indexOf(":");
      if (separator <= 0) continue;
      metadata[line.slice(0, separator).trim()] = line
        .slice(separator + 1)
        .trim()
        .replace(/^['"]|['"]$/gu, "");
    }
  }
  const instructions = normalized.slice(frontmatter?.[0].length ?? 0).trim();
  const fallbackName = filename.replace(/\.(skill\.)?(md|zip)$/iu, "");
  const scopes = parseSkillScopes(metadata.scopes);
  return {
    name: metadata.name || fallbackName || "导入 Skill",
    description: metadata.description || null,
    instructions,
    scopes,
    priority: Number.parseInt(metadata.priority ?? "50", 10),
    enabled: true,
  };
}

function parseSkillScopes(value: string | undefined): WritingSkillScope[] {
  const allowed = new Set<WritingSkillScope>([
    "all",
    "chapter",
    "cocreate",
    "edit",
    "review",
  ]);
  const parsed = (value ?? "all")
    .replace(/^\[|\]$/gu, "")
    .split(",")
    .map((scope) => scope.trim().replace(/^['"]|['"]$/gu, ""))
    .filter((scope): scope is WritingSkillScope =>
      allowed.has(scope as WritingSkillScope),
    );
  return parsed.length > 0 ? [...new Set(parsed)] : ["all"];
}

function safeSkillPath(input: string): string {
  const path = input.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    path.startsWith("/") ||
    path.split("/").some((part) => part === ".." || part === "")
  )
    throw new WritingSkillPackageError(
      "skill.package.unsafe_path",
      "The skill ZIP contains an unsafe path",
      422,
    );
  return path;
}

/** 把 Skill 与其引用打包为 ZIP 二进制（Uint8Array）。 */
export async function buildWritingSkillZip(
  skill: WritingSkill,
  references: ReadonlyArray<{ path: string; content: string }>,
): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("SKILL.md", renderSkillMarkdown(skill));
  for (const reference of references)
    zip.file(reference.path, reference.content);
  zip.file(
    "skill.json",
    JSON.stringify(
      {
        name: skill.name,
        description: skill.description,
        scopes: skill.scopes,
        priority: skill.priority,
        source: skill.source,
      },
      null,
      2,
    ),
  );
  return zip.generateAsync({ type: "uint8array" });
}
