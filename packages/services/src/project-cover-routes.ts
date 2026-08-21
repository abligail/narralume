import {
  SqliteProjectCoverRepository,
  SqliteProjectRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";
import { z } from "zod";

import {
  StoryServiceError,
  type RouteApp,
  type RouteResponse,
} from "@narralume/services";

const ProjectCoverParamsSchema = z.object({
  projectId: z.string().trim().min(1),
});

/**
 * 封面图片的读取端点。封面变更不走独立端点：资料与封面的修改通过
 * PUT /api/projects/:projectId 在同一事务提交（CR-83）。
 */
export function registerProjectCoverRoutes(
  app: RouteApp,
  database: NarrativeDatabase,
): void {
  const projects = new SqliteProjectRepository(database);
  const covers = new SqliteProjectCoverRepository(database);

  app.route("GET", "/api/projects/:projectId/cover", async (request) => {
    const { projectId } = ProjectCoverParamsSchema.parse(request.params);
    if (!projects.get(projectId))
      throw new StoryServiceError(
        "project.not_found",
        "Project not found",
        404,
      );
    const cover = covers.get(projectId);
    if (!cover)
      throw new StoryServiceError(
        "project.cover.not_found",
        "This project has no custom cover yet",
        404,
      );
    const etag = `W/"${cover.updatedAt}"`;
    if (request.headers["if-none-match"] === etag)
      return { status: 304 } satisfies RouteResponse;
    return {
      status: 200,
      body: cover.data,
      headers: {
        "content-type": cover.mediaType,
        "content-length": String(cover.byteSize),
        "cache-control": "private, max-age=0, must-revalidate",
        etag,
      },
    } satisfies RouteResponse;
  });
}
