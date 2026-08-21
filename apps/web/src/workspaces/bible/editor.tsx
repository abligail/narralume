import "../../styles/bible-actions.css";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PenLine, Save, Search, Trash2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";

import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorNote } from "../../components/error-note";
import { getLocale, translate, useI18n } from "../../i18n";
import {
  createCanonEntity,
  createCanonFact,
  createForeshadow,
  createOutlineNode,
  createRelationshipEvent,
  createTimelineEvent,
  previewContext,
  promoteCanonFact,
  reviseCanonFact,
  removeCanonEntity,
  removeForeshadow,
  removeOutlineNode,
  removeRelationshipEvent,
  removeTimelineEvent,
  updateAuthorIntent,
  updateCanonEntity,
  updateForeshadow,
  updateOutlineNode,
  updateTimelineEvent,
  withdrawCanonFact,
  type CanonEntity,
  type CanonFact,
  type ContextPreview,
  type Foreshadow,
  type OutlineNode,
  type StoryBible,
} from "../../lib/api";
import { projectWorkspacePath } from "../../lib/project-route";

export type BibleEditorSection =
  | "intent"
  | "outline"
  | "entities"
  | "facts"
  | "relations"
  | "timeline"
  | "foreshadows";

type MutationWork = {
  execute: () => Promise<unknown>;
  kind: "write" | "preview";
};

export function BibleEditor({
  projectId,
  bible,
  section,
}: {
  projectId: string;
  bible: StoryBible;
  section: BibleEditorSection;
}) {
  const { t } = useI18n();
  const sectionName = t(`bible.editor.sections.${section}`);
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const mutation = useMutation({
    mutationFn: (work: MutationWork) => work.execute(),
    onSuccess: (value, work) => {
      setResult(work.kind === "preview" ? value : null);
      setNotice(
        isRemoval(value)
          ? removalNotice(value.disposition)
          : work.kind === "preview"
          ? t("bible.editor.previewDone")
          : t("bible.editor.saved"),
      );
      if (work.kind === "write") {
        void queryClient.invalidateQueries({
          queryKey: ["project", projectId, "bible"],
        });
      }
    },
  });
  const run = (
    execute: () => Promise<unknown>,
    kind: MutationWork["kind"] = "write",
  ) => {
    setNotice(null);
    setResult(null);
    mutation.mutate({ execute, kind });
  };
  return (
    <section className="bible-actions" aria-label={t("bible.editor.ariaLabel", { section: sectionName })}>
      <header className="bible-actions__head">
        <div>
          <p className="bible-actions__eyebrow">{t("bible.editor.eyebrow", { section: sectionName })}</p>
          <h2>{t("bible.editor.title")}</h2>
        </div>
        <p className="bible-actions__note">{t("bible.editor.note")}</p>
      </header>
      <div className="bible-actions__panel">
        {section === "intent" ? <IntentForm key={bible.intent?.updatedAt ?? "intent:none"} bible={bible} pending={mutation.isPending} onSubmit={(input) => run(() => updateAuthorIntent(projectId, { ...input, expectedUpdatedAt: bible.intent?.updatedAt ?? null }))} /> : null}
        {section === "outline" ? <OutlineForm bible={bible} pending={mutation.isPending} onSave={(work) => run(work)} projectId={projectId} /> : null}
        {section === "entities" ? <EntityForm bible={bible} pending={mutation.isPending} onSave={(work) => run(work)} projectId={projectId} /> : null}
        {section === "facts" ? <FactForm bible={bible} pending={mutation.isPending} onSave={(work) => run(work)} projectId={projectId} /> : null}
        {section === "relations" ? <RelationForm projectId={projectId} bible={bible} pending={mutation.isPending} onSave={(work) => run(work)} /> : null}
        {section === "timeline" ? <TimelineForm bible={bible} pending={mutation.isPending} onSave={(work) => run(work)} projectId={projectId} /> : null}
        {section === "foreshadows" ? <ForeshadowForm bible={bible} pending={mutation.isPending} onSave={(work) => run(work)} projectId={projectId} /> : null}
        {mutation.isError ? <ErrorNote error={mutation.error} title={t("bible.editor.writeError")} /> : null}
        {notice ? <p className="bible-actions__notice" role="status">{notice}</p> : null}
        <details className="bible-actions__context">
          <summary>
            <Search size={14} strokeWidth={1.6} aria-hidden="true" />
            {t("bible.editor.previewContext")}
          </summary>
          <div className="bible-actions__context-body">
            <ContextForm
              bible={bible}
              pending={mutation.isPending}
              onSubmit={(input) =>
                run(() => previewContext(projectId, input), "preview")
              }
            />
            {result ? <ContextResult value={result as ContextPreview} /> : null}
          </div>
        </details>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="bible-actions__field"><span>{label}</span>{children}</label>;
}
function Buttons({ pending, children, save = true }: { pending: boolean; children?: ReactNode; save?: boolean }) {
  const { t } = useI18n();
  return <div className="bible-actions__buttons">{children}{save ? <button type="submit" className="btn btn--primary" disabled={pending}><Save size={13} />{pending ? t("common.state.submitting") : t("common.action.save")}</button> : null}</div>;
}
function RemoveResourceButton({ pending, label, onConfirm }: { pending: boolean; label: string; onConfirm: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return <>{<button type="button" className="btn" disabled={pending} onClick={() => setOpen(true)}><Trash2 size={13} />{label}</button>}{open ? <ConfirmDialog title={t("bible.editor.confirmRemovalTitle", { label })} confirmLabel={label} danger pending={pending} onCancel={() => setOpen(false)} onConfirm={() => { setOpen(false); onConfirm(); }}><p>{t("bible.editor.removalBody")}</p></ConfirmDialog> : null}</>;
}
function isRemoval(value: unknown): value is { disposition: "deleted" | "abandoned" | "retired" | "voided" } {
  return Boolean(value && typeof value === "object" && "disposition" in value);
}
function removalNotice(disposition: "deleted" | "abandoned" | "retired" | "voided"): string {
  return translate(getLocale(), `bible.editor.removal.${disposition}`);
}
const comma = (value: string) => value.split(/[，,]/).map((item) => item.trim()).filter(Boolean);

function IntentForm({ bible, pending, onSubmit }: { bible: StoryBible; pending: boolean; onSubmit: (input: Record<string, unknown>) => void }) {
  const { t } = useI18n();
  const intent = bible.intent;
  const [promise, setPromise] = useState(intent?.promise ?? "");
  const [themes, setThemes] = useState(intent?.themes.join("，") ?? "");
  const [audience, setAudience] = useState(intent?.audience ?? "");
  const [tone, setTone] = useState(intent?.tone ?? "");
  const [boundaries, setBoundaries] = useState(intent?.boundaries.join("，") ?? "");
  const [endingDirection, setEndingDirection] = useState(intent?.endingDirection ?? "");
  const [currentFocus, setCurrentFocus] = useState(intent?.currentFocus ?? "");
  return <form className="bible-actions__form" onSubmit={(event) => { event.preventDefault(); onSubmit({ promise, themes: comma(themes), audience, tone, boundaries: comma(boundaries), endingDirection, currentFocus, lockedFields: intent?.lockedFields ?? [] }); }}>
    <Field label={t("bible.fields.promise")}><textarea required value={promise} onChange={(event) => setPromise(event.target.value)} /></Field>
    <Field label={t("bible.editor.themesLabel")}><input value={themes} onChange={(event) => setThemes(event.target.value)} /></Field>
    <Field label={t("bible.fields.audience")}><input value={audience} onChange={(event) => setAudience(event.target.value)} /></Field>
    <Field label={t("bible.fields.tone")}><input value={tone} onChange={(event) => setTone(event.target.value)} /></Field>
    <Field label={t("bible.editor.boundariesLabel")}><input value={boundaries} onChange={(event) => setBoundaries(event.target.value)} /></Field>
    <Field label={t("bible.fields.endingDirection")}><textarea value={endingDirection} onChange={(event) => setEndingDirection(event.target.value)} /></Field>
    <Field label={t("bible.fields.currentFocus")}><input value={currentFocus} onChange={(event) => setCurrentFocus(event.target.value)} /></Field><Buttons pending={pending} />
  </form>;
}

function OutlineForm({ projectId, bible, pending, onSave }: { projectId: string; bible: StoryBible; pending: boolean; onSave: (work: () => Promise<unknown>) => void }) {
  const [selectedId, setSelectedId] = useState("new");
  const selected = bible.outline.find((node) => node.id === selectedId);
  // key 绑定资源身份与版本：查询刷新或 AI 候选采纳后字段和并发令牌一起重置，
  // 避免旧表单内容配合新 updatedAt 静默覆盖（CR-65）。
  return <OutlineFields key={`${selectedId}@${selected?.updatedAt ?? "new"}`} projectId={projectId} bible={bible} selected={selected} pending={pending} onSave={onSave} onSelect={setSelectedId} />;
}

const OUTLINE_CHILD_KINDS: Readonly<Record<OutlineNode["kind"], readonly OutlineNode["kind"][]>> = {
  book: ["volume", "arc", "chapter"],
  volume: ["arc", "chapter"],
  arc: ["chapter", "scene"],
  chapter: ["scene", "beat"],
  scene: ["beat"],
  beat: [],
};

function OutlineFields({ projectId, bible, selected, pending, onSave, onSelect }: { projectId: string; bible: StoryBible; selected: OutlineNode | undefined; pending: boolean; onSave: (work: () => Promise<unknown>) => void; onSelect: (id: string) => void }) {
  const { t } = useI18n();
  const kindLabel = (kind: OutlineNode["kind"]) => t(`bible.outlineKind.${kind}`);
  const root = bible.outline.find((node) => node.kind === "book") ?? bible.outline[0];
  const [parentId, setParentId] = useState(selected?.parentId ?? root?.id ?? "");
  const initialParent = bible.outline.find((node) => node.id === (selected?.parentId ?? root?.id));
  const [kind, setKind] = useState<OutlineNode["kind"]>(selected?.kind ?? (initialParent ? OUTLINE_CHILD_KINDS[initialParent.kind][0] : undefined) ?? "chapter");
  const [title, setTitle] = useState(selected?.title ?? "");
  const [summary, setSummary] = useState(selected?.summary ?? "");
  const [goal, setGoal] = useState(selected?.goal ?? "");
  const [conflict, setConflict] = useState(selected?.conflict ?? "");
  const validParents = bible.outline.filter((node) => OUTLINE_CHILD_KINDS[node.kind].length > 0);
  const parent = validParents.find((node) => node.id === parentId);
  const allowedKinds = parent ? OUTLINE_CHILD_KINDS[parent.kind] : [];

  return <form className="bible-actions__form" onSubmit={(event) => { event.preventDefault(); onSave(() => selected ? updateOutlineNode(projectId, selected.id, { title, summary: summary || null, goal: goal || null, conflict: conflict || null, expectedUpdatedAt: selected.updatedAt }) : createOutlineNode(projectId, { parentId, kind, ordinal: bible.outline.filter((node) => node.parentId === parentId).length, title, summary: summary || null, metadata: {} })); }}>
    <Field label={t("bible.fields.editTarget")}><select value={selected?.id ?? "new"} onChange={(event) => onSelect(event.target.value)}><option value="new">{t("bible.editor.newNode")}</option>{bible.outline.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select></Field>
    {!selected ? <><Field label={t("bible.fields.parent")}><select required value={parentId} onChange={(event) => { const nextParent = validParents.find((node) => node.id === event.target.value); setParentId(event.target.value); if (nextParent) setKind(OUTLINE_CHILD_KINDS[nextParent.kind][0]!); }}>{validParents.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select></Field><Field label={t("bible.fields.type")}><select value={kind} onChange={(event) => setKind(event.target.value as OutlineNode["kind"])}>{allowedKinds.map((value) => <option key={value} value={value}>{kindLabel(value)}</option>)}</select></Field>{parent ? <p className="bible-actions__note">{t("bible.editor.allowedUnder", { parent: kindLabel(parent.kind), kinds: allowedKinds.map(kindLabel).join(t("bible.editor.listSeparator")) })}</p> : null}</> : null}
    <Field label={t("bible.fields.title")}><input required value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
    <Field label={t("bible.fields.summary")}><textarea value={summary ?? ""} onChange={(event) => setSummary(event.target.value)} /></Field>
    {selected ? <><Field label={t("bible.fields.goal")}><input value={goal ?? ""} onChange={(event) => setGoal(event.target.value)} /></Field><Field label={t("bible.fields.conflict")}><input value={conflict ?? ""} onChange={(event) => setConflict(event.target.value)} /></Field></> : null}
    <Buttons pending={pending}>{selected && selected.kind !== "book" ? <RemoveResourceButton pending={pending} label={selected.status === "abandoned" ? t("bible.editor.removeUnusedNode") : t("bible.editor.removeNode")} onConfirm={() => onSave(() => removeOutlineNode(projectId, selected))} /> : null}{selected?.kind === "chapter" ? <Link className="btn" to={`${projectWorkspacePath(projectId, "studio")}?outline=${encodeURIComponent(selected.id)}`}><PenLine size={13} />{t("bible.editor.goWriteChapter")}</Link> : null}</Buttons>
  </form>;
}

// 选项与后端契约枚举对齐（CR-17）：type 为 character/location/organization/item/rule/concept，
// status 为 active/retired；onChange 用 find 取代类型断言，让漂移在编译期暴露。
const ENTITY_TYPE_OPTIONS: readonly { value: CanonEntity["type"] }[] = [
  { value: "character" },
  { value: "location" },
  { value: "organization" },
  { value: "item" },
  { value: "rule" },
  { value: "concept" },
];
const ENTITY_STATUS_OPTIONS: readonly { value: CanonEntity["status"] }[] = [
  { value: "active" },
  { value: "retired" },
];

function EntityForm({ projectId, bible, pending, onSave }: { projectId: string; bible: StoryBible; pending: boolean; onSave: (work: () => Promise<unknown>) => void }) {
  const [selectedId, setSelectedId] = useState("new");
  const selected = bible.entities.find((entity) => entity.id === selectedId);
  return <EntityFields key={`${selectedId}@${selected?.updatedAt ?? "new"}`} projectId={projectId} bible={bible} selected={selected} pending={pending} onSave={onSave} onSelect={setSelectedId} />;
}
function EntityFields({ projectId, bible, selected, pending, onSave, onSelect }: { projectId: string; bible: StoryBible; selected: CanonEntity | undefined; pending: boolean; onSave: (work: () => Promise<unknown>) => void; onSelect: (id: string) => void }) {
  const { t } = useI18n();
  const [type, setType] = useState<CanonEntity["type"]>(selected?.type ?? "character"); const [name, setName] = useState(selected?.name ?? ""); const [aliases, setAliases] = useState(selected?.aliases.join("，") ?? ""); const [description, setDescription] = useState(selected?.description ?? ""); const [status, setStatus] = useState<CanonEntity["status"]>(selected?.status ?? "active");
  return <form className="bible-actions__form" onSubmit={(event) => { event.preventDefault(); onSave(() => selected ? updateCanonEntity(projectId, selected.id, { name, aliases: comma(aliases), description: description || null, attributes: selected.attributes, status, expectedUpdatedAt: selected.updatedAt }) : createCanonEntity(projectId, { type, name, aliases: comma(aliases), description: description || null, attributes: {} })); }}>
    <Field label={t("bible.fields.editTarget")}><select value={selected?.id ?? "new"} onChange={(event) => onSelect(event.target.value)}><option value="new">{t("bible.editor.newEntity")}</option>{bible.entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></Field>
    {!selected ? <Field label={t("bible.fields.type")}><select value={type} onChange={(event) => { const option = ENTITY_TYPE_OPTIONS.find((item) => item.value === event.target.value); if (option) setType(option.value); }}>{ENTITY_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{t(`bible.entityType.${option.value}`)}</option>)}</select></Field> : null}
    <Field label={t("bible.fields.name")}><input required value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label={t("bible.fields.aliases")}><input value={aliases} onChange={(event) => setAliases(event.target.value)} /></Field><Field label={t("bible.fields.description")}><textarea value={description ?? ""} onChange={(event) => setDescription(event.target.value)} /></Field>
    {selected ? <Field label={t("bible.fields.status")}><select value={status} onChange={(event) => { const option = ENTITY_STATUS_OPTIONS.find((item) => item.value === event.target.value); if (option) setStatus(option.value); }}>{ENTITY_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{t(`bible.entityStatus.${option.value}`)}</option>)}</select></Field> : null}<Buttons pending={pending}>{selected ? <RemoveResourceButton pending={pending} label={t("bible.editor.removeEntity")} onConfirm={() => onSave(() => removeCanonEntity(projectId, selected))} /> : null}</Buttons>
  </form>;
}

function FactForm({ projectId, bible, pending, onSave }: { projectId: string; bible: StoryBible; pending: boolean; onSave: (work: () => Promise<unknown>) => void }) {
  const [selectedId, setSelectedId] = useState("new"); const selected = bible.facts.find((fact) => fact.id === selectedId);
  return <FactFields key={`${selectedId}@${selected?.createdAt ?? "new"}`} projectId={projectId} bible={bible} selected={selected} pending={pending} onSave={onSave} onSelect={setSelectedId} />;
}
function FactFields({ projectId, bible, selected, pending, onSave, onSelect }: { projectId: string; bible: StoryBible; selected: CanonFact | undefined; pending: boolean; onSave: (work: () => Promise<unknown>) => void; onSelect: (id: string) => void }) {
  const { t } = useI18n();
  const [subjectId, setSubjectId] = useState(selected?.subjectId ?? bible.entities[0]?.id ?? ""); const [predicate, setPredicate] = useState(selected?.predicate ?? ""); const [value, setValue] = useState(typeof selected?.value === "string" ? selected.value : selected?.value ? JSON.stringify(selected.value) : ""); const [objectMode, setObjectMode] = useState<"value" | "entity">(selected?.objectEntityId ? "entity" : "value"); const [objectEntityId, setObjectEntityId] = useState(selected?.objectEntityId ?? bible.entities[0]?.id ?? ""); const [authority, setAuthority] = useState<CanonFact["authority"]>(selected?.authority ?? "confirmed"); const [reason, setReason] = useState("");
  const [confirmAction, setConfirmAction] = useState<"revise" | "withdraw" | null>(null);
  // 契约要求 objectEntityId 与 value 必须且只能提供一个（CR-18）：实体宾语模式下省略 value，文本模式下 objectEntityId 置 null。
  const saveRevision = (confirmLockedRevision: boolean) => {
    if (!selected) return;
    const object = objectMode === "entity" ? { objectEntityId } : { objectEntityId: null, value };
    onSave(() => reviseCanonFact(projectId, selected.id, { subjectId, predicate, ...object, validFromNodeId: selected.validFromNodeId, validToNodeId: selected.validToNodeId, knowledgeScope: selected.knowledgeScope, knowledgeSubjectId: selected.knowledgeSubjectId, authority, confidence: selected.confidence, confirmLockedRevision }));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!selected) {
      const object = objectMode === "entity" ? { objectEntityId } : { objectEntityId: null, value };
      onSave(() => createCanonFact(projectId, { subjectId, predicate, ...object, authority, knowledgeScope: "omniscient", confidence: 1 }));
    } else if (selected.authority === "locked") {
      setConfirmAction("revise");
    } else {
      saveRevision(false);
    }
  };
  const withdraw = (confirmLockedWithdrawal: boolean) => {
    if (!selected) return;
    onSave(() => withdrawCanonFact(projectId, selected.id, { reason: reason.trim(), confirmLockedWithdrawal }));
  };
  return <><form className="bible-actions__form" onSubmit={submit}><Field label={t("bible.fields.editTarget")}><select value={selected?.id ?? "new"} onChange={(event) => onSelect(event.target.value)}><option value="new">{t("bible.editor.newFact")}</option>{bible.facts.map((fact) => <option key={fact.id} value={fact.id}>{fact.predicate}</option>)}</select></Field><Field label={t("bible.fields.subject")}><select required value={subjectId} onChange={(event) => setSubjectId(event.target.value)}>{bible.entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></Field><Field label={t("bible.fields.predicate")}><input required value={predicate} onChange={(event) => setPredicate(event.target.value)} /></Field><Field label={t("bible.fields.object")}><select value={objectMode} onChange={(event) => setObjectMode(event.target.value === "entity" ? "entity" : "value")}><option value="value">{t("bible.editor.objectText")}</option><option value="entity">{t("bible.tabs.entities")}</option></select></Field>{objectMode === "entity" ? <Field label={t("bible.editor.objectEntity")}><select required value={objectEntityId} onChange={(event) => setObjectEntityId(event.target.value)}>{bible.entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></Field> : <Field label={t("bible.fields.value")}><input required value={value} onChange={(event) => setValue(event.target.value)} /></Field>}<Field label={t("bible.fields.authority")}><select value={authority} onChange={(event) => setAuthority(event.target.value as CanonFact["authority"])}><option value="candidate">{t("bible.authority.candidate")}</option><option value="inferred">{t("bible.authority.inferred")}</option><option value="confirmed">{t("bible.authority.confirmed")}</option><option value="locked">{t("bible.authority.locked")}</option></select></Field>
    {selected ? <><Field label={t("bible.editor.withdrawReason")}><input value={reason} onChange={(event) => setReason(event.target.value)} /></Field><div className="bible-actions__buttons"><button type="button" className="btn" disabled={pending || selected.authority === "locked"} onClick={() => onSave(() => promoteCanonFact(projectId, selected.id, selected.authority === "candidate" ? "inferred" : selected.authority === "inferred" ? "confirmed" : "locked"))}>{t("bible.editor.promoteAuthority")}</button><button type="button" className="btn" disabled={pending || !reason.trim()} onClick={() => selected.authority === "locked" ? setConfirmAction("withdraw") : withdraw(false)}>{t("bible.editor.withdrawFact")}</button></div></> : null}<Buttons pending={pending} />
  </form>{confirmAction ? <ConfirmDialog title={confirmAction === "revise" ? t("bible.editor.confirmReviseLocked") : t("bible.editor.confirmWithdrawLocked")} confirmLabel={confirmAction === "revise" ? t("bible.editor.confirmRevise") : t("bible.editor.confirmWithdraw")} danger={confirmAction === "withdraw"} pending={pending} onCancel={() => setConfirmAction(null)} onConfirm={() => { const action = confirmAction; setConfirmAction(null); if (action === "revise") saveRevision(true); else withdraw(true); }}><p>{t("bible.editor.lockedBody")}</p></ConfirmDialog> : null}</>;
}

function RelationForm({ projectId, bible, pending, onSave }: { projectId: string; bible: StoryBible; pending: boolean; onSave: (work: () => Promise<unknown>) => void }) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState("new"); const selected = bible.relationships.find((item) => item.id === selectedId); const [fromEntityId, setFrom] = useState(bible.entities[0]?.id ?? ""); const [toEntityId, setTo] = useState(bible.entities[1]?.id ?? bible.entities[0]?.id ?? ""); const [relation, setRelation] = useState(""); const [storyTime, setStoryTime] = useState("");
  return <form className="bible-actions__form" onSubmit={(event) => { event.preventDefault(); if (!selected) onSave(() => createRelationshipEvent(projectId, { fromEntityId, toEntityId, relation, intensity: null, state: {}, outlineNodeId: null, storyTime: storyTime || null, sourceId: null })); }}><Field label={t("bible.fields.editTarget")}><select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}><option value="new">{t("bible.editor.newRelation")}</option>{bible.relationships.map((item) => <option key={item.id} value={item.id}>{item.relation}</option>)}</select></Field>{selected ? <><Field label={t("bible.fields.relationPair")}><input disabled value={`${bible.entities.find((item) => item.id === selected.fromEntityId)?.name ?? t("common.state.unknown")} → ${bible.entities.find((item) => item.id === selected.toEntityId)?.name ?? t("common.state.unknown")}`} /></Field><Field label={t("bible.fields.relation")}><input disabled value={selected.relation} /></Field></> : <><Field label={t("bible.editor.fromEntity")}><select value={fromEntityId} onChange={(event) => setFrom(event.target.value)}>{bible.entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></Field><Field label={t("bible.editor.toEntity")}><select value={toEntityId} onChange={(event) => setTo(event.target.value)}>{bible.entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></Field><Field label={t("bible.fields.relation")}><input required value={relation} onChange={(event) => setRelation(event.target.value)} /></Field><Field label={t("bible.fields.storyTime")}><input value={storyTime} onChange={(event) => setStoryTime(event.target.value)} /></Field></>}<Buttons pending={pending} save={!selected}>{selected ? <RemoveResourceButton pending={pending} label={t("bible.editor.voidRelation")} onConfirm={() => onSave(() => removeRelationshipEvent(projectId, selected))} /> : null}</Buttons></form>;
}

function TimelineForm({ projectId, bible, pending, onSave }: { projectId: string; bible: StoryBible; pending: boolean; onSave: (work: () => Promise<unknown>) => void }) {
  const [selectedId, setSelectedId] = useState("new"); const selected = bible.timeline.find((event) => event.id === selectedId);
  return <TimelineFields key={`${selectedId}@${selected?.updatedAt ?? "new"}`} projectId={projectId} bible={bible} selected={selected} pending={pending} onSave={onSave} onSelect={setSelectedId} />;
}
function TimelineFields({ projectId, bible, selected, pending, onSave, onSelect }: { projectId: string; bible: StoryBible; selected: StoryBible["timeline"][number] | undefined; pending: boolean; onSave: (work: () => Promise<unknown>) => void; onSelect: (id: string) => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState(selected?.title ?? ""); const [description, setDescription] = useState(selected?.description ?? ""); const [start, setStart] = useState(selected?.storyTimeStart ?? ""); const [end, setEnd] = useState(selected?.storyTimeEnd ?? "");
  const payload = () => ({ title, description: description || null, outlineNodeId: selected?.outlineNodeId ?? null, storyTimeStart: start, storyTimeEnd: end || null, sequence: selected?.sequence ?? bible.timeline.length, participants: selected?.participants ?? [], causes: selected?.causes ?? [], visibility: selected?.visibility ?? "omniscient" as const, sourceId: selected?.sourceId ?? null });
  return <form className="bible-actions__form" onSubmit={(event) => { event.preventDefault(); onSave(() => selected ? updateTimelineEvent(projectId, selected.id, { ...payload(), expectedUpdatedAt: selected.updatedAt }) : createTimelineEvent(projectId, payload())); }}><Field label={t("bible.fields.editTarget")}><select value={selected?.id ?? "new"} onChange={(event) => onSelect(event.target.value)}><option value="new">{t("bible.editor.newEvent")}</option>{bible.timeline.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></Field><Field label={t("bible.fields.title")}><input required value={title} onChange={(event) => setTitle(event.target.value)} /></Field><Field label={t("bible.fields.description")}><textarea value={description ?? ""} onChange={(event) => setDescription(event.target.value)} /></Field><Field label={t("bible.fields.start")}><input required value={start} onChange={(event) => setStart(event.target.value)} /></Field><Field label={t("bible.fields.end")}><input value={end ?? ""} onChange={(event) => setEnd(event.target.value)} /></Field><Buttons pending={pending}>{selected ? <RemoveResourceButton pending={pending} label={t("bible.editor.removeEvent")} onConfirm={() => onSave(() => removeTimelineEvent(projectId, selected))} /> : null}</Buttons></form>;
}

function ForeshadowForm({ projectId, bible, pending, onSave }: { projectId: string; bible: StoryBible; pending: boolean; onSave: (work: () => Promise<unknown>) => void }) {
  const [selectedId, setSelectedId] = useState("new"); const selected = bible.foreshadows.find((item) => item.id === selectedId);
  return <ForeshadowFields key={`${selectedId}@${selected?.updatedAt ?? "new"}`} projectId={projectId} bible={bible} selected={selected} pending={pending} onSave={onSave} onSelect={setSelectedId} />;
}
function ForeshadowFields({ projectId, bible, selected, pending, onSave, onSelect }: { projectId: string; bible: StoryBible; selected: Foreshadow | undefined; pending: boolean; onSave: (work: () => Promise<unknown>) => void; onSelect: (id: string) => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState(selected?.title ?? ""); const [description, setDescription] = useState(selected?.description ?? ""); const [status, setStatus] = useState<Foreshadow["status"]>(selected?.status ?? "planned"); const [importance, setImportance] = useState<Foreshadow["importance"]>(selected?.importance ?? 3);
  const payload = () => ({ title, description, status, importance, dependencies: selected?.dependencies ?? [], evidenceNodeIds: selected?.evidenceNodeIds ?? [], targetFromNodeId: selected?.targetFromNodeId ?? null, targetToNodeId: selected?.targetToNodeId ?? null, resolutionNodeId: selected?.resolutionNodeId ?? null });
  return <form className="bible-actions__form" onSubmit={(event) => { event.preventDefault(); onSave(() => selected ? updateForeshadow(projectId, selected.id, { ...payload(), expectedUpdatedAt: selected.updatedAt }) : createForeshadow(projectId, payload())); }}><Field label={t("bible.fields.editTarget")}><select value={selected?.id ?? "new"} onChange={(event) => onSelect(event.target.value)}><option value="new">{t("bible.editor.newForeshadow")}</option>{bible.foreshadows.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></Field><Field label={t("bible.fields.title")}><input required value={title} onChange={(event) => setTitle(event.target.value)} /></Field><Field label={t("bible.fields.description")}><textarea value={description ?? ""} onChange={(event) => setDescription(event.target.value)} /></Field><Field label={t("bible.fields.status")}><select value={status} onChange={(event) => setStatus(event.target.value as Foreshadow["status"])}><option value="planned">{t("bible.foreshadowStatus.planned")}</option><option value="planted">{t("bible.foreshadowStatus.planted")}</option><option value="developing">{t("bible.foreshadowStatus.developing")}</option><option value="resolved">{t("bible.foreshadowStatus.resolved")}</option><option value="abandoned">{t("bible.foreshadowStatus.abandoned")}</option></select></Field><Field label={t("bible.fields.importance")}><input type="number" min="1" max="5" value={importance} onChange={(event) => setImportance(Number(event.target.value) as Foreshadow["importance"])} /></Field><Buttons pending={pending}>{selected ? <RemoveResourceButton pending={pending} label={t("bible.editor.removeForeshadow")} onConfirm={() => onSave(() => removeForeshadow(projectId, selected))} /> : null}</Buttons></form>;
}

function ContextForm({ bible, pending, onSubmit }: { bible: StoryBible; pending: boolean; onSubmit: (input: Parameters<typeof previewContext>[1]) => void }) {
  const { t } = useI18n();
  const [task, setTask] = useState("chapter-draft"); const [query, setQuery] = useState(""); const [nodeId, setNodeId] = useState(""); const [entityIds, setEntityIds] = useState<string[]>([]);
  return <form className="bible-actions__form" onSubmit={(event) => { event.preventDefault(); onSubmit({ task, query, entityIds, currentOutlineNodeId: nodeId || null, access: { audience: "author", includeCandidates: true } }); }}><Field label={t("bible.fields.task")}><input value={task} onChange={(event) => setTask(event.target.value)} /></Field><Field label={t("bible.fields.query")}><textarea required value={query} onChange={(event) => setQuery(event.target.value)} /></Field><Field label={t("bible.editor.currentOutline")}><select value={nodeId} onChange={(event) => setNodeId(event.target.value)}><option value="">{t("common.state.none")}</option>{bible.outline.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select></Field><fieldset className="bible-actions__checks"><legend>{t("bible.editor.entityScope")}</legend>{bible.entities.map((entity) => <label key={entity.id}><input type="checkbox" checked={entityIds.includes(entity.id)} onChange={() => setEntityIds((current) => current.includes(entity.id) ? current.filter((id) => id !== entity.id) : [...current, entity.id])} />{entity.name}</label>)}</fieldset><Buttons pending={pending} /></form>;
}
function ContextResult({ value }: { value: ContextPreview }) {
  const { t } = useI18n();
  return <div className="bible-actions__result"><h3>{t("bible.editor.contextReceipt")}</h3><pre>{JSON.stringify(value, null, 2)}</pre></div>;
}
