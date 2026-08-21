import { randomUuid, sha256Hex } from "@narralume/domain";

import { estimateTokens } from "./token-estimator.js";
import type {
  CompiledContext,
  CompiledContextSection,
  ContextAuthority,
  ContextCompileRequest,
  ContextReceiptEntry,
  ContextSource,
} from "./types.js";

const KIND_ORDER: Readonly<Record<ContextSource["kind"], number>> = {
  system: 0,
  "author-intent": 1,
  task: 2,
  canon: 3,
  outline: 4,
  "recent-text": 5,
  summary: 6,
  retrieval: 7,
  style: 8,
  session: 9,
};

const AUTHORITY_RANK: Readonly<Record<ContextAuthority, number>> = {
  system: 5,
  locked: 4,
  confirmed: 3,
  candidate: 2,
  reference: 1,
  ephemeral: 0,
};

export class ContextCompiler {
  constructor(private readonly now: () => Date = () => new Date()) {}

  compile(request: ContextCompileRequest): CompiledContext {
    validateBudget(request);
    const available = calculateAvailable(request.budget);
    const entries: ContextReceiptEntry[] = [];
    const sections: CompiledContextSection[] = [];
    let remaining = available;

    const sources = [...request.sources].sort(compareSources);
    const duplicateIds = duplicateSourceIds(sources);
    if (duplicateIds.length > 0) {
      throw new ContextCompileError(
        "context.source.duplicate",
        `Duplicate context source IDs: ${duplicateIds.join(", ")}`,
      );
    }

    for (const source of sources.filter((candidate) => candidate.required)) {
      const included = materialize(source, remaining, true);
      if (!included) {
        throw new ContextBudgetError(
          `Required context "${source.label}" exceeds the budget; needs ${estimateTokens(source.content)}, ${remaining} remaining`,
          available,
          remaining,
          source.id,
        );
      }
      sections.push(included.section);
      entries.push(included.receipt);
      remaining -= included.section.tokenEstimate;
    }

    for (const source of sources.filter((candidate) => !candidate.required)) {
      const included = materialize(source, remaining, false);
      if (included) {
        sections.push(included.section);
        entries.push(included.receipt);
        remaining -= included.section.tokenEstimate;
      } else {
        entries.push({
          sourceId: source.id,
          kind: source.kind,
          label: source.label,
          authority: source.authority,
          status: "excluded",
          originalTokens: estimateTokens(source.content),
          finalTokens: 0,
          reason:
            "Insufficient budget; lower authority/priority than included sources",
          sourceType: source.sourceType,
          ...(source.sourceId === undefined
            ? {}
            : { provenanceId: source.sourceId }),
        });
      }
    }

    sections.sort(compareSections);
    const text = renderSections(sections);
    const used = available - remaining;
    const compiledHash = sha256Hex(text);
    return {
      sections,
      text,
      receipt: {
        id: randomUuid(),
        projectId: request.projectId,
        purpose: request.purpose,
        budget: { ...request.budget, available, used, remaining },
        entries,
        compiledHash,
        createdAt: this.now().toISOString(),
      },
    };
  }
}

export class ContextCompileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ContextCompileError";
  }
}

export class ContextBudgetError extends ContextCompileError {
  constructor(
    message: string,
    readonly available: number,
    readonly remaining: number,
    readonly sourceId: string,
  ) {
    super("context.budget.required_overflow", message);
    this.name = "ContextBudgetError";
  }
}

function materialize(
  source: ContextSource,
  remaining: number,
  required: boolean,
): { section: CompiledContextSection; receipt: ContextReceiptEntry } | null {
  const originalTokens = estimateTokens(source.content);
  const canCompress =
    source.compressible !== false && Boolean(source.summary?.trim());
  let content = source.content;
  let tokenEstimate = originalTokens;
  let compressed = false;

  if (originalTokens > remaining && canCompress) {
    const summary = source.summary?.trim() ?? "";
    const summaryTokens = estimateTokens(summary);
    if (summaryTokens <= remaining) {
      content = summary;
      tokenEstimate = summaryTokens;
      compressed = true;
    }
  }
  if (tokenEstimate > remaining) return null;
  const section: CompiledContextSection = {
    id: source.id,
    kind: source.kind,
    label: source.label,
    content,
    authority: source.authority,
    tokenEstimate,
    compressed,
    sourceType: source.sourceType,
    ...(source.sourceId === undefined ? {} : { sourceId: source.sourceId }),
  };
  return {
    section,
    receipt: {
      sourceId: source.id,
      kind: source.kind,
      label: source.label,
      authority: source.authority,
      status: compressed ? "compressed" : "included",
      originalTokens,
      finalTokens: tokenEstimate,
      reason: compressed
        ? "Full text exceeded the remaining budget; using the existing deterministic summary"
        : required
          ? "Required source"
          : "Included by authority and priority",
      sourceType: source.sourceType,
      ...(source.sourceId === undefined
        ? {}
        : { provenanceId: source.sourceId }),
    },
  };
}

function calculateAvailable(budget: ContextCompileRequest["budget"]): number {
  const safety = budget.safetyReserve ?? Math.ceil(budget.contextWindow * 0.05);
  return (
    budget.contextWindow -
    budget.outputReserve -
    budget.fixedInstructionReserve -
    budget.toolReserve -
    budget.schemaReserve -
    safety
  );
}

function validateBudget(request: ContextCompileRequest): void {
  const fields = Object.entries(request.budget);
  for (const [name, value] of fields) {
    if (!Number.isInteger(value) || value < 0) {
      throw new ContextCompileError(
        "context.budget.invalid",
        `Budget ${name} must be a non-negative integer`,
      );
    }
  }
  if (
    request.budget.contextWindow <= 0 ||
    calculateAvailable(request.budget) <= 0
  ) {
    throw new ContextCompileError(
      "context.budget.no_capacity",
      "No context space remains after reserved budgets",
    );
  }
}

function compareSources(left: ContextSource, right: ContextSource): number {
  if (Boolean(left.required) !== Boolean(right.required))
    return left.required ? -1 : 1;
  return (
    AUTHORITY_RANK[right.authority] - AUTHORITY_RANK[left.authority] ||
    right.priority - left.priority ||
    KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
    left.id.localeCompare(right.id)
  );
}

function compareSections(
  left: CompiledContextSection,
  right: CompiledContextSection,
): number {
  return (
    KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
    left.id.localeCompare(right.id)
  );
}

function renderSections(sections: readonly CompiledContextSection[]): string {
  return sections
    .map(
      (section) =>
        `<context-section id=${JSON.stringify(section.id)} kind=${JSON.stringify(section.kind)} authority=${JSON.stringify(section.authority)} label=${JSON.stringify(section.label)}>\n${section.content}\n</context-section>`,
    )
    .join("\n\n");
}

function duplicateSourceIds(sources: readonly ContextSource[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.id)) duplicates.add(source.id);
    seen.add(source.id);
  }
  return [...duplicates];
}
