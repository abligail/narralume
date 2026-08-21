import { randomUuid, sha256Hex } from "@narralume/domain";
import { hashBytes } from "./internal/bytes.js";

import {
  IMPORTABLE_AGENT_SKILL_CAPABILITIES,
  ImportedAgentSkillSchema,
  type ImportedAgentSkillDto,
} from "@narralume/contracts";
import {
  SqliteImportedAgentSkillRepository,
  type ImportedAgentSkill,
  type NarrativeDatabase,
} from "@narralume/persistence";
import JSZip from "jszip";

import { declaredUncompressedSize } from "./internal/zip.js";
import { z } from "zod";

const IMPORTABLE_CAPABILITY_SET = new Set(IMPORTABLE_AGENT_SKILL_CAPABILITIES);

const AgentSkillManifestSchema = z
  .object({
    format: z.literal("narrative-agent-skill"),
    version: z.literal(1),
    label: z.string().trim().min(1).max(100),
    skillVersion: z.string().trim().min(1).max(50),
    description: z.string().trim().min(1).max(2_000),
    triggerDescription: z.string().trim().min(1).max(2_000),
    requiredContext: z.array(z.string().trim().min(1).max(100)).max(20),
    allowedCapabilities: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(20),
    outputKind: z.enum(["answer", "candidate", "task_handle", "long_goal"]),
    checkpoint: z.enum(["none", "confirm_start", "candidate_adoption"]),
  })
  .strict();

export class AgentSkillImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentSkillImportError";
  }
}

interface ParsedAgentSkillPackage {
  manifest: z.infer<typeof AgentSkillManifestSchema>;
  instructions: string;
  references: { path: string; content: string; contentHash: string }[];
  contentHash: string;
}

export class AgentSkillImportService {
  private readonly skills: SqliteImportedAgentSkillRepository;

  constructor(private readonly database: NarrativeDatabase) {
    this.skills = new SqliteImportedAgentSkillRepository(database);
  }

  listForProject(projectId: string): ImportedAgentSkillDto[] {
    return this.skills.listForProject(projectId).map((skill) => toDto(skill));
  }

  async importPackage(
    projectId: string,
    filename: string,
    bytes: Buffer,
    now: string,
  ): Promise<ImportedAgentSkillDto> {
    const parsed = await parseAgentSkillPackage(filename, bytes);
    const label = parsed.manifest.label;
    if (
      this.skills
        .listForProject(projectId)
        .some((skill) => skill.label === label)
    ) {
      throw new AgentSkillImportError(
        "agent_skill.duplicate_label",
        `An Agent Skill named "${label}" already exists in this project`,
      );
    }
    const skill: ImportedAgentSkill = {
      id: randomUuid(),
      projectId,
      label,
      version: parsed.manifest.skillVersion,
      description: parsed.manifest.description,
      triggerDescription: parsed.manifest.triggerDescription,
      instructions: parsed.instructions,
      references: parsed.references.map(({ path, contentHash }) => ({
        path,
        contentHash,
      })),
      requiredContext: parsed.manifest.requiredContext,
      allowedCapabilities: parsed.manifest.allowedCapabilities,
      outputKind: parsed.manifest.outputKind,
      checkpoint: parsed.manifest.checkpoint,
      enabled: true,
      source: `agent-skill-package:${filename}`,
      contentHash: parsed.contentHash,
      createdAt: now,
      updatedAt: now,
    };
    return toDto(this.skills.insert(skill));
  }

  setEnabled(
    id: string,
    enabled: boolean,
    expectedUpdatedAt: string,
    now: string,
  ): ImportedAgentSkillDto {
    return toDto(this.skills.setEnabled(id, enabled, expectedUpdatedAt, now));
  }

  remove(id: string): void {
    if (!this.skills.delete(id)) {
      throw new AgentSkillImportError(
        "agent_skill.not_found",
        "Imported Agent Skill not found",
      );
    }
  }
}

function toDto(skill: ImportedAgentSkill): ImportedAgentSkillDto {
  return ImportedAgentSkillSchema.parse({
    id: skill.id,
    projectId: skill.projectId,
    label: skill.label,
    version: skill.version,
    description: skill.description,
    triggerDescription: skill.triggerDescription,
    instructions: skill.instructions,
    references: skill.references,
    requiredContext: skill.requiredContext,
    allowedCapabilities: skill.allowedCapabilities,
    outputKind: skill.outputKind,
    checkpoint: skill.checkpoint,
    enabled: skill.enabled,
    source: skill.source,
    contentHash: skill.contentHash,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  });
}

async function parseAgentSkillPackage(
  filename: string,
  bytes: Buffer,
): Promise<ParsedAgentSkillPackage> {
  if (bytes.length > 8 * 1024 * 1024) {
    throw new AgentSkillImportError(
      "agent_skill.package_too_large",
      "The Agent Skill package must not exceed 8 MB",
    );
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new AgentSkillImportError(
      "agent_skill.invalid_zip",
      "The Agent Skill package is not a valid ZIP archive",
    );
  }
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > 100) {
    throw new AgentSkillImportError(
      "agent_skill.too_many_entries",
      "The Agent Skill package contains more entries than the safety limit",
    );
  }
  // 所有条目先做路径安全校验，拒绝绝对路径与目录穿越。
  const safeEntries = entries.map((entry) => ({
    entry,
    path: safePath(entry.name),
  }));
  const declaredBytes = safeEntries.reduce(
    (sum, { entry }) =>
      sum + declaredUncompressedSize(entry, Number.POSITIVE_INFINITY),
    0,
  );
  if (declaredBytes > 8 * 1024 * 1024) {
    throw new AgentSkillImportError(
      "agent_skill.package_too_large",
      "The Agent Skill package declares an uncompressed size above the safety limit",
    );
  }
  const manifestEntry = safeEntries.find(
    ({ path }) => path === "agent-skill.json",
  )?.entry;
  if (!manifestEntry) {
    throw new AgentSkillImportError(
      "agent_skill.missing_manifest",
      "The Agent Skill package is missing agent-skill.json at its root",
    );
  }
  if (
    declaredUncompressedSize(manifestEntry, Number.POSITIVE_INFINITY) >
    1024 * 1024
  ) {
    throw new AgentSkillImportError(
      "agent_skill.package_too_large",
      "agent-skill.json declares an uncompressed size above the safety limit",
    );
  }
  const manifestRaw = await manifestEntry.async("string");
  let manifest: z.infer<typeof AgentSkillManifestSchema>;
  try {
    manifest = AgentSkillManifestSchema.parse(
      JSON.parse(stripBom(manifestRaw)),
    );
  } catch {
    throw new AgentSkillImportError(
      "agent_skill.invalid_manifest",
      "agent-skill.json is not a valid Agent Skill manifest",
    );
  }
  for (const capability of manifest.allowedCapabilities) {
    if (!IMPORTABLE_CAPABILITY_SET.has(capability)) {
      throw new AgentSkillImportError(
        "agent_skill.capability_not_allowed",
        `Capability is not allowed in imported Agent Skills: ${capability}`,
      );
    }
  }
  const instructionsEntry = safeEntries.find(
    ({ path }) => path === "INSTRUCTIONS.md",
  )?.entry;
  if (!instructionsEntry) {
    throw new AgentSkillImportError(
      "agent_skill.missing_instructions",
      "The Agent Skill package is missing INSTRUCTIONS.md",
    );
  }
  if (
    declaredUncompressedSize(instructionsEntry, Number.POSITIVE_INFINITY) >
    512 * 1024
  ) {
    throw new AgentSkillImportError(
      "agent_skill.instructions_too_large",
      "INSTRUCTIONS.md declares an uncompressed size above the safety limit",
    );
  }
  const instructions = stripBom(await instructionsEntry.async("string")).trim();
  if (!instructions) {
    throw new AgentSkillImportError(
      "agent_skill.empty_instructions",
      "INSTRUCTIONS.md must not be empty",
    );
  }
  if (instructions.length > 100_000) {
    throw new AgentSkillImportError(
      "agent_skill.instructions_too_large",
      "INSTRUCTIONS.md is too large",
    );
  }
  const references: { path: string; content: string; contentHash: string }[] =
    [];
  const seenPaths = new Set<string>();
  let totalCharacters = instructions.length + manifestRaw.length;
  for (const { entry, path } of safeEntries) {
    if (path === "agent-skill.json" || path === "INSTRUCTIONS.md") continue;
    if (!path.startsWith("references/")) continue;
    if (
      declaredUncompressedSize(entry, Number.POSITIVE_INFINITY) >
      2 * 1024 * 1024
    ) {
      throw new AgentSkillImportError(
        "agent_skill.package_too_large",
        `The reference declares an uncompressed size above the limit: ${path}`,
      );
    }
    if (seenPaths.has(path)) {
      throw new AgentSkillImportError(
        "agent_skill.duplicate_reference",
        `Duplicate reference path: ${path}`,
      );
    }
    if (references.length >= 50) {
      throw new AgentSkillImportError(
        "agent_skill.too_many_references",
        "The package must not contain more than 50 reference documents",
      );
    }
    const content = await entry.async("string");
    totalCharacters += content.length;
    if (content.length > 500_000 || totalCharacters > 2_000_000) {
      throw new AgentSkillImportError(
        "agent_skill.package_too_large",
        "The Agent Skill package is too large when uncompressed",
      );
    }
    seenPaths.add(path);
    references.push({
      path,
      content,
      contentHash: sha256Hex(content),
    });
  }
  return {
    manifest,
    instructions,
    references,
    contentHash: hashBytes(bytes),
  };
}

function safePath(input: string): string {
  const path = input.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    !path ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new AgentSkillImportError(
      "agent_skill.unsafe_path",
      "The Agent Skill package contains an unsafe path",
    );
  }
  return path;
}

function stripBom(value: string): string {
  return value.replace(/^\uFEFF/u, "");
}
