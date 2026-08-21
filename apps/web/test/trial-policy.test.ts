import { beforeEach, describe, expect, it } from "vitest";

import { setLocale } from "../src/i18n";
import {
  DEMO_RELAY_PROVIDER_ID,
  exceedsTrialRelayAutopilotLimit,
} from "../src/lib/trial-policy";

beforeEach(() => {
  setLocale("zh-CN");
});

describe("在线体验连续创作策略", () => {
  it("内置 Relay 每次最多允许三章", () => {
    expect(exceedsTrialRelayAutopilotLimit(DEMO_RELAY_PROVIDER_ID, 3)).toBe(false);
    expect(exceedsTrialRelayAutopilotLimit(DEMO_RELAY_PROVIDER_ID, 4)).toBe(true);
  });

  it("不限制用户自带 Provider", () => {
    expect(exceedsTrialRelayAutopilotLimit("user-provider", 30)).toBe(false);
  });
});
