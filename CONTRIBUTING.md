# 参与贡献

感谢你改进 NarraLume。提交贡献即表示你同意按 Apache-2.0 许可该贡献，并遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。安全漏洞不要提交公开 Issue，请按 [SECURITY.md](SECURITY.md) 私密报告。

## 准备开发环境

需要 Node.js 24+、npm 11+。仓库使用 npm workspaces 和锁文件，首次安装及锁文件未变化的 CI/验证环境都使用 `npm ci`：

```bash
npm ci
npm run dev
```

开发 Web 在 `http://127.0.0.1:4318`，Server/API 在 `http://127.0.0.1:4317`。需要本地环境变量时，将 `.env.example` 复制为 `.env.local`；后者永远不得提交。

开始改动前：

1. 搜索现有 Issue、代码、依赖文档和类型定义，确认仓库中是否已有相同能力。
2. 找到功能所属层：`apps/web` 负责界面和浏览器内核，`apps/server` 负责本地 API，`packages/` 承载领域、服务和持久化，`deploy/` 与 `scripts/` 负责交付。
3. 先让最小端到端路径成立，再增加需要真实用例支撑的抽象。废弃路径直接移除，不添加兼容层或静默回退。
4. AI 输出保持候选语义；会改变正文、正典或数据边界的动作必须复用现有领域裁定和备份契约。

## 改动与测试

至少运行：

```bash
npm run verify
```

`verify` 包含格式、Lint、类型检查、单元/集成测试、证据协议、第三方许可证和生产构建。按改动范围补充：

| 改动                                      | 额外验证                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| 跨页面 UI、路由、交互或响应式布局         | `npm run test:e2e`，必要时附桌面和移动截图                                           |
| 覆盖共享服务、持久化或发布门槛            | `npm run test:coverage` 并说明阈值结果                                               |
| Dockerfile、Compose、Nginx 或容器环境变量 | 真实 `docker compose up -d --build` smoke、备份和重启持久化                          |
| 启动器或发行内容                          | 在目标系统运行 `npm run release:build`，解压到新目录后验证启动、健康检查、备份和停止 |
| Cloudflare Web/Relay                      | Wrangler dry-run；有授权环境时再做真实部署 smoke                                     |
| 新增或升级依赖                            | `npm run licenses:update`，审阅并提交 `THIRD_PARTY_NOTICES.md` 变化                  |

数据库 Schema 改动必须提供向前迁移和针对旧库升级的回归测试。项目快照或整库备份契约有变化时，同时验证导出、预览、恢复到新目录和计数/哈希检查；不要用当前数据库作为破坏性恢复目标。

真实模型测试只在你有权使用对应凭据和上游时运行。日志、截图和测试产物不得包含真实正文、完整模型响应、密钥或用户数据库。

面向用户的说明放在 `README.md`、`README.zh.md` 和 `docs/` 的公开入口中；产品研究、状态记录和审阅材料不应混进用户导航。UI 截图使用可公开的演示作品，桌面图统一为 1920×1080，移动端优先使用 390×844。更新界面后，重新检查截图中的正文、模型名称、地址和任务记录是否适合公开。

## 提交 Pull Request

一个 PR 只解决一个清晰问题。说明中应包含：

- 用户可见的行为变化和不在本次范围内的事项。
- 关键实现选择，以及为什么复用或没有复用现有依赖与模块。
- 实际运行的验证命令和结果；没有运行的检查及原因。
- 数据、凭据、网络监听、备份和恢复边界是否变化。
- UI 改动的前后截图；数据库/部署改动的升级与回滚检查方式。

不要提交 `.env.local`、数据库、备份、发行临时目录、真实模型响应、私人正文、截图中的私人数据或编辑器/工具工作目录。提交前查看 `git diff --check` 和 `git status --short`，确保没有无关文件。

## Issue 与标签

先搜索重复问题，再使用 Bug 或 Feature 模板。Bug 应包含版本、运行方式、复现步骤、预期/实际结果和已脱敏日志；Feature 应说明真实创作流程、现有替代方案和数据边界。

维护者使用以下前缀：`area:web`、`area:server`、`area:persistence`、`area:deploy`、`type:bug`、`type:feature`、`type:docs`、`priority:p0` 至 `priority:p3`、`status:needs-info`、`good-first-issue`。
