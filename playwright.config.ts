import { defineConfig } from "@playwright/test";

const viewports = [
  { name: "desktop-1440", width: 1440, height: 1000 },
  { name: "desktop-1024", width: 1024, height: 900 },
  { name: "tablet-768", width: 768, height: 900 },
  { name: "mobile-375", width: 375, height: 812 },
];

const apiPort = Number(process.env.NARRATIVE_E2E_API_PORT ?? 14317);
const webPort = Number(process.env.NARRATIVE_E2E_WEB_PORT ?? 14318);
const spikePort = Number(process.env.NARRATIVE_E2E_SPIKE_PORT ?? 14319);
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const spikeUrl = `http://127.0.0.1:${spikePort}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: ".tmp/playwright-results",
  use: {
    baseURL: webUrl,
    // 界面双语后，e2e 断言以中文界面为基准；locale 决定 i18n 初始语言。
    locale: "zh-CN",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: viewports.map((viewport) => ({
    name: viewport.name,
    use: { viewport: { width: viewport.width, height: viewport.height } },
  })),
  webServer: [
    {
      command: "tsx scripts/e2e-server.ts",
      url: `${apiUrl}/api/health`,
      env: { NARRATIVE_E2E_API_PORT: String(apiPort) },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `npm run preview -w @narralume/web -- --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: webUrl,
      env: { NARRATIVE_API_PROXY: apiUrl },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `npm run preview:spike -w @narralume/web -- --host 127.0.0.1 --port ${spikePort} --strictPort`,
      url: `${spikeUrl}/spike.html`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
