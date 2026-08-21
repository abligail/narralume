import type { NarrativeDatabase } from "./database.js";

export type WireApi = "openai-chat" | "openai-responses" | "anthropic-messages";

export interface StoredProvider {
  id: string;
  name: string;
  wireApi: WireApi;
  baseUrl: string;
  endpoint: string | null;
  /** Raw API key, or an indirect reference of the form `env:NAME`. */
  credentialRef: string;
  anthropicVersion: string | null;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  requestStartTimeoutMs: number | null;
  streamIdleTimeoutMs: number | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** StoredProvider with the credential masked for API responses. */
export type PublicProvider = Omit<StoredProvider, "credentialRef"> & {
  credentialRef: string;
};

export type ResolvedCredential =
  | { ok: true; apiKey: string }
  | { ok: false; reason: "missing_env"; name: string }
  | { ok: false; reason: "empty" };

export class ConfigurationVersionConflictError extends Error {
  constructor(
    readonly entity: "provider" | "model",
    readonly id: string,
  ) {
    super(`${entity} ${id} was updated elsewhere; refresh and try again`);
    this.name = "ConfigurationVersionConflictError";
  }
}

interface ProviderRow {
  id: string;
  name: string;
  wire_api: WireApi;
  base_url: string;
  endpoint: string | null;
  credential_ref: string;
  anthropic_version: string | null;
  headers_json: string | null;
  query_params_json: string | null;
  request_start_timeout_ms: number | null;
  stream_idle_timeout_ms: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export class SqliteProviderRepository {
  constructor(private readonly database: NarrativeDatabase) {}

  upsert(provider: StoredProvider): StoredProvider {
    this.database.raw
      .prepare(
        `
        INSERT INTO providers(
          id, name, wire_api, base_url, endpoint, credential_ref,
          anthropic_version, headers_json, query_params_json,
          request_start_timeout_ms, stream_idle_timeout_ms,
          enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          wire_api = excluded.wire_api,
          base_url = excluded.base_url,
          endpoint = excluded.endpoint,
          credential_ref = excluded.credential_ref,
          anthropic_version = excluded.anthropic_version,
          headers_json = excluded.headers_json,
          query_params_json = excluded.query_params_json,
          request_start_timeout_ms = excluded.request_start_timeout_ms,
          stream_idle_timeout_ms = excluded.stream_idle_timeout_ms,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        provider.id,
        provider.name,
        provider.wireApi,
        provider.baseUrl,
        provider.endpoint,
        provider.credentialRef,
        provider.anthropicVersion,
        JSON.stringify(provider.headers),
        JSON.stringify(provider.queryParams),
        provider.requestStartTimeoutMs,
        provider.streamIdleTimeoutMs,
        provider.enabled ? 1 : 0,
        provider.createdAt,
        provider.updatedAt,
      );
    return provider;
  }

  update(provider: StoredProvider, expectedUpdatedAt: string): StoredProvider {
    const result = this.database.raw
      .prepare(
        `UPDATE providers SET name = ?, wire_api = ?, base_url = ?, endpoint = ?,
           credential_ref = ?, anthropic_version = ?, headers_json = ?,
           query_params_json = ?, request_start_timeout_ms = ?,
           stream_idle_timeout_ms = ?, enabled = ?, updated_at = ?
         WHERE id = ? AND updated_at = ?`,
      )
      .run(
        provider.name,
        provider.wireApi,
        provider.baseUrl,
        provider.endpoint,
        provider.credentialRef,
        provider.anthropicVersion,
        JSON.stringify(provider.headers),
        JSON.stringify(provider.queryParams),
        provider.requestStartTimeoutMs,
        provider.streamIdleTimeoutMs,
        provider.enabled ? 1 : 0,
        provider.updatedAt,
        provider.id,
        expectedUpdatedAt,
      );
    if (result.changes !== 1) {
      throw new ConfigurationVersionConflictError("provider", provider.id);
    }
    return this.get(provider.id)!;
  }

  get(id: string): StoredProvider | null {
    const row = this.database.raw
      .prepare("SELECT * FROM providers WHERE id = ?")
      .get(id) as ProviderRow | undefined;
    return row ? mapProvider(row) : null;
  }

  list(enabledOnly = false): StoredProvider[] {
    const rows = this.database.raw
      .prepare(
        enabledOnly
          ? "SELECT * FROM providers WHERE enabled = 1 ORDER BY name"
          : "SELECT * FROM providers ORDER BY name",
      )
      .all() as unknown as ProviderRow[];
    return rows.map(mapProvider);
  }

  delete(id: string): boolean {
    return (
      this.database.raw.prepare("DELETE FROM providers WHERE id = ?").run(id)
        .changes === 1
    );
  }
}

/**
 * Resolves the effective API key for a provider without ever throwing.
 * `env:NAME` refs are read from the injected environment; anything else is
 * a raw key.
 */
export function resolveCredential(
  provider: Pick<StoredProvider, "credentialRef">,
  environment: Readonly<Record<string, string | undefined>>,
): ResolvedCredential {
  const ref = provider.credentialRef;
  if (ref.startsWith("env:")) {
    const name = ref.slice("env:".length);
    const value = environment[name];
    if (value === undefined) return { ok: false, reason: "missing_env", name };
    if (value.length === 0) return { ok: false, reason: "empty" };
    return { ok: true, apiKey: value };
  }
  if (ref.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, apiKey: ref };
}

/**
 * Masks the credential for API responses. `env:NAME` refs are not secret and
 * are returned as-is; raw keys become `••••` + last 4 chars, or are fully
 * masked when shorter than 8 characters.
 */
export function publicProvider(provider: StoredProvider): PublicProvider {
  return {
    ...provider,
    credentialRef: maskCredential(provider.credentialRef),
    headers: maskStringRecord(provider.headers),
    queryParams: maskStringRecord(provider.queryParams),
  };
}

function maskCredential(ref: string): string {
  if (ref.startsWith("env:")) return ref;
  return maskSecret(ref);
}

function maskStringRecord(
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, maskSecret(value)]),
  );
}

function maskSecret(value: string): string {
  if (value.length < 8) return "••••••••";
  return `••••${value.slice(-4)}`;
}

function mapProvider(row: ProviderRow): StoredProvider {
  return {
    id: row.id,
    name: row.name,
    wireApi: row.wire_api,
    baseUrl: row.base_url,
    endpoint: row.endpoint,
    credentialRef: row.credential_ref,
    anthropicVersion: row.anthropic_version,
    headers: parseStringRecord(row.headers_json),
    queryParams: parseStringRecord(row.query_params_json),
    requestStartTimeoutMs: row.request_start_timeout_ms,
    streamIdleTimeoutMs: row.stream_idle_timeout_ms,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseStringRecord(value: string | null): Record<string, string> {
  if (value === null) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
