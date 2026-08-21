#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";

import JSZip from "jszip";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const hostPlatform =
  process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? "macos"
      : process.platform;
const hostArch =
  process.arch === "x64"
    ? "x64"
    : process.arch === "arm64"
      ? "arm64"
      : process.arch;
const hostTarget = `${hostPlatform}-${hostArch}`;
const targetArgument = process.argv.find((argument) =>
  argument.startsWith("--target="),
);
const target = targetArgument?.slice("--target=".length) ?? hostTarget;
const supportedTargets = new Set(["windows-x64", "linux-x64", "macos-arm64"]);
if (!supportedTargets.has(target)) {
  throw new Error(`Unsupported release target: ${target}.`);
}
if (target !== hostTarget) {
  throw new Error(
    `Release target ${target} must be built on ${target}; current host is ${hostTarget}.`,
  );
}
const windowsTarget = target.startsWith("windows-");
const tagVersion =
  process.env.GITHUB_REF_TYPE === "tag" &&
  process.env.GITHUB_REF_NAME?.startsWith("v")
    ? process.env.GITHUB_REF_NAME.slice(1)
    : null;
if (
  tagVersion &&
  tagVersion !== pkg.version &&
  !tagVersion.startsWith(`${pkg.version}-`)
) {
  throw new Error(
    `Release tag v${tagVersion} does not match package version ${pkg.version}.`,
  );
}
const releaseVersion = tagVersion ?? pkg.version;
const releaseRoot = join(root, ".tmp", "release");
const releaseName = `NarraLume-${releaseVersion}`;
const stage = join(releaseRoot, releaseName);
const archive = join(
  releaseRoot,
  `${releaseName}-${target}.${windowsTarget ? "zip" : "tar.gz"}`,
);

for (const required of [
  "apps/server/dist/main.js",
  "apps/web/dist/index.html",
  "package-lock.json",
]) {
  if (!existsSync(join(root, required))) {
    throw new Error(`${required} is missing; run npm run build first.`);
  }
}
rmSync(releaseRoot, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const copy = (relative) => {
  const source = join(root, relative);
  const target = join(stage, relative);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
};
const commonFiles = [
  "LICENSE",
  "README.md",
  "README.zh.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  "package-lock.json",
  "apps/server/dist",
  "apps/server/package.json",
  "apps/web/dist",
  "apps/web/package.json",
  "apps/bridge/package.json",
  "apps/relay/package.json",
  "assets",
  "docs/README.md",
  "docs/user-guide.md",
  "docs/quick-start.md",
  "docs/configuration.md",
  "docs/data-and-backup.md",
  "docs/docker.md",
  "docs/deploy-cloud.md",
  "docs/third-party-licenses.csv",
];
const launcherFiles = windowsTarget
  ? [
      "Start-NarraLume.bat",
      "UpdateAndStart-NarraLume.bat",
      "scripts/start.ps1",
      "scripts/stop.ps1",
      "scripts/backup.ps1",
      "scripts/update-and-start.ps1",
    ]
  : [
      "Start-NarraLume.sh",
      "UpdateAndStart-NarraLume.sh",
      "scripts/start.sh",
      "scripts/stop.sh",
      "scripts/backup.sh",
      "scripts/update-and-start.sh",
      ...(target.startsWith("macos-")
        ? ["Start-NarraLume.command", "UpdateAndStart-NarraLume.command"]
        : []),
    ];
for (const file of [...commonFiles, ...launcherFiles]) copy(file);
for (const workspace of [
  "context",
  "contracts",
  "domain",
  "harness",
  "llm",
  "narrative",
  "persistence",
  "services",
]) {
  copy(`packages/${workspace}/package.json`);
  copy(`packages/${workspace}/dist`);
}
mkdirSync(join(stage, "data"), { recursive: true });
writeFileSync(join(stage, "data", ".gitkeep"), "");
if (!windowsTarget) {
  for (const file of launcherFiles) chmodSync(join(stage, file), 0o755);
}

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("Run the release builder through `npm run release:build`.");
}
run(process.execPath, [npmCli, "ci", "--omit=dev", "--ignore-scripts"], {
  cwd: stage,
});
const lockHash = createHash("sha256")
  .update(readFileSync(join(stage, "package-lock.json")))
  .digest("hex");
mkdirSync(join(stage, ".runtime"), { recursive: true });
writeFileSync(
  join(stage, ".runtime", "package-lock.sha256"),
  `${windowsTarget ? lockHash.toUpperCase() : lockHash}\n`,
);

if (windowsTarget) {
  await writePortableZip(stage, releaseName, archive);
} else {
  run("tar", ["-czf", archive, "-C", releaseRoot, releaseName]);
}
console.log(`Release created: ${archive}`);

async function writePortableZip(source, rootName, destination) {
  const zip = new JSZip();
  addDirectory(zip, source, `${rootName}/`, new Set());
  await pipeline(
    zip.generateNodeStream({
      type: "nodebuffer",
      streamFiles: true,
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
      platform: "DOS",
    }),
    createWriteStream(destination),
  );
}

function addDirectory(zip, directory, archivePrefix, ancestors) {
  const realDirectory = realpathSync(directory);
  if (ancestors.has(realDirectory)) {
    throw new Error(`Directory cycle detected while packaging ${directory}`);
  }
  const nextAncestors = new Set(ancestors).add(realDirectory);
  zip.folder(archivePrefix);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const archivePath = `${archivePrefix}${entry.name}`;
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      addDirectory(zip, absolute, `${archivePath}/`, nextAncestors);
    } else if (stats.isFile()) {
      zip.file(archivePath, readFileSync(absolute), { date: stats.mtime });
    }
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });
  if (result.error) console.error(result.error);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
