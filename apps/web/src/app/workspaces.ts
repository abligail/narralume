import {
  Activity,
  BookOpenText,
  Brain,
  Compass,
  Cpu,
  LibraryBig,
  PenLine,
  Radar,

  Truck,
  type LucideIcon,
} from "lucide-react";

import type { MessageKey } from "../i18n";

/* 主导航收敛为五个创作面：书架 / 项目概览 / 故事 / 写作 / 交付。
   其余工作区（审稿、自动驾驶、运行账本、长篇推演、模型供给）暂挂「高级工具」组，
   随写作台合并与设置迁移逐步并入或退役。
   seal 是左栏顶部「当前工作区印记」的白文单字，随路由切换。
   label / blurb 是 i18n 字典键，展示侧用 t() / translate() 解析。 */

export interface WorkspaceDef {
  id: string;
  path: string;
  projectScoped: boolean;
  label: MessageKey;
  en: string;
  index: string;
  icon: LucideIcon;
  blurb: MessageKey;
  seal: string;
}

export const WORKSPACES: WorkspaceDef[] = [
  {
    id: "shelf",
    path: "/shelf",
    projectScoped: false,
    label: "shell.nav.shelf",
    en: "STACKS",
    index: "01",
    icon: LibraryBig,
    blurb: "shell.nav.shelfBlurb",
    seal: "藏",
  },
  {
    id: "overview",
    path: "/projects/:projectId/overview",
    projectScoped: true,
    label: "shell.nav.overview",
    en: "OVERLOOK",
    index: "02",
    icon: Compass,
    blurb: "shell.nav.overviewBlurb",
    seal: "览",
  },
  {
    id: "bible",
    path: "/projects/:projectId/bible",
    projectScoped: true,
    label: "shell.nav.bible",
    en: "CANON",
    index: "03",
    icon: BookOpenText,
    blurb: "shell.nav.bibleBlurb",
    seal: "典",
  },
  {
    id: "studio",
    path: "/projects/:projectId/studio",
    projectScoped: true,
    label: "shell.nav.studio",
    en: "DESK",
    index: "04",
    icon: PenLine,
    blurb: "shell.nav.studioBlurb",
    seal: "稿",
  },
  {
    id: "delivery",
    path: "/projects/:projectId/delivery",
    projectScoped: true,
    label: "shell.nav.delivery",
    en: "PRESS",
    index: "05",
    icon: Truck,
    blurb: "shell.nav.deliveryBlurb",
    seal: "付",
  },
];

/** 连续创作是普通产品入口，但与五个稳定工作面分组展示。 */
export const QUICK_WORKSPACES: WorkspaceDef[] = [
  {
    id: "autopilot",
    path: "/projects/:projectId/autopilot",
    projectScoped: true,
    label: "shell.nav.autopilot",
    en: "QUICK CREATE",
    index: "Q1",
    icon: Radar,
    blurb: "shell.nav.autopilotBlurb",
    seal: "创",
  },
];

/* 高级工具组：只放诊断、推演与全局配置，不承载普通创作主链。 */
export const ADVANCED_WORKSPACES: WorkspaceDef[] = [
  {
    id: "runs",
    path: "/projects/:projectId/runs",
    projectScoped: true,
    label: "shell.nav.runs",
    en: "LEDGER",
    index: "L1",
    icon: Activity,
    blurb: "shell.nav.runsBlurb",
    seal: "行",
  },
  {
    id: "lab",
    path: "/projects/:projectId/lab",
    projectScoped: true,
    label: "shell.nav.lab",
    en: "LOOM",
    index: "L2",
    icon: Brain,
    blurb: "shell.nav.labBlurb",
    seal: "演",
  },
  {
    id: "supply",
    path: "/settings",
    projectScoped: false,
    label: "shell.nav.settings",
    en: "SETTINGS",
    index: "S1",
    icon: Cpu,
    blurb: "shell.nav.settingsBlurb",
    seal: "配",
  },
];

const ALL_WORKSPACES = [...WORKSPACES, ...QUICK_WORKSPACES, ...ADVANCED_WORKSPACES];

export function workspaceByPath(pathname: string): WorkspaceDef {
  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return ADVANCED_WORKSPACES.find((item) => item.id === "supply")!;
  }
  const projectWorkspace = /^\/projects\/[^/]+\/([^/]+)/.exec(pathname)?.[1];
  const projectlessWorkspace = /^\/([^/]+)\/?$/.exec(pathname)?.[1];
  return (
    ALL_WORKSPACES.find(
      (item) => item.id === (projectWorkspace ?? projectlessWorkspace),
    ) ??
    WORKSPACES[0]!
  );
}

export function projectIdFromPath(pathname: string): string | null {
  const value = /^\/projects\/([^/]+)(?:\/|$)/.exec(pathname)?.[1];
  return value ? decodeURIComponent(value) : null;
}

export function workspacePath(item: WorkspaceDef, projectId: string | null): string {
  if (!item.projectScoped) return item.path;
  if (!projectId) return `/${item.id}`;
  return item.path.replace(":projectId", encodeURIComponent(projectId));
}
