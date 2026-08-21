import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { replaceDatabaseFile } from "../src/database-backup-service.js";

describe("product lifecycle API", () => {
  let app: FastifyInstance | null = null;
  let workspace: string | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = null;
  });

  it("duplicates, safely deletes, chunk-imports HTML, and round-trips DOCX", async () => {
    ({ app, workspace } = await setup());
    const project = await createProject(app, "潮汐档案");
    const manuscript = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/documents`,
      payload: {
        requestId: "lifecycle-manuscript",
        kind: "manuscript",
        title: "正文总稿",
        outlineNodeId: null,
      },
    });
    const manuscriptId = manuscript.json().id as string;
    const version = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/documents/${manuscriptId}/versions`,
      payload: {
        content: "第一章\n\n潮水在午夜越过旧钟楼。",
        source: "test",
        expectedCurrentVersionId: null,
      },
    });
    expect(version.statusCode).toBe(201);

    const duplicated = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/duplicate`,
      payload: {},
    });
    expect(duplicated.statusCode).toBe(201);
    expect(duplicated.json().id).not.toBe(project.id);

    const docx = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/exports/docx`,
    });
    expect(docx.statusCode).toBe(200);
    expect(docx.headers["content-type"]).toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(docx.rawPayload.subarray(0, 2).toString()).toBe("PK");
    const docxPreview = await app.inject({
      method: "POST",
      url: "/api/imports/preview",
      payload: {
        targetProjectId: project.id,
        filename: "roundtrip.docx",
        format: "docx",
        contentBase64: docx.rawPayload.toString("base64"),
      },
    });
    expect(docxPreview.statusCode, docxPreview.body).toBe(201);
    expect(docxPreview.json().batch.sourceCharacters).toBeGreaterThan(8);
    const auditBundle = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/exports/narrative-bundle?versionMode=history&includeAnnotations=true&includeRuns=true`,
    });
    expect(auditBundle.statusCode).toBe(200);
    expect(auditBundle.json().manifest.version).toBe(3);
    expect(auditBundle.json().manifest.options).toEqual({
      versionMode: "history",
      includeAnnotations: true,
      includeRuns: true,
    });
    expect(auditBundle.json().documents[0].versions).toHaveLength(1);

    const html = Buffer.from(
      `<html><body><h1>分块迁移</h1><p>${"远岸灯火。".repeat(15_000)}</p></body></html>`,
      "utf8",
    );
    const chunkSize = 65_536;
    const upload = await app.inject({
      method: "POST",
      url: "/api/import-uploads",
      payload: {
        targetProjectId: null,
        filename: "legacy.html",
        format: "html",
        totalBytes: html.length,
        chunkSize,
        expectedHash: sha256(html),
      },
    });
    expect(upload.statusCode).toBe(201);
    const uploadId = upload.json().id as string;
    const rejectedChunk = await app.inject({
      method: "PUT",
      url: `/api/import-uploads/${uploadId}/chunks/0`,
      payload: {
        contentBase64: html.subarray(0, chunkSize).toString("base64"),
        chunkHash: "0".repeat(64),
      },
    });
    expect(rejectedChunk.statusCode).toBe(422);
    for (
      let offset = 0, index = 0;
      offset < html.length;
      offset += chunkSize, index += 1
    ) {
      const chunk = html.subarray(
        offset,
        Math.min(html.length, offset + chunkSize),
      );
      const result = await app.inject({
        method: "PUT",
        url: `/api/import-uploads/${uploadId}/chunks/${index}`,
        payload: {
          contentBase64: chunk.toString("base64"),
          chunkHash: sha256(chunk),
        },
      });
      expect(result.statusCode).toBe(200);
    }
    const completed = await app.inject({
      method: "POST",
      url: `/api/import-uploads/${uploadId}/complete`,
      payload: {},
    });
    expect(completed.statusCode).toBe(201);
    expect(completed.json().session.status).toBe("completed");
    const detail = completed.json().detail;
    const applied = await app.inject({
      method: "POST",
      url: `/api/imports/${detail.batch.id}/actions`,
      payload: {
        action: "apply",
        selectedCandidateIds: detail.candidates.map(
          (candidate: { id: string }) => candidate.id,
        ),
      },
    });
    expect(applied.statusCode).toBe(200);

    const archived = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}`,
      payload: {
        title: project.title,
        subtitle: project.subtitle,
        premise: project.premise,
        archived: true,
        expectedUpdatedAt: project.updatedAt,
      },
    });
    expect(archived.statusCode).toBe(200);
    const wrongConfirmation = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
      payload: {
        confirmationTitle: "错误标题",
        expectedUpdatedAt: archived.json().updatedAt,
      },
    });
    expect(wrongConfirmation.statusCode).toBe(422);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
      payload: {
        confirmationTitle: project.title,
        expectedUpdatedAt: archived.json().updatedAt,
      },
    });
    expect(removed.statusCode).toBe(202);
    const recycled = removed.json();
    expect(recycled).toMatchObject({
      id: project.id,
      title: project.title,
    });
    expect(recycled.deletionToken).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/u);
    const hidden = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/story-bible`,
    });
    expect(hidden.statusCode).toBe(404);
    const recycleBin = await app.inject({
      method: "GET",
      url: "/api/projects/recycle-bin",
    });
    expect(recycleBin.json()).toEqual([
      expect.objectContaining({ id: project.id }),
    ]);
    const restoredProject = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/restore`,
      payload: { deletionToken: recycled.deletionToken },
    });
    expect(restoredProject.statusCode).toBe(200);
    const recycledAgain = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
      payload: {
        confirmationTitle: project.title,
        expectedUpdatedAt: restoredProject.json().updatedAt,
      },
    });
    expect(recycledAgain.statusCode).toBe(202);
    const purged = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/purge`,
      payload: {
        confirmationTitle: project.title,
        deletionToken: recycledAgain.json().deletionToken,
      },
    });
    expect(purged.statusCode).toBe(204);
  });

  it("creates, validates, retains, and restores an online full database backup", async () => {
    ({ app, workspace } = await setup(2));
    await createProject(app, "灾备样本");
    const first = await app.inject({
      method: "POST",
      url: "/api/system/backups",
      payload: { label: "发布前" },
    });
    expect(first.statusCode).toBe(201);
    const manifest = first.json();
    const preview = await app.inject({
      method: "GET",
      url: `/api/system/backups/${manifest.id}/preview`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      valid: true,
      hashMatches: true,
      integrityCheck: "ok",
      foreignKeyViolations: 0,
      counts: { projects: 1 },
    });
    expect(
      readdirSync(join(workspace!, "external-backups")).filter((file) =>
        file.includes(".partial"),
      ),
    ).toEqual([]);
    const targetDirectory = join(workspace!, "restored-data");
    const restored = await app.inject({
      method: "POST",
      url: `/api/system/backups/${manifest.id}/restore`,
      payload: { targetDirectory, overwrite: false },
    });
    expect(restored.statusCode).toBe(201);
    const receipt = restored.json();
    expect(sha256(readFileSync(receipt.databasePath))).toBe(manifest.sha256);
    expect(
      readdirSync(targetDirectory).filter((file) => file.includes(".partial")),
    ).toEqual([]);
    const linkedTarget = join(workspace!, "linked-data");
    symlinkSync(
      join(workspace!, "data"),
      linkedTarget,
      process.platform === "win32" ? "junction" : "dir",
    );
    const linkedRestore = await app.inject({
      method: "POST",
      url: `/api/system/backups/${manifest.id}/restore`,
      payload: { targetDirectory: linkedTarget, overwrite: true },
    });
    expect(linkedRestore.statusCode).toBe(422);
    expect(linkedRestore.json()).toMatchObject({
      error: { code: "backup.restore.link_forbidden" },
    });
    const restoredDatabase = new NodeNarrativeDatabase(receipt.databasePath);
    try {
      expect(restoredDatabase.currentMigration()).toBe(40);
      expect(
        Number(
          (
            restoredDatabase.raw
              .prepare("SELECT COUNT(*) AS count FROM projects")
              .get() as { count: number }
          ).count,
        ),
      ).toBe(1);
    } finally {
      restoredDatabase.close();
    }

    await app.inject({
      method: "POST",
      url: "/api/system/backups",
      payload: { label: "第二份" },
    });
    await app.inject({
      method: "POST",
      url: "/api/system/backups",
      payload: { label: "第三份" },
    });
    const listed = await app.inject({
      method: "GET",
      url: "/api/system/backups",
    });
    expect(listed.json()).toHaveLength(2);
  });

  it("keeps the previous database when restored file installation fails", () => {
    workspace = mkdtempSync(join(tmpdir(), "narrative-restore-rollback-"));
    const databasePath = join(workspace, "narralume.sqlite");
    const replacementPath = join(workspace, "replacement.sqlite");
    writeFileSync(databasePath, "previous", "utf8");
    writeFileSync(replacementPath, "replacement", "utf8");

    expect(() =>
      replaceDatabaseFile(replacementPath, databasePath, (source, target) => {
        if (source === replacementPath)
          throw new Error("injected install failure");
        renameSync(source, target);
      }),
    ).toThrow("original database was rolled back");
    expect(readFileSync(databasePath, "utf8")).toBe("previous");
    expect(readFileSync(replacementPath, "utf8")).toBe("replacement");
  });

  it("reports orphaned databases and corrupt manifests instead of hiding them", async () => {
    ({ app, workspace } = await setup());
    const created = await app.inject({
      method: "POST",
      url: "/api/system/backups",
      payload: { label: "异常扫描" },
    });
    const manifest = created.json() as { id: string };
    const backupDirectory = join(workspace!, "external-backups");
    const orphanPath = join(backupDirectory, "orphan.sqlite");
    writeFileSync(orphanPath, "orphan", "utf8");
    const orphaned = await app.inject({
      method: "GET",
      url: "/api/system/backups",
    });
    expect(orphaned.statusCode).toBe(422);
    expect(orphaned.json()).toMatchObject({
      error: { code: "backup.orphan_detected" },
    });
    rmSync(orphanPath);

    writeFileSync(
      join(backupDirectory, `${manifest.id}.manifest.json`),
      "{invalid",
      "utf8",
    );
    const corrupt = await app.inject({
      method: "GET",
      url: "/api/system/backups",
    });
    expect(corrupt.statusCode).toBe(422);
    expect(corrupt.json()).toMatchObject({
      error: { code: "backup.manifest_corrupt" },
    });
  });
});

async function setup(retention = 10) {
  const workspace = realpathSync.native(
    mkdtempSync(join(tmpdir(), "narrative-lifecycle-")),
  );
  const dataDirectory = join(workspace, "data");
  const config: ServerConfig = {
    dataDirectory,
    databasePath: join(dataDirectory, "narralume.sqlite"),
    backupDirectory: join(workspace, "external-backups"),
    backupRetention: retention,
    host: "127.0.0.1",
    port: 4317,
    environment: "test",
  };
  const app = await buildApp({ config, enableRunWorker: false, logger: false });
  return { app, workspace };
}

async function createProject(app: FastifyInstance, title: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      requestId: globalThis.crypto.randomUUID(),
      title,
      premise: "一份用于验证迁移与恢复的故事。",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as {
    id: string;
    title: string;
    subtitle: string | null;
    premise: string | null;
    updatedAt: string;
  };
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
