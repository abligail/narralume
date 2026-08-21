import { useI18n } from "../i18n";

interface SealProps {
  char: string;
  variant: "rail" | "empty" | "hero";
  label?: string;
}

/** 同一枚朱文印用于导航、普通空状态与页面级空状态，仅尺寸不同。 */
export function Seal({ char, variant, label }: SealProps) {
  const { t } = useI18n();
  return (
    <span
      className={`seal seal--${variant}`}
      role="img"
      aria-label={label ?? t("components.seal.label", { char })}
    >
      <span className="seal__char" aria-hidden="true">
        {char}
      </span>
    </span>
  );
}
