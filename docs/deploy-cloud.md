# Cloudflare 部署与运维

## 先判断你是否需要这份文档

大多数 NarraLume 用户不需要部署 Cloudflare、Relay 或 Bridge：

| 使用方式                                             | 推荐链路                                                                  | 是否需要 Bridge |
| ---------------------------------------------------- | ------------------------------------------------------------------------- | --------------- |
| 只想试用在线版                                       | 浏览器本地内核；需要 AI 时使用站点提供的体验 Relay                        | 否              |
| Windows、macOS/Linux 或 Docker 自托管                | 本地 Server 直接调用你配置的模型渠道                                      | 否              |
| 维护一个公开在线体验，且上游模型只能从维护者电脑访问 | Web → Cloudflare Relay → Tunnel/Access → 维护者电脑上的 Bridge → 上游模型 | 是              |

Bridge 是维护者电脑上的本机转发器，不是 NarraLume 的必需后端，也不是普通用户需要单独安装的服务。只有在公开 Relay 需要安全地访问本机或私有网络里的上游时，才采用下面的生产链路。

## 在线体验与部署边界

[https://app.narralume.me/](https://app.narralume.me/) 是当前公开在线体验。
它使用浏览器本地内核，作品保存在浏览器 OPFS，不依赖云端数据库。

生产 Worker 名称、自定义域、上游地址和本机运维命令属于部署环境配置，统一放在
Git 忽略的 `.deploy-local/` 中。公开仓库中的 `apps/*/wrangler.toml` 只作为可复制
模板，不代表生产拓扑，也不能从在线站点地址推断 Relay 或 Bridge 配置。

只有第三种场景才需要下面三个职责独立的组件：

| 组件   | 运行位置                         | 职责                                   | 持有的敏感信息                           |
| ------ | -------------------------------- | -------------------------------------- | ---------------------------------------- |
| Web    | Cloudflare Workers Static Assets | 托管 `apps/web/dist` 与浏览器内核      | 无；Turnstile Site Key 是公开构建变量    |
| Relay  | Cloudflare Worker                | 校验来源、会话、限流、额度和模型白名单 | Access、Bridge、Turnstile 与会话签名密钥 |
| Bridge | 维护者电脑                       | 监听本机端口，向指定上游转发流式响应   | 上游 API Key 与 Bridge 共享密钥          |

Web 和 Relay 都使用 `wrangler deploy`。前端采用 Workers Static Assets，SPA 未命中
路径回落到 `index.html`，不保留另一套 Pages 发布流程。

公开体验的模型请求路径是：

```text
浏览器
  → Web 静态站
  → Relay（来源校验、Turnstile、会话、限流和额度）
  → Cloudflare Tunnel / Access
  → 维护者电脑上的 Bridge（127.0.0.1:4320）
  → 指定的上游模型
```

浏览器不持有维护者的上游密钥，Relay 也不保存上游 API Key；Bridge 只承担受控转发。

## 配置分层

公开模板：

- `apps/web/wrangler.toml`：静态资源目录与 SPA 回退。
- `apps/relay/wrangler.toml`：Relay 变量、Rate Limiting、Durable Object 绑定。
- `apps/bridge/.env.example`：Bridge 可配置项，不包含真实值。
- `scripts/deploy-web.mjs`：将 `VITE_*` 构建变量写入前端后再上传。

本机生产配置：

- `.deploy-local/wrangler-web.toml`：真实 Web Worker 与 route。
- `.deploy-local/wrangler-relay.toml`：真实 Relay Worker、route、Web Origin、Bridge 地址和模型。
- `.deploy-local/deploy-production.ps1`：按 `relay`、`web` 或 `both` 部署。
- `apps/bridge/.env.local`：Bridge 上游凭据与运行限制。
- `apps/relay/.env.local`：本地 Relay smoke 所需凭据，不是 Worker 配置来源。
- `apps/web/.env.local`：公开的 Turnstile Site Key，构建时加载。

`.deploy-local/` 和所有 `.env.local` 都必须保持 Git 忽略。Cloudflare 登录状态由
Wrangler 和 cloudflared 在仓库外管理。任何文档、日志、截图和构建产物都不得包含
真实 API Key、Access Service Token、Bridge 共享密钥或会话签名密钥。

## 安全前置条件

只有决定维护公开 Relay 时，才需要满足以下条件：

1. Bridge 只监听 `127.0.0.1:4320`，通过 Cloudflare Tunnel 暴露，不开放本机入站端口。
2. Bridge 的 published application 使用 Cloudflare Access Service Auth；Access
   Service Token 只交给 Relay Worker。
3. 上游 API Key 只存在 Bridge 本机，浏览器和 Relay 都不能持有。
4. Relay 只接受 `/v1/chat/completions`，剥离客户端认证头并强制模型白名单。
5. Relay 校验唯一 Web Origin、请求体上限、上游超时和错误响应，不记录提示词、正文或响应正文。
6. 对需要 Turnstile 的来源，Relay 必须调用 Siteverify，并校验 hostname 与 action；只渲染 Widget 不算保护完成。
7. 中国大陆来源由 Relay 依据 `request.cf.country` 直接签发会话；其他来源通过
   Turnstile 后签发 24 小时、IP 绑定的 `__Host-`、`HttpOnly`、`Secure`、
   `SameSite=Strict` Cookie。
   `SESSION_SIGNING_KEY` 必须是 64 个小写十六进制字符；可用 `openssl rand -hex 32` 生成，且必须与 Bridge 共享密钥分开保存。
8. 模型请求按签名会话限制为每分钟 30 次，并由 Durable Object 原子限制每会话 60 次有效调用。
9. Cloudflare 侧配置成本告警、最小化日志和可立即关闭 Relay/Tunnel 的操作路径。

## 首次准备

安装依赖并登录拥有目标 zone 权限的 Cloudflare 账号：

```powershell
npm ci
npx wrangler login
npx wrangler whoami
```

在 Cloudflare 中完成 Tunnel、Access Service Auth、Service Token 和 Turnstile Managed
Widget。Turnstile 的 hostname 只允许实际 Web 主机名。

Relay Worker 需要以下远程 secrets：

- `BRIDGE_ACCESS_CLIENT_ID`
- `BRIDGE_ACCESS_CLIENT_SECRET`
- `BRIDGE_SHARED_SECRET`
- `TURNSTILE_SECRET_KEY`
- `SESSION_SIGNING_KEY`

逐项写入实际 Relay 配置，命令会交互读取值，不要把值放进命令历史：

```powershell
npx wrangler secret put BRIDGE_ACCESS_CLIENT_ID --config .deploy-local/wrangler-relay.toml
npx wrangler secret put BRIDGE_ACCESS_CLIENT_SECRET --config .deploy-local/wrangler-relay.toml
npx wrangler secret put BRIDGE_SHARED_SECRET --config .deploy-local/wrangler-relay.toml
npx wrangler secret put TURNSTILE_SECRET_KEY --config .deploy-local/wrangler-relay.toml
npx wrangler secret put SESSION_SIGNING_KEY --config .deploy-local/wrangler-relay.toml
```

只检查 secret 名称，不读取或输出 secret 值：

```powershell
npx wrangler secret list --config .deploy-local/wrangler-relay.toml
```

## 部署前检查

每次生产部署先完成：

```powershell
npm run verify
npx wrangler deploy --dry-run --config .deploy-local/wrangler-relay.toml
npx wrangler deploy --dry-run --config .deploy-local/wrangler-web.toml
```

另外确认：

- `Invoke-RestMethod http://127.0.0.1:4320/health` 成功。
- `Get-ScheduledTask -TaskName "NarraLume Bridge"` 为可运行状态。
- `Get-Service Cloudflared` 为 `Running`，Tunnel 在 Cloudflare 控制台显示 Healthy。
- Web 构建变量指向同一次发布的 Relay，并且模型名与 Relay 白名单一致。
- `apps/web/dist` 不包含 API Key、Access Token、Bridge Secret 或内部地址。
- Git diff 中没有 `.env.local`、`.deploy-local/` 或 Wrangler 认证文件。

`VITE_DEMO_RELAY_URL`、`VITE_DEMO_RELAY_MODEL`、`VITE_TRIAL_MODE` 和
`VITE_TURNSTILE_SITE_KEY` 都是构建期变量。修改后必须重新构建 Web，不能直接上传旧的
`dist`。公开模板部署可使用 `npm run deploy:web`；本机生产部署应使用下一节脚本，避免
手工遗漏变量或选错 route。

## 正式部署

按改动范围选择目标：

| 改动                                       | 部署动作                                    |
| ------------------------------------------ | ------------------------------------------- |
| `apps/relay`、Relay route 或绑定           | `-Target relay`                             |
| `apps/web` 或进入前端 bundle 的 `packages` | `-Target web`                               |
| 两侧协议、模型或 URL 同时变化              | `-Target both`，脚本先 Relay 后 Web         |
| 只更换 Worker secret                       | `wrangler secret put`，随后执行 Relay smoke |
| Bridge 代码或 `.env.local`                 | 重新构建并重启 Bridge 计划任务              |

从仓库根目录运行：

```powershell
powershell -File .deploy-local/deploy-production.ps1 -Target relay
powershell -File .deploy-local/deploy-production.ps1 -Target web
powershell -File .deploy-local/deploy-production.ps1 -Target both
```

不要同时部署两端后再一起排错。涉及两端时，先确认 Relay 拒绝规则和受控调用正常，
再发布 Web。

Bridge 代码更新后的常驻任务刷新：

```powershell
npm run build
npm run install:bridge-task
```

任务已经存在时也可以在构建后显式重启：

```powershell
Stop-ScheduledTask -TaskName "NarraLume Bridge"
Start-ScheduledTask -TaskName "NarraLume Bridge"
```

## 发布后验收

按以下顺序验收，不要一开始就发起真实模型请求：

1. Web 首页返回 200，标题、JS/CSS 资源和客户端路由可加载。
2. Relay 对正确 Origin 的 `OPTIONS` 返回 204 和限定的 CORS 头。
3. Relay 对未知 Origin 返回 403，对无会话模型请求返回 401。
4. Bridge 公网入口在没有 Access 凭据时返回 Access 拒绝，不能直达本机服务。
5. 中国大陆来源无需加载 Turnstile 即可获得安全 Cookie；其他来源在 Turnstile 成功后获得 Cookie，
   错误 token、hostname 或 action 均被拒绝。
6. 执行一次受控流式生成，确认 Relay、Access、Bridge 和上游完整链路。
7. 验证速率限制、60 次会话额度、请求体上限、超时和非白名单模型拒绝。
8. 验证浏览器刷新后的 OPFS 持久化、SQLite 下载/导入导出，以及自带 Key 的
   Provider 直接请求用户上游而不经过 Relay。

可用以下无敏感信息的基础探针，将变量替换为实际公开地址：

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

真实 Bridge 公网 smoke 只在已授权的维护环境运行：

```powershell
npm run test:real:bridge-public
```

## 常驻监控与排障

Windows 本机链路：

```powershell
Get-ScheduledTask -TaskName "NarraLume Bridge"
Get-ScheduledTaskInfo -TaskName "NarraLume Bridge"
Invoke-RestMethod http://127.0.0.1:4320/health
Get-Service Cloudflared
```

排障从链路内侧向外进行：Bridge 本机健康、cloudflared 服务、Tunnel/Access、Relay
拒绝规则、Web 构建变量。查看 Worker 或 Tunnel 日志时只保留状态码、耗时和请求 ID，
不要输出 Authorization、Cookie、提示词或正文。

## 回滚与紧急停止

先确定故障属于 Web、Relay 还是 Bridge，只回滚对应组件：

```powershell
npx wrangler rollback --config .deploy-local/wrangler-relay.toml
npx wrangler rollback --config .deploy-local/wrangler-web.toml
```

Bridge 回滚后重新构建并重启 `NarraLume Bridge` 任务。发生密钥泄露时不能只回滚代码，
必须立即撤销并轮换对应的上游 Key、Access Service Token、Bridge Secret 或会话签名密钥。

需要立即止损时，先在 Cloudflare 禁用 Relay custom domain 或 Tunnel，使公网模型链路
停止，再保留 Web 静态站用于本地功能。Web/Relay 发布和回滚不会主动修改浏览器 OPFS。
