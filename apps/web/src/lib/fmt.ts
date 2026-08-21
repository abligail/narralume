/* 格式化助手（从各旧视图去重搬入）。日期 / 数字的 locale 跟随界面语言。 */

import { getLocale, translate, type Locale } from "../i18n";

export function shortId(value: string): string {
  return value.slice(0, 8);
}

export function shortHash(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function formatTime(value: string, locale: Locale = getLocale()): string {
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatRelativeDate(
  value: string,
  locale: Locale = getLocale(),
): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return translate(locale, "common.time.justNow");
  }
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return translate(locale, "common.time.today");
  if (days === 1) return translate(locale, "common.time.yesterday");
  if (days < 30) return translate(locale, "common.time.daysAgo", { days });
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

export function countCharacters(value: string): number {
  return [...value].length;
}

export function formatCount(value: number, locale: Locale = getLocale()): string {
  return new Intl.NumberFormat(locale, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let current = value / 1024;
  for (const unit of units) {
    if (current < 1024) return `${current.toFixed(1)} ${unit}`;
    current /= 1024;
  }
  return `${current.toFixed(1)} TB`;
}

/** 由任意 id 推出稳定的封面色相（书架封面的 id-hash hue）。 */
export function coverHue(value: string): number {
  return [...value].reduce(
    (hash, character) => (hash * 31 + character.charCodeAt(0)) % 360,
    28,
  );
}
