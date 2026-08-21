# 快速开始

本页只解决一件事：把 NarraLume 跑起来，并确认你知道数据放在哪里。第一次使用建议先看“在线体验”或对应系统的发行包；需要改代码时再看开发环境。

## 在线体验

打开 [app.narralume.me](https://app.narralume.me/)，浏览器会在当前站点创建本地数据库。在线体验不要求先配置模型，作品、设置和自带的模型密钥都保存在当前浏览器的 OPFS 中。

使用在线体验前，请记住三点：

- 清除站点数据、使用无痕窗口或更换浏览器后，原来的本地库可能无法访问。
- 浏览器直连模型时，上游服务需要允许当前站点的 CORS；也可以改用本地 Server 代发请求。
- 离开前在“设置”中点击“下载我的库”，把数据库文件放到安全位置。

## Windows

Windows 用户可以直接使用 [GitHub Releases](https://github.com/abligail/narralume/releases) 中的发行包，不需要先安装 Node.js。

1. 下载最新的 Windows x64 ZIP。
2. 解压到一个有写入权限的目录，例如 `D:\\NarraLume`。
3. 双击 `Start-NarraLume.bat`。
4. 浏览器打开启动器显示的地址，默认是 `http://127.0.0.1:4317`。

首次启动如果缺少 Node.js，启动器会尝试联网下载项目需要的运行时。若 Windows SmartScreen 提示未知发布者，请确认 ZIP 来自上述 Releases 页面，再选择“仍要运行”。

作品默认保存在发行目录下的 `data/`，包括 `narralume.sqlite` 和 `backups/`。不要把正在运行的 SQLite 文件直接复制到另一台机器；请先在“交付”创建项目内容快照，或在“设置”下载整库备份。

发行目录中还有两类文件：`.runtime/` 保存便携 Node.js、依赖标记和启动日志，不是作品数据；`scripts/` 提供停止、备份和启动脚本。应用运行时可以在 PowerShell 执行：

```powershell
powershell -File scripts/backup.ps1
powershell -File scripts/stop.ps1
```

可以用环境变量修改端口和数据目录：

```powershell
$env:NARRALUME_PORT = "4321"
$env:NARRALUME_DATA_DIR = "D:\\NarraLume-data"
.\\Start-NarraLume.bat
```

### 更新 Windows 发行包

1. 在旧版本仍能打开时运行 `powershell -File scripts/backup.ps1`。
2. 运行 `powershell -File scripts/stop.ps1`，或关闭启动器窗口并确认服务已经停止。
3. 把新版 ZIP 完整解压到一个新目录，不要直接覆盖旧版本。
4. 把旧目录的 `data/` 完整复制到新目录；不要让新包中的空目录覆盖旧数据库。
5. 从新目录启动，核对作品数量、最近正文和备份列表。确认无误后再归档或删除旧目录。

## macOS

Apple Silicon（M1 及后续芯片）用户可以直接下载 Releases 中的 `macos-arm64.tar.gz`，不需要预装 Node.js。

1. 解压发行包，把目录放到有写入权限的位置。
2. 双击 `Start-NarraLume.command`；也可以在终端执行 `./Start-NarraLume.command`。
3. 浏览器打开 `http://127.0.0.1:4317`。

如果 macOS 阻止首次打开，请在 Finder 中右键点击脚本并选择“打开”，确认文件来自本项目的 GitHub Releases。启动器会优先使用系统已有的 Node.js 24；没有合适版本时，会下载并校验 Node.js 官方 arm64 运行时。

备份和停止服务：

```bash
./scripts/backup.sh
./scripts/stop.sh
```

## Linux

首个 Linux 发行包面向 x64 桌面或服务器。下载 Releases 中的 `linux-x64.tar.gz` 后执行：

```bash
tar -xzf NarraLume-*-linux-x64.tar.gz
cd NarraLume-*
./Start-NarraLume.sh
```

启动器会优先使用系统已有的 Node.js 24；没有合适版本时，会下载并校验 Node.js 官方 x64 运行时。图形桌面会尝试打开浏览器；无桌面环境时手动访问输出的地址。

macOS 和 Linux 的作品均默认保存在发行目录的 `data/`，日志位于 `.runtime/logs/`。可以在启动前设置相同的启动器变量：

```bash
export NARRALUME_PORT=4321
export NARRALUME_DATA_DIR="$HOME/NarraLume-data"
./Start-NarraLume.sh
```

更新发行包时，先运行 `./scripts/backup.sh` 和 `./scripts/stop.sh`，把新版解压到新目录，再完整复制旧目录的 `data/`。不要直接覆盖正在使用的目录或运行中的数据库。

## 开发环境

完整贡献流程见[参与贡献](../CONTRIBUTING.md)。最常用的命令是：

```bash
npm ci
npm run dev
npm run verify
```

`npm run verify` 会执行格式、Lint、类型检查、测试、证据和生产构建。提交前请至少运行它，或者说明未能运行的检查和原因。

开发 Web 默认在 `http://127.0.0.1:4318`，Server/API 默认在 `http://127.0.0.1:4317`。需要环境变量时把 `.env.example` 复制为 `.env.local`，不要提交真实密钥。

## 启动后做什么

1. 打开“书架”，点击“空白建书”。没有模型也可以先建书和手写。
2. 进入“故事”，填写作者意图，再按需要建立大纲、人物、已确认事实、关系、时间线和伏笔。
3. 在“写作”创建章节正文；需要 AI 时，在“设置”新建模型渠道和模型，并派给“默认生成模型”。
4. 在“交付”查看质量提醒、导出作品，并创建项目内容快照。

完整的功能说明见[用户指南](user-guide.md)，环境变量和协议说明见[配置](configuration.md)。

## 启动失败时

- 端口被占用：给本地启动器设置 `NARRALUME_PORT`，或停止占用 4317/4318 的进程。
- 浏览器打不开页面：确认启动器窗口没有退出，并访问窗口里打印的 Web 地址。
- 数据目录不可写：把 `NARRALUME_DATA_DIR` 或 `NARRATIVE_DATA_DIR` 指向当前用户有权限的目录。
- AI 请求失败：检查模型协议、Base URL、API 密钥和 CORS；先用“设置”中的连接测试确认渠道可用。
