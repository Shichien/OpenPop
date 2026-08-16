const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const baseUrl = process.argv[2] || "http://127.0.0.1:8011/";
const version = process.argv[3] || "1.5.12620";
const outputDir = path.resolve(process.argv[4] || `output/playwright/site-${version}`);

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript((selectedVersion) => {
    window.localStorage.setItem("hk-practice-version", selectedVersion);
  }, version);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    const line = message.text().split("\n", 1)[0];
    if (
      message.type() === "error"
      && !line.startsWith("[.WebGL-")
      && !line.startsWith("Unsupported type: null")
    ) errors.push(line);
  });

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("iframe.game-runner", { timeout: 30000 });
    let runner = null;
    const frameDeadline = Date.now() + 30000;
    while (!runner && Date.now() < frameDeadline) {
      runner = page.frames().find((frame) => frame.url().includes("/practice/runner?version="));
      if (!runner) await page.waitForTimeout(50);
    }
    ensure(runner, "pop runner frame did not attach");
    await runner.waitForSelector("#unity-canvas", { timeout: 30000 });

    const stateDeadline = Date.now() + 120000;
    let state = null;
    while (Date.now() < stateDeadline) {
      state = await runner.evaluate(() => {
        try {
          return JSON.parse(window.__originalPracticeState || "null");
        } catch {
          return null;
        }
      });
      if (state?.scene === "White_Palace_06" && state?.atBench === true) break;
      await page.waitForTimeout(100);
    }
    ensure(state?.scene === "White_Palace_06" && state?.atBench === true, `official seated entry did not load: ${JSON.stringify(state)}`);
    await page.waitForFunction(() => {
      try {
        return JSON.parse(window.render_game_to_text()).practice?.currentRoom === "White_Palace_06";
      } catch {
        return false;
      }
    }, undefined, { timeout: 10000 });
    const pageState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    ensure(pageState.runningVersion === version, `site selected wrong version: ${JSON.stringify(pageState)}`);
    ensure(pageState.practice?.currentRoom === "White_Palace_06", `site bridge did not receive room state: ${JSON.stringify(pageState)}`);
    await page.screenshot({ path: path.join(outputDir, "site-seated.png") });
    const knownOfficialStartupErrors = [
      "Unsupported type: null",
      "Couldn't find a Hero, make sure one exists in the scene.",
      "NullReferenceException: Object reference not set to an instance of an object.",
      "PlayMakerUnity2DProxy requires the 'PlayMaker Unity 2D' Prefab in the Scene.",
    ];
    const unexpectedErrors = errors.filter((line) => (
      !knownOfficialStartupErrors.some((known) => line.trim().startsWith(known))
    ));
    ensure(unexpectedErrors.length === 0, `pop browser errors: ${unexpectedErrors.join(" | ")}`);
    const summary = { baseUrl, version, state, pageState, errors, unexpectedErrors };
    fs.writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
