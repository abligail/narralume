import { assistant } from "./assistant";
import { autopilot } from "./autopilot";
import { bible } from "./bible";
import { common } from "./common";
import { components } from "./components";
import { delivery } from "./delivery";
import { errors } from "./errors";
import { lab } from "./lab";
import { labels } from "./labels";
import { overview } from "./overview";
import { runs } from "./runs";
import { settings } from "./settings";
import { shelf } from "./shelf";
import { shell } from "./shell";
import { studio } from "./studio";

export const zhMessages = {
  assistant,
  autopilot,
  bible,
  common,
  components,
  delivery,
  errors,
  lab,
  labels,
  overview,
  runs,
  settings,
  shelf,
  shell,
  studio,
};

/** 以中文字典为结构真相，英文字典必须保持同构。 */
export type Messages = typeof zhMessages;
