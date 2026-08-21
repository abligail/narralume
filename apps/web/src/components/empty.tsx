import type { ReactNode } from "react";

import { useI18n } from "../i18n";

import { Seal } from "./seal";

/* 通用空态：一枚小朱印 + 宋体题句 + 描述 + 可选动作。 */

interface EmptyProps {
  seal?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  titleAs?: "h1" | "h2";
  sealVariant?: "empty" | "hero";
}

export function Empty({
  seal = "空",
  title,
  description,
  action,
  titleAs: Title = "h2",
  sealVariant = "empty",
}: EmptyProps) {
  const { t } = useI18n();
  return (
    <div className="empty">
      <Seal
        char={seal}
        variant={sealVariant}
        label={t("components.empty.sealLabel", { char: seal })}
      />
      <Title className="empty__title">{title}</Title>
      {description ? <p className="empty__description">{description}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}
