const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const baseUrl = "http://127.0.0.1:8011/practice";
const outputDir = path.resolve("output/playwright/original-escape");
fs.mkdirSync(outputDir, { recursive: true });
const ensure = (value, message) => { if (!value) throw new Error(message); };

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem("openpop-locale", "zh-CN");
    localStorage.setItem("hk-practice-version", "1.5.78.11833");
    localStorage.setItem("hk-practice-version-revision", "2");
  });
  const page = await context.newPage();
  const unexpectedErrors = [];
  page.on("pageerror", error => unexpectedErrors.push(String(error)));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => typeof window.render_game_to_text === "function", null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const state = JSON.parse(window.render_game_to_text());
    return state.mode === "running" && state.runningVersion === "1.5.78.11833" && state.practice?.atBench !== false && state.practice?.currentRoom === "White_Palace_06";
  }, null, { timeout: 120000 });

  const frame = page.frames().find(item => item.url().includes("/practice/runner?version=1.5.78.11833"));
  ensure(frame, "1578 runner frame missing");
  await frame.locator("#unity-canvas").click({ position: { x: 480, y: 270 } });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).practice?.paused === true, null, { timeout: 15000 });
  ensure(await page.locator("#practice-menu").count() === 0, "outer practice overlay exists");
  await page.screenshot({ path: path.join(outputDir, "original-unity-escape.png") });
  const pausedState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));

  await page.keyboard.press("Escape");
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).practice?.paused === false, null, { timeout: 15000 });
  const resumedState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));

  const summary = {
    version: pausedState.runningVersion,
    scene: pausedState.practice.currentRoom,
    outerPracticeMenuExists: false,
    pausedAfterFirstEscape: pausedState.practice.paused,
    pausedAfterSecondEscape: resumedState.practice.paused,
    screenshot: path.join(outputDir, "original-unity-escape.png"),
    unexpectedErrors,
  };
  fs.writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
