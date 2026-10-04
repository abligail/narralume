import type { ContextSource } from "@narralume/context";
import type { NarrativeSummary, OutlineNode } from "@narralume/domain";

export interface OutlineContextRequest {
  projectId: string;
  outline: readonly OutlineNode[];
  chapterSummaries?: readonly NarrativeSummary[];
  targetOutlineNodeId?: string | null;
  nearBefore?: number;
  nearAfter?: number;
  farChunkSize?: number;
}

/** Creates independently budgetable near/mid/far outline sources. */
export function outlineContextSources(
  request: OutlineContextRequest,
): ContextSource[] {
  // The repository supplies depth-first sibling-ordinal order. Paths contain
  // opaque IDs, not sortable chapter numbers; preserve the manuscript order.
  const ordered = request.outline.filter((node) => node.status !== "abandoned");
  const byId = new Map(ordered.map((node) => [node.id, node]));
  const chapters = ordered.filter((node) => node.kind === "chapter");
  const summaryByScope = new Map(
    (request.chapterSummaries ?? []).map((summary) => [
      summary.scopeId,
      summary.summary,
    ]),
  );
  const explicitTarget = request.targetOutlineNodeId
    ? byId.get(request.targetOutlineNodeId)
    : null;
  const targetChapter =
    explicitTarget?.kind === "chapter"
      ? explicitTarget
      : explicitTarget?.parentId
        ? nearestChapter(explicitTarget, byId)
        : ([...chapters]
            .reverse()
            .find((chapter) => chapter.status !== "abandoned") ?? null);
  const targetIndex = targetChapter
    ? chapters.findIndex((chapter) => chapter.id === targetChapter.id)
    : Math.max(0, chapters.length - 1);
  const nearBefore = bounded(request.nearBefore, 8, 0, 50);
  const nearAfter = bounded(request.nearAfter, 4, 0, 50);
  const nearStart = Math.max(0, targetIndex - nearBefore);
  const nearEnd = Math.min(chapters.length, targetIndex + nearAfter + 1);
  const near = chapters.slice(nearStart, nearEnd);
  const nearIds = new Set(near.map((node) => node.id));

  const sources: ContextSource[] = [];
  const structural = ordered.filter(
    (node) =>
      ["book", "volume", "arc"].includes(node.kind) ||
      isAncestorOfTarget(node, explicitTarget),
  );
  if (structural.length > 0) {
    sources.push({
      id: "outline:structure",
      kind: "outline",
      label: "全书结构与当前路径",
      content: structural.map((node) => outlineLine(node)).join("\n"),
      summary: structural
        .map((node) => `- [${node.kind}] ${node.title}`)
        .join("\n"),
      authority: "confirmed",
      priority: 88,
      sourceType: "outline_structure",
      sourceId: request.projectId,
    });
  }
  if (near.length > 0) {
    sources.push({
      id: "outline:near",
      kind: "outline",
      label: "当前章节附近的详细航线",
      content: near
        .map((node) => chapterLine(node, summaryByScope.get(node.id)))
        .join("\n"),
      summary: near
        .map(
          (node) =>
            `- ${node.title}${summaryByScope.get(node.id) ? `：${clip(summaryByScope.get(node.id)!, 160)}` : ""}`,
        )
        .join("\n"),
      authority: "reference",
      priority: 90,
      sourceType: "outline_near",
      sourceId: targetChapter?.id ?? request.projectId,
    });
  }

  const far = chapters.filter((chapter) => !nearIds.has(chapter.id));
  const chunkSize = bounded(request.farChunkSize, 40, 10, 100);
  for (let index = 0; index < far.length; index += chunkSize) {
    const chunk = far.slice(index, index + chunkSize);
    sources.push({
      id: `outline:far:${Math.floor(index / chunkSize)}`,
      kind: "outline",
      label: `远距章节地图 ${index + 1}-${index + chunk.length}`,
      content: chunk
        .map((node) => chapterLine(node, summaryByScope.get(node.id), true))
        .join("\n"),
      summary: [chunk[0], chunk.at(-1)]
        .filter((node): node is OutlineNode => Boolean(node))
        .map((node) => `- ${node.title}｜${node.status}`)
        .join("\n"),
      authority: "reference",
      priority: 64,
      sourceType: "outline_far",
      sourceId: request.projectId,
    });
  }
  return sources;
}

function nearestChapter(
  node: OutlineNode,
  byId: ReadonlyMap<string, OutlineNode>,
): OutlineNode | null {
  let current: OutlineNode | undefined = node;
  while (current) {
    if (current.kind === "chapter") return current;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return null;
}

function isAncestorOfTarget(
  node: OutlineNode,
  target: OutlineNode | null | undefined,
): boolean {
  return Boolean(target && target.path.startsWith(`${node.path}/`));
}

function outlineLine(node: OutlineNode): string {
  return `${"  ".repeat(node.depth)}- [${node.kind}｜${node.status}] [node:${node.id}] ${node.title}${node.summary ? `｜计划摘要：${node.summary}` : ""}${node.goal ? `｜计划目标：${node.goal}` : ""}${node.outcome ? `｜计划结果（须以正文核实）：${node.outcome}` : ""}`;
}

function chapterLine(
  node: OutlineNode,
  committedSummary?: string,
  compact = false,
): string {
  const summary = committedSummary ?? node.summary;
  if (compact)
    return `- [${node.status}] [node:${node.id}] ${node.title}${summary ? `｜${committedSummary ? "已写摘要（检索索引）" : "计划摘要（尚非正文事实）"}：${clip(summary, 240)}` : ""}`;
  return [
    `- [${node.status}] [node:${node.id}] ${node.title}`,
    summary
      ? `  ${committedSummary ? "已写摘要（检索索引）" : "计划摘要（尚非正文事实）"}：${summary}`
      : "",
    node.goal ? `  计划目标：${node.goal}` : "",
    node.conflict ? `  冲突：${node.conflict}` : "",
    node.outcome ? `  计划结果（须以正文核实）：${node.outcome}` : "",
    node.storyTime ? `  故事时间：${node.storyTime}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function clip(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function bounded(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.min(Math.trunc(value!), maximum))
    : fallback;
}
