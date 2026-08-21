import type { ReactNode } from "react";

import { useFocusTrap } from "../app/focus-trap";
import { useI18n } from "../i18n";

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  pending?: boolean;
  confirmDisabled?: boolean;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  pending = false,
  confirmDisabled = false,
  danger = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(onCancel);
  const { t } = useI18n();
  return (
    <div
      className="confirm-dialog__backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div
        ref={trapRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <h2 id="confirm-dialog-title">{title}</h2>
        <div className="confirm-dialog__body">{children}</div>
        <div className="confirm-dialog__actions">
          <button type="button" className="btn btn--outline" disabled={pending} onClick={onCancel}>
            {t("common.action.cancel")}
          </button>
          <button
            type="button"
            className={danger ? "btn btn--danger" : "btn btn--primary"}
            disabled={pending || confirmDisabled}
            onClick={onConfirm}
          >
            {pending ? t("components.confirmDialog.pending") : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
