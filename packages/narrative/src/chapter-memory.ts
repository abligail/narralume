import { z } from "zod";
import type { ContextSource } from "@narralume/context";
import type { NarrativeSummary } from "@narralume/domain";
import { ParagraphLocator } from "./paragraph-locator.js";
import { GroundedSettlementSchema } from "./schemas.js";
import { selectEditorialSources } from "./editorial-grounding.js";

export interface MemoryChapter {
  chapterId: string;
  chapterNumber: number;
  title: string;
  versionId: string;
  sourceHash: string;
  content: string;
  summary: string;
  summaryPoints: ReturnType<typeof currentSummaryPoints>;
}

/** Version freshness and verbatim evidence are checked separately from model interpretation. */
export function currentSummaryPoints(
  summary: NarrativeSummary | null,
  locator: ParagraphLocator,
) {
  if (summary?.sourceHash !== locator.contentHash) return [];
  const parsed = GroundedSettlementSchema.shape.summaryPoints.safeParse(
    summary.stateDelta.summaryPoints,
  );
  if (!parsed.success) return [];
  return parsed.data.filter(
    (point) =>
      point.evidence.length === point.evidenceParagraphs.length &&
      point.evidence.every((citation, index) => {
        const paragraph = locator.paragraphs.find(
          (p) => p.ordinal === point.evidenceParagraphs[index],
        );
        return (
          paragraph &&
          citation.paragraphOrdinal === paragraph.ordinal &&
          citation.documentVersionId === locator.documentVersionId &&
          citation.contentHash === locator.contentHash &&
          citation.start === paragraph.start &&
          citation.end === paragraph.end &&
          citation.quote === paragraph.quote
        );
      }),
  );
}

export const MemoryCitationSchema = z
  .object({
    chapterId: z.string().min(1),
    paragraphOrdinal: z.number().int().positive(),
    quote: z.string().trim().min(1),
  })
  .strict();
export const MemoryObservationSchema = z
  .object({
    text: z.string().trim().min(1).max(2_000),
    basis: z.enum(["observed", "reported", "inferred", "unresolved"]),
    citations: z.array(MemoryCitationSchema).min(1).max(5),
  })
  .strict();
export type MemoryCitation = z.infer<typeof MemoryCitationSchema>;

export function memorySummarySources(
  chapters: readonly MemoryChapter[],
  requiredChapterId?: string,
): ContextSource[] {
  return chapters
    .filter((chapter) => chapter.summaryPoints.length)
    .map((chapter, index): ContextSource => ({
      id: `memory-points:${chapter.chapterId}`,
      kind: "summary",
      label: "带原文引用的章节关键进展",
      authority: "reference",
      priority: 93 + (index + 1) / chapters.length,
      required: chapter.chapterId === requiredChapterId,
      compressible: false,
      sourceType: "narrative_summary",
      sourceId: chapter.chapterId,
      content: JSON.stringify({
        chapterId: chapter.chapterId,
        chapterNumber: chapter.chapterNumber,
        versionId: chapter.versionId,
        sourceHash: chapter.sourceHash,
        summaryPoints: chapter.summaryPoints.map(
          ({ text, basis, evidenceParagraphs }) => ({
            text,
            basis,
            evidenceParagraphs,
          }),
        ),
        evidence: [
          ...new Map(
            chapter.summaryPoints.flatMap(({ evidence }) =>
              evidence.map(
                (citation) => [citation.paragraphOrdinal, citation] as const,
              ),
            ),
          ).values(),
        ].toSorted((a, b) => a.paragraphOrdinal - b.paragraphOrdinal),
      }),
    }));
}

/** Full recent chapters compete by recency; the latest is required. Older passages retain stable paragraph numbers. */
export function memoryManuscriptSources(
  chapters: readonly MemoryChapter[],
  recentCount: number,
  query: string,
): ContextSource[] {
  const recent = new Set(
    chapters.slice(-recentCount).map((chapter) => chapter.chapterId),
  );
  const selected = selectEditorialSources(
    chapters
      .filter((chapter) => !recent.has(chapter.chapterId))
      .toReversed()
      .map((chapter) => ({
        id: chapter.chapterId,
        kind: "manuscript" as const,
        version: chapter.versionId,
        content: new ParagraphLocator(chapter.content).render(),
      })),
    query,
    Number.POSITIVE_INFINITY,
  );
  const ordinals = new Map<string, Set<number>>();
  let remaining = 24_000;
  for (const passage of selected) {
    const match = /^(.*):passage:(\d+)$/u.exec(passage.id);
    if (!match) continue;
    const chapter = chapters.find((c) => c.chapterId === match[1]);
    if (!chapter) continue;
    const paragraphs = new ParagraphLocator(chapter.content).paragraphs;
    const index = Number(match[2]);
    const set = ordinals.get(chapter.chapterId) ?? new Set<number>();
    const added = [index, index + 1, index + 2].filter(
      (ordinal) =>
        ordinal > 0 && ordinal <= paragraphs.length && !set.has(ordinal),
    );
    const cost = added.reduce(
      (size, ordinal) => size + paragraphs[ordinal - 1]!.quote.length,
      0,
    );
    if (cost > remaining) continue;
    for (const ordinal of added) set.add(ordinal);
    remaining -= cost;
    ordinals.set(chapter.chapterId, set);
  }
  return chapters.flatMap((chapter, index): ContextSource[] => {
    const locator = new ParagraphLocator(chapter.content, {
      documentVersionId: chapter.versionId,
    });
    const included = recent.has(chapter.chapterId)
      ? locator.paragraphs.map((p) => p.ordinal)
      : [...(ordinals.get(chapter.chapterId) ?? [])].sort((a, b) => a - b);
    if (!included.length) return [];
    return [
      {
        id: `memory-manuscript:${chapter.chapterId}`,
        kind: "recent-text",
        label: "已提交正文原文（带段号）",
        authority: "confirmed",
        priority: 94 + (index + 1) / chapters.length,
        required:
          recent.has(chapter.chapterId) &&
          chapter.chapterId === chapters.at(-1)?.chapterId,
        compressible: false,
        sourceType: "document_version",
        sourceId: chapter.chapterId,
        content: JSON.stringify({
          chapterId: chapter.chapterId,
          chapterNumber: chapter.chapterNumber,
          title: chapter.title,
          versionId: chapter.versionId,
          sourceHash: chapter.sourceHash,
          complete: included.length === locator.paragraphs.length,
          paragraphs: included.map((ordinal) => ({
            ordinal,
            text: locator.paragraphs[ordinal - 1]!.quote,
          })),
        }),
      },
    ];
  });
}

export function validateMemoryCitations(
  citations: readonly MemoryCitation[],
  sources: readonly ContextSource[],
  path = "citations",
): string[] {
  return citations.flatMap((citation, index) => {
    const source = sources.find(
      (s) => s.id === `memory-manuscript:${citation.chapterId}`,
    );
    const paragraphs = source
      ? (
          JSON.parse(source.content) as {
            paragraphs: { ordinal: number; text: string }[];
          }
        ).paragraphs
      : [];
    const paragraph = paragraphs.find(
      (p) => p.ordinal === citation.paragraphOrdinal,
    );
    if (!source)
      return [
        `${path}.${index}: Evidence chapter ${citation.chapterId} was not supplied as manuscript prose`,
      ];
    if (!paragraph)
      return [
        `${path}.${index}: Evidence paragraph ${citation.chapterId} P${citation.paragraphOrdinal} was not supplied; use a provided paragraph ordinal`,
      ];
    return paragraph.text.includes(citation.quote)
      ? []
      : [
          `${path}.${index}: Evidence quote ${JSON.stringify(citation.quote)} is not exact in ${citation.chapterId} P${citation.paragraphOrdinal}. Copy a contiguous substring of this paragraph: ${paragraph.text}`,
        ];
  });
}

export function bindMemoryCitations(
  citations: readonly MemoryCitation[],
  chapters: readonly MemoryChapter[],
) {
  return citations.map((citation) => {
    const chapter = chapters.find((c) => c.chapterId === citation.chapterId)!;
    const locator = new ParagraphLocator(chapter.content, {
      documentVersionId: chapter.versionId,
    });
    const paragraph = locator.locate([citation.paragraphOrdinal])[0]!;
    const start = paragraph.start + paragraph.quote.indexOf(citation.quote);
    return {
      ...citation,
      start,
      end: start + citation.quote.length,
      documentVersionId: chapter.versionId,
      contentHash: chapter.sourceHash,
    };
  });
}
