const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright");

const buildRoot = path.resolve(process.argv[2]);
const outputDir = path.resolve(process.argv[3] || "output/playwright/original-practice-alpha1-grounded");

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

async function startServer(rootDir) {
  const types = { ".data": "application/octet-stream", ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".png": "image/png", ".wasm": "application/wasm" };
  const server = http.createServer((request, response) => {
    let filePath = path.resolve(rootDir, `.${decodeURIComponent(new URL(request.url, "http://localhost").pathname)}`);
    if (filePath !== rootDir && !filePath.startsWith(`${rootDir}${path.sep}`)) return response.writeHead(403).end();
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, "index.html");
    if (!fs.existsSync(filePath)) return response.writeHead(404).end();
    const brotli = filePath.endsWith(".br");
    const sourcePath = brotli ? filePath.slice(0, -3) : filePath;
    const headers = {
      "Content-Type": types[path.extname(sourcePath)] || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    };
    if (brotli) {
      headers["Content-Encoding"] = "br";
      headers.Vary = "Accept-Encoding";
    }
    response.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(response);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server;
}

async function main() {
  ensure(buildRoot && fs.existsSync(path.join(buildRoot, "index.html")), `missing WebGL build: ${buildRoot}`);
  fs.mkdirSync(outputDir, { recursive: true });
  const server = await startServer(buildRoot);
  const browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleLines = [];
  page.on("console", (message) => consoleLines.push(message.text().split("\n", 1)[0]));
  await page.route("**/index.html", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const patched = source.replace(
      ".then((unityInstance) => {",
      ".then((unityInstance) => { window.__unityInstance = unityInstance;",
    );
    ensure(patched !== source, "unable to expose Unity instance");
    await route.fulfill({ response, body: patched });
  });
  const readState = () => page.evaluate(() => window.__originalPracticeState ? JSON.parse(window.__originalPracticeState) : null);
  const waitForState = async (predicate, description, timeout = 90000) => {
    const deadline = Date.now() + timeout;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await readState();
      if (latest && predicate(latest)) return latest;
      await page.waitForTimeout(100);
    }
    throw new Error(`${description}: ${JSON.stringify(latest)}`);
  };
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__unityInstance, null, { timeout: 90000 });
    const initial = await waitForState((state) => state.scene === "White_Palace_06" && state.atBench === true, "official Path of Pain entry bench did not load");
    await page.locator("#unity-canvas").click({ position: { x: 640, y: 360 } });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(outputDir, "01-grounded-bench.png") });
    await page.keyboard.down("ArrowUp");
    await page.waitForTimeout(180);
    await page.keyboard.up("ArrowUp");
    const standing = await waitForState((state) => (
      state.atBench === false
      && state.acceptingInput === true
      && state.timer?.phase === "waiting"
      && state.timer?.gameTimeSeconds === 0
      && state.timer?.realTimeSeconds === 0
    ), "timer did not remain at zero after leaving the entry bench");
    const markerIndex = consoleLines.length;
    await page.keyboard.press("F7");
    const markerDeadline = Date.now() + 10000;
    while (
      Date.now() < markerDeadline
      && !consoleLines.slice(markerIndex).some((line) => line.startsWith("ORIGINAL_PRACTICE_MARKED_RETURN_POINT_SET"))
    ) {
      await page.waitForTimeout(50);
    }
    ensure(
      consoleLines.slice(markerIndex).some((line) => line.startsWith("ORIGINAL_PRACTICE_MARKED_RETURN_POINT_SET")),
      "F7 did not mark the current practice return point",
    );
    const markedLine = await readState();
    const marked = { x: markedLine.heroX, y: markedLine.heroY, scene: markedLine.scene };

    await page.evaluate(() => window.__unityInstance.SendMessage(
      "Original WebGL Practice Launcher",
      "ToggleNoclip",
    ));
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(500);
    await page.keyboard.up("ArrowRight");
    await page.evaluate(() => window.__unityInstance.SendMessage(
      "Original WebGL Practice Launcher",
      "ToggleNoclip",
    ));
    const moved = await waitForState((state) => (
      state.scene === marked.scene
      && state.atBench === false
      && state.acceptingInput === true
      && Math.abs(state.heroX - marked.x) > 3
    ), "the Knight did not move away from the marked return point");

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "1",
      code: "Numpad1",
      windowsVirtualKeyCode: 97,
      nativeVirtualKeyCode: 97,
      location: 3,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "1",
      code: "Numpad1",
      windowsVirtualKeyCode: 97,
      nativeVirtualKeyCode: 97,
      location: 3,
    });
    await page.waitForTimeout(500);
    const keypadState = await readState();
    ensure(
      keypadState
      && keypadState.atBench === false
      && keypadState.timer?.phase === "waiting"
      && Math.abs(keypadState.heroX - moved.heroX) < 1,
      `keypad 1 incorrectly triggered return: ${JSON.stringify(keypadState)}`,
    );
    await page.keyboard.press("1");
    const returned = await waitForState((state) => (
      state.atBench === false
      && state.scene === marked.scene
      && state.acceptingInput === true
      && state.hazardRespawning === false
      && state.cameraTeleporting === false
      && Math.abs(state.heroX - marked.x) < 1
      && Math.abs(state.heroY - marked.y) < 1.5
      && state.timer?.phase === "waiting"
      && state.timer?.gameTimeSeconds === 0
      && state.timer?.realTimeSeconds === 0
    ), "main keyboard 1 did not return to the marked point and clear the timer");
    const markers = consoleLines.slice(markerIndex).filter((line) => line.startsWith("ORIGINAL_PRACTICE_"));
    ensure(markers.some((line) => line.startsWith("ORIGINAL_PRACTICE_MARKED_RETURN_POINT_SET")), `F7 marker log missing: ${markers.join(" | ")}`);
    ensure(markers.some((line) => line.startsWith("ORIGINAL_PRACTICE_TIMER_RESET")), `main keyboard 1 timer reset marker missing: ${markers.join(" | ")}`);
    ensure(markers.some((line) => line.startsWith("ORIGINAL_PRACTICE_RETURN_TO_MARKED_POINT_BEGIN")), `main keyboard 1 return start marker missing: ${markers.join(" | ")}`);
    const completionDeadline = Date.now() + 10000;
    while (
      Date.now() < completionDeadline
      && !consoleLines.slice(markerIndex).some((line) => line.startsWith("ORIGINAL_PRACTICE_RETURN_TO_MARKED_POINT_DONE"))
    ) {
      await page.waitForTimeout(50);
    }
    const completedMarkers = consoleLines.slice(markerIndex).filter((line) => line.startsWith("ORIGINAL_PRACTICE_"));
    ensure(completedMarkers.some((line) => line.startsWith("ORIGINAL_PRACTICE_RETURN_TO_MARKED_POINT_DONE")), `main keyboard 1 return completion marker missing: ${completedMarkers.join(" | ")}`);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outputDir, "02-returned-to-marked-point.png") });
    const summary = { buildRoot, initial, standing, marked, moved, keypadState, returned, markers: completedMarkers };
    fs.writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
