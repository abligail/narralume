[中文](deploy-cloud.md)

# Cloudflare Deployment and Operations

## Decide whether you need this document first

Most NarraLume users do not need to deploy Cloudflare, a Relay, or a Bridge:

| How you use NarraLume                                                                | Recommended path                                                                        | Bridge needed? |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------- |
| Just want to try the hosted demo                                                     | Browser-local kernel; use the site's trial Relay when AI is needed                      | No             |
| Self-hosting on Windows, macOS/Linux, or Docker                                      | The local Server calls your configured provider channels directly                       | No             |
| Maintaining a public hosted demo whose upstream model is only reachable from your PC | Web → Cloudflare Relay → Tunnel/Access → Bridge on the maintainer's PC → upstream model | Yes            |

The Bridge is a local forwarder on the maintainer's PC. It is not a required NarraLume backend, and ordinary users never need to install it. Only adopt the production path below when a public Relay must securely reach an upstream on a local machine or private network.

## Hosted demo and deployment boundaries

[https://app.narralume.me/](https://app.narralume.me/) is the current public hosted demo.
It uses the browser-local kernel; projects live in browser OPFS and do not depend on a cloud database.

Production Worker names, custom domains, upstream addresses, and local operations commands are deployment-environment configuration and live in the Git-ignored `.deploy-local/`. The `apps/*/wrangler.toml` files in the public repository are copyable templates only: they do not represent the production topology, and Relay or Bridge configuration cannot be inferred from the hosted site address.

Only the third scenario above needs these three components with separate responsibilities:

| Component | Where it runs                    | Responsibility                                                                     | Sensitive material it holds                             |
| --------- | -------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Web       | Cloudflare Workers Static Assets | Hosts `apps/web/dist` and the browser kernel                                       | None; the Turnstile Site Key is a public build variable |
| Relay     | Cloudflare Worker                | Validates origin, sessions, rate limits, quotas, and the model allowlist           | Access, Bridge, Turnstile, and session-signing secrets  |
| Bridge    | Maintainer's PC                  | Listens on a loopback port and forwards streaming responses to the chosen upstream | The upstream API key and the Bridge shared secret       |

Both Web and Relay use `wrangler deploy`. The frontend uses Workers Static Assets, with SPA misses falling back to `index.html`; no separate Pages publishing flow is kept.

The model request path for the hosted demo is:

```text
browser
  → Web static site
  → Relay (origin checks, Turnstile, session, rate limits, and quota)
  → Cloudflare Tunnel / Access
  → Bridge on the maintainer's PC (127.0.0.1:4320)
  → the chosen upstream model
```

The browser never holds the maintainer's upstream key, and the Relay does not store the upstream API key; the Bridge only performs controlled forwarding.

## Configuration layers

Public templates:

- `apps/web/wrangler.toml`: static asset directory and SPA fallback.
- `apps/relay/wrangler.toml`: Relay variables, Rate Limiting, and Durable Object bindings.
- `apps/bridge/.env.example`: Bridge options without real values.
- `scripts/deploy-web.mjs`: writes the `VITE_*` build variables into the frontend before uploading.

Local production configuration:

- `.deploy-local/wrangler-web.toml`: the real Web Worker and route.
- `.deploy-local/wrangler-relay.toml`: the real Relay Worker, route, Web Origin, Bridge address, and models.
- `.deploy-local/deploy-production.ps1`: deploys `relay`, `web`, or `both`.
- `apps/bridge/.env.local`: Bridge upstream credentials and runtime limits.
- `apps/relay/.env.local`: credentials needed for local Relay smoke tests; not the Worker's configuration source.
- `apps/web/.env.local`: the public Turnstile Site Key, loaded at build time.

`.deploy-local/` and every `.env.local` must stay Git-ignored. Cloudflare login state is managed by Wrangler and cloudflared outside the repository. No document, log, screenshot, or build artifact may contain a real API Key, Access Service Token, Bridge shared secret, or session-signing key.

## Security prerequisites

These conditions only apply if you decide to maintain a public Relay:

1. The Bridge listens only on `127.0.0.1:4320`, is exposed through Cloudflare Tunnel, and opens no inbound port on the machine.
2. The Bridge's published application uses Cloudflare Access Service Auth; the Access Service Token is given only to the Relay Worker.
3. The upstream API key exists only on the Bridge machine; neither the browser nor the Relay may hold it.
4. The Relay accepts only `/v1/chat/completions`, strips client authentication headers, and enforces the model allowlist.
5. The Relay validates the single Web Origin, request-body limits, upstream timeouts, and error responses, and does not log prompts, request bodies, or response bodies.
6. For origins that require Turnstile, the Relay must call Siteverify and validate the hostname and action; rendering the widget alone is not protection.
7. Origins from mainland China are issued sessions directly by the Relay based on `request.cf.country`; other origins receive a 24-hour, IP-bound `__Host-`, `HttpOnly`, `Secure`, `SameSite=Strict` cookie after passing Turnstile.
   `SESSION_SIGNING_KEY` must be 64 lowercase hexadecimal characters; generate it with `openssl rand -hex 32`, and keep it separate from the Bridge shared secret.
8. Model requests are limited to 30 per minute per signed session, with a Durable Object atomically enforcing 60 effective calls per session.
9. On the Cloudflare side, configure cost alerts, minimize logging, and keep an operational path that can shut down the Relay/Tunnel immediately.

## First-time preparation

Install dependencies and log in to a Cloudflare account with access to the target zone:

```powershell
npm ci
npx wrangler login
npx wrangler whoami
```

In Cloudflare, complete the Tunnel, Access Service Auth, Service Token, and Turnstile Managed Widget setup. The Turnstile hostname may only allow the actual Web hostname.

The Relay Worker needs these remote secrets:

- `BRIDGE_ACCESS_CLIENT_ID`
- `BRIDGE_ACCESS_CLIENT_SECRET`
- `BRIDGE_SHARED_SECRET`
- `TURNSTILE_SECRET_KEY`
- `SESSION_SIGNING_KEY`

Write each value into the real Relay configuration. The commands read values interactively; do not put values into your command history:

```powershell
npx wrangler secret put BRIDGE_ACCESS_CLIENT_ID --config .deploy-local/wrangler-relay.toml
npx wrangler secret put BRIDGE_ACCESS_CLIENT_SECRET --config .deploy-local/wrangler-relay.toml
npx wrangler secret put BRIDGE_SHARED_SECRET --config .deploy-local/wrangler-relay.toml
npx wrangler secret put TURNSTILE_SECRET_KEY --config .deploy-local/wrangler-relay.toml
npx wrangler secret put SESSION_SIGNING_KEY --config .deploy-local/wrangler-relay.toml
```

Check only the secret names; never read or print secret values:

```powershell
npx wrangler secret list --config .deploy-local/wrangler-relay.toml
```

## Pre-deployment checks

Before every production deployment, run:

```powershell
npm run verify
npx wrangler deploy --dry-run --config .deploy-local/wrangler-relay.toml
npx wrangler deploy --dry-run --config .deploy-local/wrangler-web.toml
```

Also confirm:

- `Invoke-RestMethod http://127.0.0.1:4320/health` succeeds.
- `Get-ScheduledTask -TaskName "NarraLume Bridge"` is in a runnable state.
- `Get-Service Cloudflared` is `Running`, and the Tunnel shows Healthy in the Cloudflare dashboard.
- The Web build variables point at the Relay from the same release, and model names match the Relay allowlist.
- `apps/web/dist` contains no API Key, Access Token, Bridge Secret, or internal address.
- The Git diff contains no `.env.local`, `.deploy-local/`, or Wrangler authentication files.

`VITE_DEMO_RELAY_URL`, `VITE_DEMO_RELAY_MODEL`, `VITE_TRIAL_MODE`, and `VITE_TURNSTILE_SITE_KEY` are all build-time variables. After changing them you must rebuild the Web app instead of uploading an old `dist`. For a deployment from the public templates you may use `npm run deploy:web`; local production deployments should use the script in the next section to avoid missing variables by hand or picking the wrong route.

## Production deployment

Pick a target based on what changed:

| Change                                                    | Deployment action                                        |
| --------------------------------------------------------- | -------------------------------------------------------- |
| `apps/relay`, the Relay route, or bindings                | `-Target relay`                                          |
| `apps/web` or any `packages` code entering the web bundle | `-Target web`                                            |
| Protocol, models, or URLs changing on both sides          | `-Target both`; the script deploys Relay first, then Web |
| Only replacing a Worker secret                            | `wrangler secret put`, then run the Relay smoke test     |
| Bridge code or `.env.local`                               | Rebuild and restart the Bridge scheduled task            |

Run from the repository root:

```powershell
powershell -File .deploy-local/deploy-production.ps1 -Target relay
powershell -File .deploy-local/deploy-production.ps1 -Target web
powershell -File .deploy-local/deploy-production.ps1 -Target both
```

Do not deploy both ends at once and then debug them together. When both sides are involved, confirm the Relay's rejection rules and controlled calls work first, then publish the Web app.

Refreshing the resident task after a Bridge code update:

```powershell
npm run build
npm run install:bridge-task
```

If the task already exists, you can also restart it explicitly after building:

```powershell
Stop-ScheduledTask -TaskName "NarraLume Bridge"
Start-ScheduledTask -TaskName "NarraLume Bridge"
```

## Post-deployment acceptance

Accept in this order; do not start with a real model request:

1. The Web homepage returns 200, and the title, JS/CSS assets, and client-side routes load.
2. The Relay returns 204 with the restricted CORS headers for an `OPTIONS` request from the correct Origin.
3. The Relay returns 403 for an unknown Origin and 401 for a model request without a session.
4. The Bridge's public entry point returns an Access denial without Access credentials; the local service must not be reachable directly.
5. Origins from mainland China receive a secure cookie without loading Turnstile; other origins receive a cookie after Turnstile succeeds, while a wrong token, hostname, or action is rejected.
6. Run one controlled streaming generation to confirm the full path through Relay, Access, Bridge, and the upstream.
7. Verify the rate limit, the 60-call session quota, request-body limits, timeouts, and rejection of models outside the allowlist.
8. Verify OPFS persistence after a browser refresh, SQLite download/import/export, and that a bring-your-own-key provider calls the user's upstream directly without going through the Relay.

These basic probes carry no sensitive information; replace the variables with the actual public addresses:

```powershell
$WebOrigin = "https://web.example.com"
$RelayBase = "https://relay.example.com"
curl.exe -I $WebOrigin
curl.exe -i -X OPTIONS "$RelayBase/v1/chat/completions" `
  -H "Origin: $WebOrigin" `
  -H "Access-Control-Request-Method: POST"
curl.exe -i -X POST "$RelayBase/v1/chat/completions" `
  -H "Origin: https://invalid.example" `
  -H "Content-Type: application/json" `
  --data "{}"
```

The real Bridge public smoke test runs only in an authorized maintenance environment:

```powershell
npm run test:real:bridge-public
```

## Resident monitoring and troubleshooting

Local Windows path:

```powershell
Get-ScheduledTask -TaskName "NarraLume Bridge"
Get-ScheduledTaskInfo -TaskName "NarraLume Bridge"
Invoke-RestMethod http://127.0.0.1:4320/health
Get-Service Cloudflared
```

Troubleshoot from the inside of the chain outward: Bridge local health, the cloudflared service, Tunnel/Access, Relay rejection rules, Web build variables. When reviewing Worker or Tunnel logs, keep only status codes, durations, and request IDs; never output Authorization headers, cookies, prompts, or bodies.

## Rollback and emergency stop

First determine whether the fault is in Web, Relay, or Bridge, and roll back only that component:

```powershell
npx wrangler rollback --config .deploy-local/wrangler-relay.toml
npx wrangler rollback --config .deploy-local/wrangler-web.toml
```

After rolling back the Bridge, rebuild and restart the `NarraLume Bridge` task. On a key leak, rolling back code alone is not enough: immediately revoke and rotate the affected upstream key, Access Service Token, Bridge secret, or session-signing key.

When you need to stop losses immediately, first disable the Relay custom domain or the Tunnel in Cloudflare so the public model path stops, while keeping the Web static site available for local functionality. Web/Relay publishing and rollback never touch browser OPFS.
