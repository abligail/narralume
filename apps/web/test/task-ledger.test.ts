import { beforeEach, describe, expect, it } from "vitest";

import { setLocale } from "../src/i18n";
import { taskHref } from "../src/lib/task-ledger";

beforeEach(() => {
  setLocale("zh-CN");
});

describe("任务现场链接", () => {
  it("共创运行回到具体故事房", () => {
    expect(
      taskHref("p-1", "assistant", "run-1", {
        origin: {
          surface: "cocreate",
          sessionId: "room-1",
          branchId: "branch-1",
        },
      }),
    ).toBe("/projects/p-1/studio?mode=cocreate&session=room-1");
  });
});
