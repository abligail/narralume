import { useSyncExternalStore } from "react";

import { enMessages } from "./en";
import { zhMessages, type Messages } from "./zh";

/* 轻量 i18n：双语字典 + 模块级 locale 单例，React 侧经 useSyncExternalStore 订阅。
   字典按模块分文件（zh/en 同构，TS 强制两边键形一致），调用侧以点路径取文案。 */

export type Locale = "zh-CN" | "en";

export const LOCALES: readonly Locale[] = ["zh-CN", "en"] as const;

export const LOCALE_LABELS: Record<Locale, string> = {
  "zh-CN": "中文",
  en: "English",
};

const STORAGE_KEY = "narralume:ui-locale";

const MESSAGES: Record<Locale, Messages> = {
  "zh-CN": zhMessages,
  en: enMessages,
};

type FlattenKeys<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : `${K}.${FlattenKeys<T[K]>}`;
}[keyof T & string];

/** 全部合法字典键（点路径），如 "common.action.save"。 */
export type MessageKey = FlattenKeys<Messages>;

export type MessageVars = Record<string, string | number>;

function lookup(locale: Locale, key: string): string | null {
  let node: unknown = MESSAGES[locale];
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : null;
}

const warnedKeys = new Set<string>();

/** 非 React 环境也可用的纯翻译函数；变量插值格式为 {name}。 */
export function translate(
  locale: Locale,
  key: MessageKey,
  vars?: MessageVars,
): string {
  const template = lookup(locale, key) ?? lookup("en", key);
  if (template === null) {
    if (!warnedKeys.has(key)) {
      warnedKeys.add(key);
      console.warn(`[i18n] missing message key: ${key}`);
    }
    return key;
  }
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (raw, name: string) =>
    name in vars ? String(vars[name]) : raw,
  );
}

function detectInitialLocale(): Locale {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "zh-CN" || saved === "en") return saved;
  } catch {
    /* 私密模式下视为未存储 */
  }
  if (
    typeof navigator !== "undefined" &&
    (navigator.language ?? "").toLowerCase().startsWith("zh")
  ) {
    return "zh-CN";
  }
  return "en";
}

let currentLocale: Locale = detectInitialLocale();

const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* 私密模式下只保留当前会话状态 */
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

if (typeof document !== "undefined") {
  document.documentElement.lang = currentLocale;
}

export interface I18n {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, vars?: MessageVars) => string;
}

/** React 侧入口：订阅 locale 变化并给出翻译函数。 */
export function useI18n(): I18n {
  const locale = useSyncExternalStore(subscribe, getLocale);
  return {
    locale,
    setLocale,
    t: (key, vars) => translate(locale, key, vars),
  };
}
