/* 长篇推演：语义检索、剧情预测、故事记忆与变更影响预演。 */

import "../styles/lab.css";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LONG_NOVEL_LIMITS } from "@narralume/contracts";
import { Search, Send } from "lucide-react";
import { useState } from "react";

import { ErrorNote } from "../components/error-note";
import { PageBand } from "../components/page-band";
import { ProjectRequiredState } from "../components/project-required-state";
import { Skeleton } from "../components/skeleton";
import { getLocale, translate, useI18n, type MessageKey } from "../i18n";
import {
  consolidateNarrativeMemory,
  decidePlotPrediction,
  generatePlotPredictions,
  getNarrativeMemories,
  getPlotPredictions,
  previewDryRun,
  rebuildNarrativeMemories,
  searchProjectMemory,
  type DryRunResult,
  type PlotPrediction,
} from "../lib/api";
import { useProjectId } from "../lib/project-route";

const AUTHORITY_KEYS: Record<string, MessageKey> = {
  reference: "lab.authority.reference",
  draft: "lab.authority.draft",
  candidate: "lab.authority.candidate",
  confirmed: "lab.authority.confirmed",
  locked: "lab.authority.locked",
};

const PREDICTION_STATUS_KEYS: Record<string, MessageKey> = {
  candidate: "lab.predictions.status.candidate",
  adopted: "lab.predictions.status.adopted",
  dismissed: "lab.predictions.status.dismissed",
};

function authorityLabel(authority: string): string | undefined {
  const key = AUTHORITY_KEYS[authority];
  return key ? translate(getLocale(), key) : undefined;
}

function predictionStatusLabel(status: string): string | undefined {
  const key = PREDICTION_STATUS_KEYS[status];
  return key ? translate(getLocale(), key) : undefined;
}

export function LabWorkspace() {
  const projectId = useProjectId();
  const queryClient = useQueryClient();
  const { t } = useI18n();

  const [searchInput, setSearchInput] = useState("");
  const [dryrunInput, setDryrunInput] = useState("");
  const [dryrunResult, setDryrunResult] = useState<DryRunResult | null>(null);
  const [flashPrediction, setFlashPrediction] = useState<string | null>(null);

  const predictionsQuery = useQuery({
    queryKey: ["project", projectId, "lab", "predictions"],
    queryFn: ({ signal }) => getPlotPredictions(projectId!, signal),
    enabled: Boolean(projectId),
  });

  const memoriesQuery = useQuery({
    queryKey: ["project", projectId, "lab", "memories"],
    queryFn: ({ signal }) => getNarrativeMemories(projectId!, false, signal),
    enabled: Boolean(projectId),
  });

  const searchMutation = useMutation({
    mutationFn: (query: string) =>
      searchProjectMemory(projectId!, { query, limit: 8 }),
  });

  const dryrunMutation = useMutation({
    mutationFn: (change: string) => previewDryRun(projectId!, change),
    onSuccess: (result) => setDryrunResult(result),
  });

  const predictionMutation = useMutation({
    mutationFn: (input: { prediction: PlotPrediction; adopted: boolean }) =>
      decidePlotPrediction(
        projectId!,
        input.prediction.id,
        input.adopted ? "adopted" : "dismissed",
      ),
    onSuccess: (prediction, input) => {
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "lab", "predictions"] });
      setFlashPrediction(
        translate(getLocale(), "lab.predictions.flash", {
          status: predictionStatusLabel(input.adopted ? "adopted" : "dismissed") ?? "",
          title: prediction.title,
        }),
      );
      window.setTimeout(() => setFlashPrediction(null), 2000);
    },
  });

  const generationMutation = useMutation({
    mutationFn: (input: { direction: string; horizon: number; count: number }) =>
      generatePlotPredictions(projectId!, input),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "lab", "predictions"] }),
  });

  const memoryMutation = useMutation({
    mutationFn: (action: "rebuild" | "consolidate"): Promise<unknown> =>
      action === "rebuild"
        ? rebuildNarrativeMemories(projectId!)
        : consolidateNarrativeMemory(projectId!),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "lab", "memories"] }),
  });

  const predictions = predictionsQuery.data;
  const memories = memoriesQuery.data;

  if (!projectId) {
    return (
      <div className="lab">
        <ProjectRequiredState
          seal={t("lab.missing.seal")}
          title={t("lab.title")}
          description={t("lab.missing.description")}
        />
      </div>
    );
  }

  return (
    <div className="lab">
      <PageBand index="LOOM · L2" title={t("lab.title")} meta={<span>{t("lab.meta")}</span>} />

      <div className="lab__layout">
        <div className="lab__column">
          <LabActions
            generationPending={generationMutation.isPending}
            generationError={generationMutation.error}
            memoryPending={memoryMutation.isPending}
            memoryError={memoryMutation.error}
            onGenerate={(input) => generationMutation.mutate(input)}
            onMemory={(action) => memoryMutation.mutate(action)}
          />
          <SearchChamber
            searchInput={searchInput}
            setSearchInput={setSearchInput}
            searchMutation={searchMutation}
          />
          <DryRun
            input={dryrunInput}
            setInput={setDryrunInput}
            onSubmit={(change) => dryrunMutation.mutate(change)}
            result={dryrunResult}
            pending={dryrunMutation.isPending}
            isError={dryrunMutation.isError}
            error={dryrunMutation.error}
          />
        </div>

        <Predictions
          predictions={predictions}
          isPending={predictionsQuery.isPending}
          isError={predictionsQuery.isError}
          error={predictionsQuery.error}
          pending={predictionMutation.isPending}
          flash={flashPrediction}
          onAdopt={(p) =>
            predictionMutation.mutate({ prediction: p, adopted: true })
          }
          onDismiss={(p) =>
            predictionMutation.mutate({ prediction: p, adopted: false })
          }
          memories={memories ?? []}
          memoriesPending={memoriesQuery.isPending}
          memoriesError={memoriesQuery.error}
        />
      </div>
    </div>
  );
}

function LabActions({
  generationPending,
  generationError,
  memoryPending,
  memoryError,
  onGenerate,
  onMemory,
}: {
  generationPending: boolean;
  generationError: unknown;
  memoryPending: boolean;
  memoryError: unknown;
  onGenerate: (input: {
    direction: string;
    horizon: number;
    count: number;
  }) => void;
  onMemory: (action: "rebuild" | "consolidate") => void;
}) {
  const { t } = useI18n();
  const [direction, setDirection] = useState("");
  const [horizon, setHorizon] = useState(3);
  const [count, setCount] = useState(3);
  return (
    <section className="lab__actions">
      <header>
        <p className="lab__search-eyebrow">{t("lab.actions.eyebrow")}</p>
        <h2 className="lab__search-title">{t("lab.actions.title")}</h2>
      </header>
      <label className="lab__field">
        <span>{t("lab.actions.directionLabel")}</span>
        <textarea
          value={direction}
          onChange={(event) => setDirection(event.target.value)}
        />
      </label>
      <div className="lab__actions-row">
        <label className="lab__field">
          <span>{t("lab.actions.horizonLabel")}</span>
          <input
            type="number"
            min="1"
            max={LONG_NOVEL_LIMITS.predictionHorizon}
            value={horizon}
            onChange={(event) => setHorizon(Number(event.target.value))}
          />
        </label>
        <label className="lab__field">
          <span>{t("lab.actions.countLabel")}</span>
          <input
            type="number"
            min="1"
            max={LONG_NOVEL_LIMITS.predictionCount}
            value={count}
            onChange={(event) => setCount(Number(event.target.value))}
          />
        </label>
        <button
          type="button"
          className="btn btn--primary"
          disabled={generationPending || !direction.trim()}
          onClick={() =>
            onGenerate({ direction: direction.trim(), horizon, count })
          }
        >
          {generationPending ? t("lab.actions.generating") : t("lab.actions.generate")}
        </button>
      </div>
      <div className="lab__actions-row">
        <button
          type="button"
          className="btn"
          disabled={memoryPending}
          onClick={() => onMemory("rebuild")}
        >
          {t("lab.actions.rebuild")}
        </button>
        <button
          type="button"
          className="btn"
          disabled={memoryPending}
          onClick={() => onMemory("consolidate")}
        >
          {t("lab.actions.consolidate")}
        </button>
      </div>
      {generationError ? (
        <ErrorNote error={generationError} title={t("lab.actions.generateError")} />
      ) : null}
      {memoryError ? (
        <ErrorNote error={memoryError} title={t("lab.actions.memoryError")} />
      ) : null}
    </section>
  );
}

/* ---- 左：语义检索 -------------------------------------------------------- */

function SearchChamber({
  searchInput,
  setSearchInput,
  searchMutation,
}: {
  searchInput: string;
  setSearchInput: (v: string) => void;
  searchMutation: {
    mutate: (variable: string) => void;
    isPending: boolean;
    isError: boolean;
    error: unknown;
    data:
      | {
          id: string;
          title: string;
          content: string;
          authority: string;
          score: number;
          reasons: string[];
        }[]
      | undefined;
  };
}) {
  const { t } = useI18n();
  return (
    <div className="lab__search">
      <header>
        <p className="lab__search-eyebrow">{t("lab.search.eyebrow")}</p>
        <h2 className="lab__search-title">{t("lab.search.title")}</h2>
      </header>
      <div className="lab__search-form">
        <input
          type="search"
          className="lab__search-input"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t("lab.search.placeholder")}
          aria-label={t("lab.search.inputLabel")}
        />
        <button
          type="button"
          className="lab__search-btn"
          disabled={
            searchMutation.isPending || searchInput.trim() === ""
          }
          onClick={() => searchMutation.mutate(searchInput.trim())}
        >
          <Search size={14} strokeWidth={1.5} aria-hidden="true" />
          {t("lab.search.button")}
        </button>
      </div>
      <div className="lab__hits" aria-label={t("lab.search.resultsLabel")}>
        {searchMutation.isPending ? (
          <Skeleton lines={3} />
        ) : searchMutation.isError ? (
          <ErrorNote error={searchMutation.error} title={t("lab.search.error")} />
        ) : searchMutation.data && searchMutation.data.length > 0 ? (
          searchMutation.data.map((hit) => (
            <article key={hit.id} className="lab__hit" data-a={hit.authority}>
              <div className="lab__hit-head">
                <span className="lab__hit-auth" data-a={hit.authority}>
                  {authorityLabel(hit.authority)}
                </span>
                <span className="lab__hit-title">{hit.title}</span>
                <span className="lab__hit-score mono">
                  score {Math.round(hit.score * 100)}%
                </span>
              </div>
              <p className="lab__hit-content">{hit.content.slice(0, 120)}…</p>
              <div className="lab__hit-flags">
                {hit.reasons.map((reason) => (
                  <span
                    key={reason}
                    className="lab__hit-flag"
                    data-on="true"
                  >
                    {reason}
                  </span>
                ))}
              </div>
            </article>
          ))
        ) : searchMutation.data ? (
          <p className="lab__note">
            {t("lab.search.empty")}
          </p>
        ) : (
          <p className="lab__note">
            {t("lab.search.hint")}
          </p>
        )}
      </div>
    </div>
  );
}

/* ---- 右：剧情预测 + 故事记忆 --------------------------------------------- */

function Predictions({
  predictions,
  isPending,
  isError,
  error,
  pending,
  flash,
  onAdopt,
  onDismiss,
  memories,
  memoriesPending,
  memoriesError,
}: {
  predictions: PlotPrediction[] | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  pending: boolean;
  flash: string | null;
  onAdopt: (p: PlotPrediction) => void;
  onDismiss: (p: PlotPrediction) => void;
  memories: { layer: string; title: string; content: string }[];
  memoriesPending: boolean;
  memoriesError: unknown;
}) {
  const { t } = useI18n();
  return (
    <div className="lab__panel">
      <header className="lab__panel-head">
        <p className="lab__panel-title">{t("lab.predictions.title")}</p>
        <span className="lab__panel-count mono">
          {t("lab.predictions.count", { count: predictions?.length ?? 0 })}
        </span>
      </header>
      <div className="lab__panel-body">
        {isPending ? (
          <Skeleton lines={2} />
        ) : isError ? (
          <ErrorNote error={error} title={t("lab.predictions.loadError")} />
        ) : predictions?.length === 0 ? (
          <p className="lab__note">{t("lab.predictions.empty")}</p>
        ) : (
          <div className="lab__predictions">
            {predictions?.map((prediction) => (
              <article key={prediction.id} className="lab__prediction">
                <div className="lab__prediction-head">
                  <span className="lab__prediction-horizon">
                    {t("lab.predictions.horizon", { horizon: prediction.horizon })}
                  </span>
                  <span className="lab__prediction-title">
                    {prediction.title}
                  </span>
                  <span className="lab__prediction-status">
                    {prediction.stale
                      ? t("lab.predictions.stale")
                      : predictionStatusLabel(prediction.status)}
                  </span>
                </div>
                <p className="lab__prediction-summary">{prediction.summary}</p>
                {prediction.status === "candidate" && !prediction.stale ? (
                  <div className="lab__prediction-foot">
                    <button
                      type="button"
                      className="lab__prediction-btn"
                      disabled={pending}
                      onClick={() => onAdopt(prediction)}
                    >
                      {t("lab.predictions.adopt")}
                    </button>
                    <button
                      type="button"
                      className="lab__prediction-btn"
                      disabled={pending}
                      onClick={() => onDismiss(prediction)}
                    >
                      {t("lab.predictions.dismiss")}
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
        {flash ? (
          <p className="lab__flash" role="status">
            {flash}
          </p>
        ) : null}

        <div className="lab__memories">
          <p className="lab__memories-head">{t("lab.memories.title", { count: memories.length })}</p>
          {memoriesPending ? (
            <Skeleton lines={2} />
          ) : memoriesError ? (
            <ErrorNote error={memoriesError} title={t("lab.memories.loadError")} />
          ) : (
            <div className="lab__memory-list">
              {memories.length === 0 ? (
                <p className="lab__note">{t("lab.memories.empty")}</p>
              ) : (
                memories.slice(0, 5).map((memory, index) => (
                  <div key={index} className="lab__memory">
                    <span className="lab__memory-layer">
                      {memory.layer.toUpperCase()}
                    </span>
                    <p className="lab__memory-title">{memory.title}</p>
                    <p className="lab__memory-content">
                      {memory.content.slice(0, 90)}…
                    </p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- 影响预演 ------------------------------------------------------------- */

function DryRun({
  input,
  setInput,
  onSubmit,
  result,
  pending,
  isError,
  error,
}: {
  input: string;
  setInput: (v: string) => void;
  onSubmit: (change: string) => void;
  result: DryRunResult | null;
  pending: boolean;
  isError: boolean;
  error: unknown;
}) {
  const { t } = useI18n();
  return (
    <div className="lab__panel">
      <header className="lab__panel-head">
        <p className="lab__panel-title">{t("lab.dryRun.title")}</p>
        <span className="lab__panel-count mono">PREVIEW-01</span>
      </header>
      <div className="lab__panel-body">
        <p className="lab__note">
          {t("lab.dryRun.intro")}
        </p>
        <div className="lab__dryrun">
          <textarea
            className="lab__dryrun-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("lab.dryRun.placeholder")}
            aria-label={t("lab.dryRun.inputLabel")}
          />
          <button
            type="button"
            className="btn lab__dryrun-btn"
            disabled={pending || input.trim() === ""}
            onClick={() => onSubmit(input.trim())}
          >
            <Send size={13} strokeWidth={1.5} aria-hidden="true" />
            {t("lab.dryRun.submit")}
          </button>
          {isError ? (
            <ErrorNote error={error} title={t("lab.dryRun.error")} />
          ) : result ? (
            <div className="lab__dryrun-result" aria-label={t("lab.dryRun.resultLabel")}>
              <span
                className="lab__dryrun-safe"
                data-safe={result.safeToProceed}
              >
                {result.safeToProceed
                  ? t("lab.dryRun.safe")
                  : t("lab.dryRun.unsafe")}
              </span>
              {result.findings.map((finding) => (
                <div
                  key={finding.sourceId}
                  className="lab__finding"
                  data-severity={finding.severity}
                >
                  <strong>{finding.label}</strong>
                  <p className="lab__finding-detail">
                    {finding.kind} · {finding.impact}
                  </p>
                </div>
              ))}
              <span className="lab__dryrun-fingerprint mono">
                fingerprint {result.fingerprint.slice(0, 12)}
              </span>
            </div>
          ) : (
            <p className="lab__note">
              {t("lab.dryRun.empty")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
