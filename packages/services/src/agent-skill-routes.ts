import {
  ImportAgentSkillPackageRequestSchema,
  ImportedAgentSkillSchema,
  SetImportedAgentSkillEnabledRequestSchema,
} from "@narralume/contracts";
import {
  SqliteProjectRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";
import { z } from "zod";

import type { RouteApp } from "@narralume/services";
import {
  AgentSkillImportError,
  AgentSkillImportService,
} from "@narralume/services";
import { StoryServiceError } from "@narralume/services";

const ProjectParamsSchema = z.object({ projectId: z.string().trim().min(1) });
const SkillParamsSchema = z.object({ skillId: z.string().trim().min(1) });

export function registerAgentSkillRoutes(
  app: RouteApp,
  database: NarrativeDatabase,
): void {
  const projects = new SqliteProjectRepository(database);
  const service = new AgentSkillImportService(database);

  app.route("GET", "/api/projects/:projectId/agent-skills", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    requireProject(projects, projectId);
    return service.listForProject(projectId);
  });

  app.route(
    "POST",
    "/api/projects/:projectId/agent-skills/import",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireProject(projects, projectId);
      const input = ImportAgentSkillPackageRequestSchema.parse(request.body);
      try {
        const skill = await service.importPackage(
          projectId,
          input.filename,
          Buffer.from(input.contentBase64, "base64"),
          new Date().toISOString(),
        );
        return { status: 201, body: skill };
      } catch (error) {
        if (error instanceof AgentSkillImportError) {
          throw new StoryServiceError(error.code, error.message, 422);
        }
        throw error;
      }
    },
  );

  app.route("POST", "/api/agent-skills/:skillId/enabled", async (request) => {
    const { skillId } = SkillParamsSchema.parse(request.params);
    const input = SetImportedAgentSkillEnabledRequestSchema.parse(request.body);
    const skill = service.setEnabled(
      skillId,
      input.enabled,
      input.expectedUpdatedAt,
      new Date().toISOString(),
    );
    return ImportedAgentSkillSchema.parse(skill);
  });

  app.route("DELETE", "/api/agent-skills/:skillId", async (request) => {
    const { skillId } = SkillParamsSchema.parse(request.params);
    service.remove(skillId);
    return { status: 204 };
  });
}

function requireProject(
  projects: SqliteProjectRepository,
  projectId: string,
): void {
  if (!projects.get(projectId)) {
    throw new StoryServiceError("project.not_found", "Project not found", 404);
  }
}
