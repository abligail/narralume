/* 故事圣经：单页 Canon Spread。左侧辑签负责切换主题，右侧同一张纸幅
   同时承载稳定的阅读面与显式的人工编辑，不再叠放七个板块和独立控制台。 */

import "../styles/bible.css";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { ErrorNote } from "../components/error-note";
import { PageBand } from "../components/page-band";
import { ProjectRequiredState } from "../components/project-required-state";
import { Skeleton } from "../components/skeleton";
import { useI18n } from "../i18n";
import { getStoryBible, type StoryBible } from "../lib/api";
import {
  entityTypeLabel,
  factAuthorityLabel,
  foreshadowStatusLabel,
  outlineKindLabel,
  outlineStatusLabel,
  projectPhaseLabel,
} from "../lib/labels";
import { useProjectId } from "../lib/project-route";
import { BibleEditor, type BibleEditorSection } from "./bible/editor";
import { CanonCandidatePanel } from "./bible/candidate-panel";

export type BibleSectionId = BibleEditorSection;

const SECTION_TABS: { id: BibleSectionId; en: string }[] = [
  { id: "intent", en: "INTENT" },
  { id: "outline", en: "OUTLINE" },
  { id: "entities", en: "CANON" },
  { id: "facts", en: "FACTS" },
  { id: "relations", en: "LINKS" },
  { id: "timeline", en: "TIMELINE" },
  { id: "foreshadows", en: "FORESHADOW" },
];

export function BibleWorkspace() {
  const { t } = useI18n();
  const projectId = useProjectId();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSection = searchParams.get("spread");
  const [activeSectionState, setActiveSectionState] =
    useState<BibleSectionId>(() => bibleSection(requestedSection));
  const activeSection = bibleSection(requestedSection ?? activeSectionState);
  const setActiveSection = (section: BibleSectionId) => {
    setActiveSectionState(section);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("spread", section);
        return next;
      },
      { replace: true },
    );
  };
  const query = useQuery({
    queryKey: ["project", projectId, "bible"],
    queryFn: ({ signal }) => getStoryBible(projectId!, signal),
    enabled: Boolean(projectId),
  });

  const bible = query.data;

  if (!projectId) {
    return (
      <div className="bible">
        <ProjectRequiredState
          seal={t("bible.missing.seal")}
          title={t("bible.missing.title")}
          description={t("bible.missing.description")}
        />
      </div>
    );
  }

  return (
    <div className="bible">
      <PageBand
        index="CANON · 03"
        title={t("bible.title")}
        meta={
          bible ? (
            <>
              <span>
                {bible.project.title} · {projectPhaseLabel(bible.project.phase)} ·{" "}
                {bible.project.language}
              </span>
              <span className="mono" aria-label={t("bible.catalogAriaLabel")}>
                {t("bible.catalogCounts", {
                  outline: bible.outline.length,
                  entities: bible.entities.length,
                  facts: bible.facts.length,
                  foreshadows: bible.foreshadows.length,
                })}
              </span>
            </>
          ) : null
        }
      />

      {query.isError ? (
        <div className="bible__error">
        <ErrorNote error={query.error} title={t("bible.loadError")} />
        </div>
      ) : query.isPending ? (
        <div className="bible__loading">
          <Skeleton lines={3} />
          <Skeleton lines={6} />
          <Skeleton lines={8} />
        </div>
      ) : bible ? (
        <div className="bible__spread">
          <aside className="bible__rail" aria-label={t("bible.railLabel")}>
            <p className="bible__rail-title">CANON SPREAD</p>
            {SECTION_TABS.map((tab, index) => {
              const count = countForSection(bible, tab.id);
              const name = t(`bible.tabs.${tab.id}`);
              return (
                <button
                  key={tab.id}
                  type="button"
                  className="bible__tab"
                  data-active={activeSection === tab.id ? "true" : undefined}
                  aria-pressed={activeSection === tab.id}
                  aria-label={t("bible.tabs.view", { name })}
                  onClick={() => setActiveSection(tab.id)}
                >
                  <span className="bible__tab-short" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="bible__tab-name">{name}</span>
                  <span className="bible__tab-count">{count}</span>
                </button>
              );
            })}
          </aside>

          <div className="bible__main">
            <article
              className="bible__active-spread"
              aria-label={t("bible.spreadAriaLabel", {
                name: SECTION_TABS.some((tab) => tab.id === activeSection)
                  ? t(`bible.tabs.${activeSection}`)
                  : t("bible.fallbackSpreadName"),
              })}
            >
              <div className="bible__reader">
                <ActiveSection id={activeSection} bible={bible} />
              </div>
              <aside className="bible__editor">
                <BibleEditor
                  key={activeSection}
                  projectId={projectId}
                  bible={bible}
                  section={activeSection}
                />
                <CanonCandidatePanel
                  projectId={projectId}
                  spread={activeSection}
                />
              </aside>
            </article>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function bibleSection(value: string | null): BibleSectionId {
  return SECTION_TABS.some((section) => section.id === value)
    ? (value as BibleSectionId)
    : "intent";
}

function countForSection(bible: StoryBible, id: BibleSectionId): number {
  switch (id) {
    case "intent":
      return bible.intent ? 1 : 0;
    case "outline":
      return bible.outline.length;
    case "entities":
      return bible.entities.length;
    case "facts":
      return bible.facts.length;
    case "relations":
      return bible.relationships.length;
    case "timeline":
      return bible.timeline.length;
    case "foreshadows":
      return bible.foreshadows.length;
    default:
      return 0;
  }
}

function ActiveSection({
  id,
  bible,
}: {
  id: BibleSectionId;
  bible: StoryBible;
}) {
  switch (id) {
    case "intent":
      return <IntentSection bible={bible} />;
    case "outline":
      return <OutlineSection bible={bible} />;
    case "entities":
      return <EntitySection bible={bible} />;
    case "facts":
      return <FactSection bible={bible} />;
    case "relations":
      return <RelationSection bible={bible} />;
    case "timeline":
      return <TimelineSection bible={bible} />;
    case "foreshadows":
      return <ForeshadowSection bible={bible} />;
  }
}

/* ---- 意图：首语 + 主题带 + 锁栏 ------------------------------------------ */

function IntentSection({ bible }: { bible: StoryBible }) {
  const { t } = useI18n();
  const intent = bible.intent;
  return (
    <section
      className="bible__section"
      id="bible-intent"
      aria-label={t("bible.intent.ariaLabel")}
    >
      <header className="bible__section-head">
        <span className="bible__section-no mono" aria-hidden="true">
          § 01
        </span>
        <h2 className="bible__section-title">{t("bible.intent.title")}</h2>
        <span className="bible__section-en">INTENT</span>
        {intent?.currentFocus ? (
          <span className="bible__section-sub">
            {t("bible.intent.currentFocus", { value: intent.currentFocus })}
          </span>
        ) : null}
      </header>
      <div className="bible__section-body">
        {intent?.promise ? (
          <p className="bible__intent-promise">{intent.promise}</p>
        ) : (
          <p className="bible__hint">{t("bible.intent.empty")}</p>
        )}
        {intent ? (
          <>
            <div className="bible__intent-grid">
              {intent.tone ? (
                <div className="bible__intent-kv">
                  <span className="bible__intent-key">{t("bible.intent.tone")}</span>
                  <span className="bible__intent-val">{intent.tone}</span>
                </div>
              ) : null}
              {intent.audience ? (
                <div className="bible__intent-kv">
                  <span className="bible__intent-key">{t("bible.intent.audience")}</span>
                  <span className="bible__intent-val">{intent.audience}</span>
                </div>
              ) : null}
              {intent.endingDirection ? (
                <div className="bible__intent-kv">
                  <span className="bible__intent-key">{t("bible.intent.ending")}</span>
                  <span className="bible__intent-val">
                    {intent.endingDirection}
                  </span>
                </div>
              ) : null}
            </div>
            {intent.themes.length ? (
              <div className="bible__intent-kv">
                <span className="bible__intent-key">{t("bible.intent.themes")}</span>
                <div className="bible__intent-bands">
                  {intent.themes.map((theme) => (
                    <span key={theme} className="bible__band">
                      {theme}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {intent.boundaries.length ? (
              <div className="bible__intent-kv">
                <span className="bible__intent-key">{t("bible.intent.boundaries")}</span>
                <div className="bible__intent-bands">
                  {intent.boundaries.map((boundary) => (
                    <span key={boundary} className="bible__band">
                      {boundary}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {intent.lockedFields.length ? (
              <div className="bible__intent-locked">
                {intent.lockedFields.map((field) => (
                  <span key={field} className="bible__lock">
                    {t("bible.intent.locked", { field })}
                  </span>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      <footer className="bible__foot">
        <span>{t("bible.intent.footer")}</span>
        <span aria-hidden="true">{t("bible.intent.footerMark")}</span>
      </footer>
    </section>
  );
}

/* ---- 大纲 ---------------------------------------------------------------- */

function OutlineSection({ bible }: { bible: StoryBible }) {
  const { t } = useI18n();
  const nodes = useMemo(
    () => [...bible.outline].sort((a, b) => (a.path < b.path ? -1 : 1)),
    [bible.outline],
  );
  return (
    <section className="bible__section" id="bible-outline" aria-label={t("bible.outline.ariaLabel")}>
      <header className="bible__section-head">
        <span className="bible__section-no mono" aria-hidden="true">
          § 02
        </span>
        <h2 className="bible__section-title">{t("bible.outline.title")}</h2>
        <span className="bible__section-en">OUTLINE</span>
        <span className="bible__section-sub">{t("bible.outline.count", { count: nodes.length })}</span>
      </header>
      <div className="bible__section-body bible__section-body--fill">
        {nodes.length === 0 ? (
          <p className="bible__hint bible__hint--inset">
            {t("bible.outline.empty")}
          </p>
        ) : (
          <div className="bible__outline">
            {nodes.map((node) => (
              <div
                key={node.id}
                className="bible__outline-row"
                data-status={node.status}
                style={{ paddingLeft: `${1.1 + node.depth * 1.4}rem` }}
              >
                <span className="bible__outline-kind">
                  {outlineKindLabel(node.kind)}
                </span>
                <div className="bible__outline-title">
                  <span className="bible__outline-name">{node.title}</span>
                  {node.summary ? (
                    <span className="bible__outline-summary">
                      {node.summary}
                    </span>
                  ) : null}
                  {(node.goal ?? node.conflict) !== null ? (
                    <span className="bible__outline-shows-kicker">
                      {node.goal ? (
                        <span className="bible__outline-mini">
                          {t("bible.outline.goal", { value: node.goal })}
                        </span>
                      ) : null}
                      {node.conflict ? (
                        <span className="bible__outline-mini">
                          {t("bible.outline.conflict", { value: node.conflict })}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </div>
                {node.status === "committed" ? (
                  <span className="bible__outline-tag">{t("bible.outline.committed")}</span>
                ) : (
                  <span
                    className="bible__outline-status"
                    data-status={node.status}
                  >
                    {outlineStatusLabel(node.status)}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/* ---- 实体 ---------------------------------------------------------------- */

function EntitySection({ bible }: { bible: StoryBible }) {
  const { t } = useI18n();
  return (
    <section className="bible__section" id="bible-entities" aria-label={t("bible.entities.ariaLabel")}>
      <header className="bible__section-head">
        <span className="bible__section-no mono" aria-hidden="true">
          § 03
        </span>
        <h2 className="bible__section-title">{t("bible.entities.title")}</h2>
        <span className="bible__section-en">CANON ENTITIES</span>
        <span className="bible__section-sub">{t("bible.entities.count", { count: bible.entities.length })}</span>
      </header>
      <div className="bible__section-body">
        {bible.entities.length === 0 ? (
          <p className="bible__hint">{t("bible.entities.empty")}</p>
        ) : (
          <div className="bible__cards">
            {bible.entities.map((entity) => (
              <article key={entity.id} className="bible__card">
                <span className="bible__card-kind">
                  {entityTypeLabel(entity.type)}
                </span>
                <span className="bible__card-name">{entity.name}</span>
                {entity.description ? (
                  <span className="bible__card-desc">{entity.description}</span>
                ) : null}
                {entity.aliases.length > 0 ? (
                  <div className="bible__card-tags">
                    {entity.aliases.map((alias) => (
                      <span key={alias} className="bible__card-chip">
                        {alias}
                      </span>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/* ---- 正典：事实清单 ------------------------------------------------------- */

function FactSection({ bible }: { bible: StoryBible }) {
  const { t } = useI18n();
  const facts = useMemo(() => {
    const byId = new Map(bible.entities.map((entity) => [entity.id, entity]));
    return bible.facts.map((fact) => ({
      fact,
      subject: byId.get(fact.subjectId)?.name ?? fact.subjectId,
      object: byId.get(fact.objectEntityId ?? "")?.name ?? null,
    }));
  }, [bible.entities, bible.facts]);
  return (
    <section className="bible__section" id="bible-facts" aria-label={t("bible.facts.ariaLabel")}>
      <header className="bible__section-head">
        <span className="bible__section-no mono" aria-hidden="true">
          § 04
        </span>
        <h2 className="bible__section-title">{t("bible.facts.title")}</h2>
        <span className="bible__section-en">FACTS</span>
        <span className="bible__section-sub">{t("bible.facts.count", { count: facts.length })}</span>
      </header>
      <div className="bible__section-body bible__section-body--fill">
        {facts.length === 0 ? (
          <p className="bible__hint bible__hint--inset">
            {t("bible.facts.empty")}
          </p>
        ) : (
          <div className="bible__facts">
            {facts.map(({ fact, subject, object }) => (
              <div key={fact.id} className="bible__facts-row">
                <span
                  className="bible__facts-authority"
                  data-a={fact.authority}
                >
                  {factAuthorityLabel(fact.authority)}
                </span>
                <span className="bible__facts-subject">{subject}</span>
                <span className="bible__facts-pred">{fact.predicate}</span>
                <span
                  className="bible__facts-obj"
                  data-locked={fact.authority === "locked"}
                >
                  {object ?? jsonValueOf(fact.value)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function jsonValueOf(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "…";
  }
}

/* ---- 关系 ---------------------------------------------------------------- */

function RelationSection({ bible }: { bible: StoryBible }) {
  const { t } = useI18n();
  const entities = useMemo(
    () => new Map(bible.entities.map((entity) => [entity.id, entity.name])),
    [bible.entities],
  );
  return (
    <section className="bible__section" id="bible-relations" aria-label={t("bible.relations.ariaLabel")}>
      <header className="bible__section-head">
        <span className="bible__section-no mono" aria-hidden="true">
          § 05
        </span>
        <h2 className="bible__section-title">{t("bible.relations.title")}</h2>
        <span className="bible__section-en">RELATIONS</span>
        <span className="bible__section-sub">
          {t("bible.relations.count", { count: bible.relationships.length })}
        </span>
      </header>
      <div className="bible__section-body bible__section-body--fill">
        {bible.relationships.length === 0 ? (
          <p className="bible__hint bible__hint--inset">
            {t("bible.relations.empty")}
          </p>
        ) : (
          <div className="bible__ledger">
            {bible.relationships.map((rel) => (
              <div key={rel.id} className="bible__ledger-row">
                <span className="bible__ledger-meta">
                  {rel.storyTime ?? rel.createdAt.slice(0, 10)}
                </span>
                <div className="bible__ledger-main">
                  <span className="bible__ledger-line">
                    {entities.get(rel.fromEntityId) ?? rel.fromEntityId} ·{" "}
                    {rel.relation} ·{" "}
                    {entities.get(rel.toEntityId) ?? rel.toEntityId}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/* ---- 时间线 -------------------------------------------------------------- */

function TimelineSection({ bible }: { bible: StoryBible }) {
  const { t } = useI18n();
  return (
    <section className="bible__section" id="bible-timeline" aria-label={t("bible.timeline.ariaLabel")}>
      <header className="bible__section-head">
        <span className="bible__section-no mono" aria-hidden="true">
          § 06
        </span>
        <h2 className="bible__section-title">{t("bible.timeline.title")}</h2>
        <span className="bible__section-en">TIMELINE</span>
        <span className="bible__section-sub">{t("bible.timeline.count", { count: bible.timeline.length })}</span>
      </header>
      <div className="bible__section-body">
        {bible.timeline.length === 0 ? (
          <p className="bible__hint">{t("bible.timeline.empty")}</p>
        ) : (
          bible.timeline.map((event) => (
            <div key={event.id}>
              <p className="bible__facts-line">
                <strong>{event.title}</strong>
                {event.storyTimeStart ? `（${event.storyTimeStart}）` : ""}
              </p>
              {event.description ? (
                <p className="bible__blockquote">{event.description}</p>
              ) : null}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/* ---- 伏笔 ---------------------------------------------------------------- */

function ForeshadowSection({ bible }: { bible: StoryBible }) {
  const { t } = useI18n();
  return (
    <section className="bible__section" id="bible-foreshadows" aria-label={t("bible.foreshadows.ariaLabel")}>
      <header className="bible__section-head">
        <span className="bible__section-no mono" aria-hidden="true">
          § 07
        </span>
        <h2 className="bible__section-title">{t("bible.foreshadows.title")}</h2>
        <span className="bible__section-en">FORESHADOW</span>
        <span className="bible__section-sub">
          {t("bible.foreshadows.count", { count: bible.foreshadows.length })}
        </span>
      </header>
      <div className="bible__section-body">
        {bible.foreshadows.length === 0 ? (
          <p className="bible__hint">{t("bible.foreshadows.empty")}</p>
        ) : (
          <div className="bible__foreshadows">
            {bible.foreshadows.map((foreshadow) => (
              <article
                key={foreshadow.id}
                className="bible__foreshadow-card"
                data-s={foreshadow.status}
              >
                <div className="bible__foreshadow-state">
                  <span className="bible__foreshadow-stat">
                    {foreshadowStatusLabel(foreshadow.status)}
                  </span>
                  <span className="bible__foreshadow-pin">
                    {"★".repeat(foreshadow.importance)}
                  </span>
                </div>
                <p className="bible__foreshadow-title">{foreshadow.title}</p>
                <p className="bible__foreshadow-desc">
                  {foreshadow.description}
                </p>
                <p className="bible__foreshadow-meta">
                  {t("bible.foreshadows.meta", {
                    count: foreshadow.evidenceNodeIds.length,
                    date: foreshadow.updatedAt.slice(0, 10),
                  })}
                </p>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
