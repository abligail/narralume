import type { LucideIcon } from "lucide-react";
import { Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { useI18n } from "../i18n";

import { useFocusTrap } from "./focus-trap";
import { ADVANCED_WORKSPACES, QUICK_WORKSPACES, WORKSPACES, workspacePath } from "./workspaces";

/* ⌘K 命令面板：五个工作面、AI 快速创作与高级工具。 */

interface CommandItem {
  id: string;
  label: string;
  key: string;
  icon: LucideIcon;
  keywords: string;
  run: () => void;
}

interface CommandPaletteProps {
  projectId: string | null;
  onClose: () => void;
}

export function CommandPalette({ projectId, onClose }: CommandPaletteProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(onClose);

  const commands = useMemo<CommandItem[]>(() => {
    const entries: CommandItem[] = [
      ...WORKSPACES,
      ...QUICK_WORKSPACES,
      ...ADVANCED_WORKSPACES,
    ].map((item, position) => {
      const itemLabel = t(item.label);
      return {
        id: `go-${item.id}`,
        label: t("shell.nav.goTo", { label: itemLabel }),
        key:
          position < WORKSPACES.length
            ? `${item.index} · ${item.en}`
            : item.id === "autopilot" ? `AI · ${item.en}` : `${t("shell.palette.hintAdvanced")} · ${item.en}`,
        icon: item.icon,
        keywords: `${itemLabel} ${item.en} ${item.path} ${t(item.blurb)}`,
        run: () => {
          onClose();
          navigate(workspacePath(item, projectId));
        },
      };
    });
    return entries;
  }, [navigate, onClose, projectId, t]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter(
      (item) =>
        item.label.toLowerCase().includes(needle) ||
        item.keywords.toLowerCase().includes(needle),
    );
  }, [commands, query]);

  useEffect(() => {
    const active = listRef.current?.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      ref={trapRef}
      className="palette"
      role="dialog"
      aria-modal="true"
      aria-label={t("shell.palette.title")}
      tabIndex={-1}
      data-lenis-prevent
    >
      <div className="palette__frame">
        <div className="palette__prompt">
          <Search
            size={20}
            strokeWidth={1.5}
            className="palette__prompt-icon"
            aria-hidden="true"
          />
          <input
            className="palette__input"
            role="combobox"
            aria-label={t("shell.palette.search")}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded="true"
            aria-activedescendant={
              filtered[activeIndex]
                ? `${listId}-${filtered[activeIndex].id}`
                : undefined
            }
            placeholder={t("shell.palette.placeholder")}
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((index) =>
                  Math.min(filtered.length - 1, index + 1),
                );
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) => Math.max(0, index - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                filtered[Math.min(activeIndex, filtered.length - 1)]?.run();
              }
            }}
          />
          <button
            type="button"
            className="palette__close"
            aria-label={t("shell.palette.close")}
            onClick={onClose}
          >
            <X size={19} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
        <div className="palette__list" ref={listRef} role="listbox" id={listId}>
          {filtered.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                id={`${listId}-${item.id}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className="palette__command"
                data-active={index === activeIndex}
                onClick={item.run}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <Icon
                  size={15}
                  strokeWidth={1.5}
                  className="palette__command-icon"
                  aria-hidden="true"
                />
                <span className="palette__command-label">{item.label}</span>
                <span className="palette__command-key mono">{item.key}</span>
              </button>
            );
          })}
          {filtered.length === 0 ? (
            <p className="palette__none">{t("shell.palette.noResults")}</p>
          ) : null}
        </div>
        <div className="palette__foot" aria-hidden="true">
          <span>
            <span className="palette__kbd">↑↓</span> {t("shell.palette.footerSelect")}
          </span>
          <span>
            <span className="palette__kbd">Enter</span> {t("shell.palette.footerRun")}
          </span>
          <span>
            <span className="palette__kbd">Esc</span> {t("common.action.close")}
          </span>
        </div>
      </div>
    </div>
  );
}
