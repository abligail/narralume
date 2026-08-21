import { apiErrorHint, apiErrorMessage } from "../lib/api";
import { useI18n } from "../i18n";

/* 错误注记：ApiError 的错误码提示优先，回退到后端 message。 */

interface ErrorNoteProps {
  error: unknown;
  title?: string;
}

export function ErrorNote({ error, title }: ErrorNoteProps) {
  const { t } = useI18n();
  const hint = apiErrorHint(error);
  const message = apiErrorMessage(error);
  return (
    <div className="error-note" role="alert">
      <p className="error-note__title">
        {title ?? t("components.errorNote.defaultTitle")}
      </p>
      <p className="error-note__message">{message}</p>
      {hint && hint !== message ? (
        <p className="error-note__hint">{hint}</p>
      ) : null}
    </div>
  );
}
