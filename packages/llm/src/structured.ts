import { ModelError } from "./error.js";
import type { ModelGateway } from "./gateway.js";
import type {
  JsonSchemaContract,
  ModelRequest,
  ModelResponse,
  NormalizedUsage,
  StreamOptions,
  StructuredAttemptMode,
  StructuredMode,
} from "./types.js";
import { EMPTY_USAGE } from "./types.js";

export type ValidationResult<T> =
  { success: true; data: T } | { success: false; issues: readonly string[] };

export type StructuredValidator<T> = (value: unknown) => ValidationResult<T>;

export interface StructuredGenerationOptions extends StreamOptions {
  maxRepairAttempts?: number;
  preferPrompt?: boolean;
  /** Explicit capability-derived tier allow-list. */
  allowedModes?: readonly StructuredMode[];
  onAttempt?: (event: {
    attempt: number;
    mode: StructuredAttemptMode;
    valid: boolean;
    issues: readonly string[];
  }) => void;
}

export interface StructuredGenerationResult<T> {
  value: T;
  response: ModelResponse;
  mode: StructuredAttemptMode;
  attempts: number;
  usage: NormalizedUsage;
}

/** 校验失败是随机采样问题：换个重掷很可能过，值得 step 级退避重试；
 *  重试预算由配方 maxAttempts × harness 重试策略封顶。 */
export class StructuredOutputError extends ModelError {
  readonly attempts: number;
  readonly validationIssues: readonly string[];
  readonly usage: NormalizedUsage;
  readonly invalidText: string | null;
  readonly finishReason: ModelResponse["finishReason"] | null;

  constructor(
    message: string,
    attempts: number,
    validationIssues: readonly string[],
    usage: NormalizedUsage = { ...EMPTY_USAGE },
    invalidText: string | null = null,
    finishReason: ModelResponse["finishReason"] | null = null,
  ) {
    super(message, { category: "protocol", retryable: true });
    this.name = "StructuredOutputError";
    this.attempts = attempts;
    this.validationIssues = validationIssues;
    this.usage = usage;
    this.invalidText = invalidText;
    this.finishReason = finishReason;
  }
}

export async function generateStructured<T>(
  gateway: ModelGateway,
  request: ModelRequest,
  validate: StructuredValidator<T>,
  options: StructuredGenerationOptions = {},
): Promise<StructuredGenerationResult<T>> {
  if (!request.responseSchema) {
    throw new StructuredOutputError(
      "Structured call is missing responseSchema",
      0,
      ["missing schema"],
    );
  }
  const maxRepairs = Math.max(0, Math.min(options.maxRepairAttempts ?? 1, 3));
  let attempts = 0;
  let lastResponse: ModelResponse | undefined;
  let lastIssues: readonly string[] = [];
  let totalUsage: NormalizedUsage = { ...EMPTY_USAGE };
  const allowedModes = new Set<StructuredMode>(
    options.allowedModes ?? ["native", "json-mode", "prompt"],
  );

  if (allowedModes.size === 0) {
    throw new StructuredOutputError(
      "Model configuration explicitly declares no supported structured output mode",
      0,
      ["structured output capability unavailable"],
    );
  }

  if (!options.preferPrompt) {
    if (allowedModes.has("native")) {
      attempts += 1;
      try {
        const response = await gateway.generate(request, {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          stream: options.stream ?? false,
        });
        lastResponse = response;
        totalUsage = addUsage(totalUsage, response.usage);
        const checked = parseAndValidate(response.text, validate);
        options.onAttempt?.({
          attempt: attempts,
          mode: "native",
          valid: checked.success,
          issues: checked.success ? [] : checked.issues,
        });
        if (checked.success) {
          return {
            value: checked.data,
            response,
            mode: "native",
            attempts,
            usage: totalUsage,
          };
        }
        lastIssues = checked.issues;
      } catch (error) {
        if (!isStructuredOutputCompatibilityError(error)) throw error;
        lastIssues = [error instanceof Error ? error.message : String(error)];
        options.onAttempt?.({
          attempt: attempts,
          mode: "native",
          valid: false,
          issues: lastIssues,
        });
      }
    }

    // Middle tier: provider JSON mode (json_object). Adapters without JSON
    // mode (e.g. Anthropic) report it unsupported and skip straight to prompt.
    if (
      allowedModes.has("json-mode") &&
      gateway.supportsStructuredMode("json-mode")
    ) {
      attempts += 1;
      try {
        const response = await gateway.generate(
          { ...request, structuredMode: "json-mode" },
          {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            stream: options.stream ?? false,
          },
        );
        lastResponse = response;
        totalUsage = addUsage(totalUsage, response.usage);
        const checked = parseAndValidate(response.text, validate);
        options.onAttempt?.({
          attempt: attempts,
          mode: "json-mode",
          valid: checked.success,
          issues: checked.success ? [] : checked.issues,
        });
        if (checked.success) {
          return {
            value: checked.data,
            response,
            mode: "json-mode",
            attempts,
            usage: totalUsage,
          };
        }
        lastIssues = checked.issues;
      } catch (error) {
        if (!isStructuredOutputCompatibilityError(error)) throw error;
        lastIssues = [error instanceof Error ? error.message : String(error)];
        options.onAttempt?.({
          attempt: attempts,
          mode: "json-mode",
          valid: false,
          issues: lastIssues,
        });
      }
    }
  }

  if (!allowedModes.has("prompt")) {
    throw new StructuredOutputError(
      `Structured output failed validation after ${attempts} allowed tier attempts`,
      attempts,
      lastIssues.length > 0
        ? lastIssues
        : ["no allowed fallback tier remained"],
      totalUsage,
      lastResponse?.text ?? null,
      lastResponse?.finishReason ?? null,
    );
  }

  attempts += 1;
  const promptResponse = await gateway.generate(
    promptFallbackRequest(request),
    {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      stream: options.stream ?? false,
    },
  );
  lastResponse = promptResponse;
  totalUsage = addUsage(totalUsage, promptResponse.usage);
  const promptChecked = parseAndValidate(promptResponse.text, validate);
  options.onAttempt?.({
    attempt: attempts,
    mode: "prompt",
    valid: promptChecked.success,
    issues: promptChecked.success ? [] : promptChecked.issues,
  });
  if (promptChecked.success) {
    return {
      value: promptChecked.data,
      response: promptResponse,
      mode: "prompt",
      attempts,
      usage: totalUsage,
    };
  }
  lastIssues = promptChecked.issues;

  for (let repair = 0; repair < maxRepairs; repair += 1) {
    attempts += 1;
    const response = await gateway.generate(
      repairRequest(
        request,
        lastResponse.text,
        lastIssues,
        request.responseSchema,
      ),
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        stream: options.stream ?? false,
      },
    );
    lastResponse = response;
    totalUsage = addUsage(totalUsage, response.usage);
    const checked = parseAndValidate(response.text, validate);
    options.onAttempt?.({
      attempt: attempts,
      mode: "repair",
      valid: checked.success,
      issues: checked.success ? [] : checked.issues,
    });
    if (checked.success) {
      return {
        value: checked.data,
        response,
        mode: "repair",
        attempts,
        usage: totalUsage,
      };
    }
    lastIssues = checked.issues;
  }

  throw new StructuredOutputError(
    `Structured output failed validation after ${attempts} attempts`,
    attempts,
    lastIssues,
    totalUsage,
    lastResponse?.text ?? null,
    lastResponse?.finishReason ?? null,
  );
}

/** Converts persisted capability flags into the exact tier plan. */
export function structuredTierPlan(
  capabilities: Readonly<Record<string, boolean>>,
): StructuredMode[] {
  if (capabilities.structuredOutput === false) return [];
  const modes: StructuredMode[] = [];
  if (capabilities.structuredOutputNative === true) modes.push("native");
  if (capabilities.structuredOutputJsonMode === true) modes.push("json-mode");
  modes.push("prompt");
  return modes;
}

function addUsage(
  left: NormalizedUsage,
  right: NormalizedUsage,
): NormalizedUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

function parseAndValidate<T>(
  text: string,
  validate: StructuredValidator<T>,
): ValidationResult<T> {
  try {
    const parsed = JSON.parse(stripSingleJsonFence(text)) as unknown;
    return validate(parsed);
  } catch (error) {
    return {
      success: false,
      issues: [
        error instanceof Error
          ? `JSON parse: ${error.message}`
          : "JSON parse failed",
      ],
    };
  }
}

function promptFallbackRequest(request: ModelRequest): ModelRequest {
  const schema = request.responseSchema as JsonSchemaContract;
  const requestWithoutSchema = { ...request };
  delete requestWithoutSchema.responseSchema;
  return {
    ...requestWithoutSchema,
    instructions: joinInstructions(
      request.instructions,
      structuredInstruction(schema, "Return the requested result now."),
    ),
  };
}

function repairRequest(
  request: ModelRequest,
  invalidText: string,
  issues: readonly string[],
  schema: JsonSchemaContract,
): ModelRequest {
  const boundedInvalidText = invalidText.slice(0, 16_384);
  const boundedIssues = issues.slice(0, 20).join("; ").slice(0, 4_096);
  const requestWithoutSchema = { ...request };
  delete requestWithoutSchema.responseSchema;
  return {
    ...requestWithoutSchema,
    instructions: joinInstructions(
      request.instructions,
      structuredInstruction(
        schema,
        `The prior output was invalid. Validation issues: ${boundedIssues}. Repair it.`,
      ),
    ),
    messages: [
      ...request.messages,
      { role: "assistant", content: boundedInvalidText },
      {
        role: "user",
        content:
          "Return the corrected JSON value only. Do not explain the repair.",
      },
    ],
  };
}

function structuredInstruction(
  schema: JsonSchemaContract,
  task: string,
): string {
  return [
    "Return exactly one JSON value with no Markdown fence or commentary.",
    `The JSON must satisfy this schema named ${schema.name}:`,
    JSON.stringify(schema.schema),
    task,
  ].join("\n");
}

function joinInstructions(...parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join("\n\n");
}

function stripSingleJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function isStructuredOutputCompatibilityError(error: unknown): boolean {
  if (!(error instanceof ModelError) || error.category !== "invalid_request")
    return false;
  const message = error.message.toLowerCase();
  return [
    "response_format",
    "json_schema",
    "json_object",
    "structured",
    "output_format",
    "output config",
  ].some((needle) => message.includes(needle));
}
