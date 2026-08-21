import { useEffect, useRef, useState, type ReactNode } from "react";

import { getLocale, translate, useI18n } from "../i18n";

import "./trial-access-gate.css";

const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const NETWORK_TIMEOUT_MS = 10_000;
const trialMode = import.meta.env.VITE_TRIAL_MODE === "1";

interface TurnstileApi {
  remove(widgetId: string): void;
  render(
    container: HTMLElement,
    options: {
      action: string;
      appearance: "always";
      callback(token: string): void;
      "error-callback"(): void;
      "expired-callback"(): void;
      sitekey: string;
      size: "compact" | "flexible";
      theme: "auto";
    },
  ): string;
  reset(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileLoad: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileLoad) return turnstileLoad;
  turnstileLoad = new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      "script[data-narrative-turnstile]",
    );
    const script = existing ?? document.createElement("script");
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      callback();
    };
    const loaded = () =>
      finish(() =>
        window.turnstile
          ? resolve(window.turnstile)
          : reject(new Error("Turnstile API missing after script load")),
      );
    const timeout = window.setTimeout(
      () => finish(() => reject(new Error("Turnstile script load timed out"))),
      NETWORK_TIMEOUT_MS,
    );
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener(
      "error",
      () =>
        finish(() => reject(new Error("Turnstile script failed to load"))),
      { once: true },
    );
    if (!existing) {
      script.src = TURNSTILE_SCRIPT;
      script.async = true;
      script.defer = true;
      script.dataset.narrativeTurnstile = "true";
      document.head.append(script);
    }
  }).catch((error) => {
    turnstileLoad = null;
    throw error;
  });
  return turnstileLoad;
}

function sessionUrl(): string | null {
  const relayUrl = import.meta.env.VITE_DEMO_RELAY_URL as string | undefined;
  if (!relayUrl) return null;
  return new URL("/session", relayUrl).toString();
}

export function TrialAccessGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [state, setState] = useState<"checking" | "challenge" | "ready">(
    trialMode ? "checking" : "ready",
  );
  const [message, setMessage] = useState<string | null>(null);
  const [challengeAttempt, setChallengeAttempt] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const endpoint = sessionUrl();
  const sitekey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

  useEffect(() => {
    if (!trialMode || !endpoint) return;
    let disposed = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      NETWORK_TIMEOUT_MS,
    );
    void fetch(endpoint, {
      credentials: "include",
      signal: controller.signal,
    })
      .then((response) => {
        if (!disposed) setState(response.ok ? "ready" : "challenge");
      })
      .catch(() => {
        if (disposed) return;
        setMessage(translate(getLocale(), "shell.trial.timeout"));
        setState("challenge");
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [endpoint]);

  useEffect(() => {
    if (state !== "challenge" || !endpoint || !sitekey || !container.current)
      return;
    let disposed = false;
    let api: TurnstileApi | null = null;
    let widgetId: string | null = null;
    void loadTurnstile()
      .then((turnstile) => {
        if (disposed || !container.current) return;
        api = turnstile;
        widgetId = turnstile.render(container.current, {
          sitekey,
          action: "trial-session",
          appearance: "always",
          size:
            container.current.clientWidth < 300 ? "compact" : "flexible",
          theme: "auto",
          callback: (token) => {
            setMessage(null);
            const controller = new AbortController();
            const timeout = window.setTimeout(
              () => controller.abort(),
              NETWORK_TIMEOUT_MS,
            );
            void fetch(endpoint, {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ token }),
              signal: controller.signal,
            })
              .then((response) => {
                if (!response.ok)
                  throw new Error(translate(getLocale(), "shell.trial.rejected"));
                setState("ready");
              })
              .catch((error: unknown) => {
                setMessage(
                  error instanceof Error
                    ? error.message
                    : translate(getLocale(), "shell.trial.rejected"),
                );
                if (api && widgetId) api.reset(widgetId);
              })
              .finally(() => window.clearTimeout(timeout));
          },
          "error-callback": () =>
            setMessage(translate(getLocale(), "shell.trial.unavailable")),
          "expired-callback": () => {
            if (api && widgetId) api.reset(widgetId);
          },
        });
      })
      .catch(() => {
        document
          .querySelector<HTMLScriptElement>("script[data-narrative-turnstile]")
          ?.remove();
        setMessage(translate(getLocale(), "shell.trial.loadFailed"));
      });
    return () => {
      disposed = true;
      if (api && widgetId) api.remove(widgetId);
    };
  }, [challengeAttempt, endpoint, sitekey, state]);

  if (state === "ready") return children;

  const configurationMissing = !endpoint || !sitekey;
  return (
    <main className="trial-access" aria-busy={state === "checking"}>
      <section className="trial-access__card" aria-live="polite">
        <p className="trial-access__eyebrow mono">NarraLume</p>
        <h1>{t("shell.trial.title")}</h1>
        <p>
          {configurationMissing
            ? t("shell.trial.configMissing")
            : state === "checking"
              ? t("shell.trial.checking")
              : t("shell.trial.challenge")}
        </p>
        {!configurationMissing && state === "challenge" ? (
          <div className="trial-access__widget" ref={container} />
        ) : null}
        {message ? <p className="trial-access__error">{message}</p> : null}
        {message && !configurationMissing ? (
          <button
            type="button"
            className="trial-access__retry btn"
            onClick={() => {
              setMessage(null);
              setChallengeAttempt((attempt) => attempt + 1);
            }}
          >
            {t("shell.trial.reload")}
          </button>
        ) : null}
      </section>
    </main>
  );
}
