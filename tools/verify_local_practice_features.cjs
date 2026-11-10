const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const baseUrl = "http://127.0.0.1:8011";
const outputDir = path.resolve("output/playwright/local-practice-features");
fs.mkdirSync(outputDir, { recursive: true });
function ensure(value, message) { if (!value) throw new Error(message); }

const mockRunner = `<!doctype html><html><head><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#05080a;color:#eaf3f5;font-family:Georgia,serif}
#unity-canvas{width:100vw;height:100vh;background:radial-gradient(circle at 50% 55%,#23343c,#05080a 62%);outline:none}
#original-pause-menu{position:fixed;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.72)}
#original-pause-menu[hidden]{display:none}
#original-pause-menu section{width:360px;padding:28px;border:1px solid #899ba0;background:#11191d;text-align:center}
#original-pause-menu h1{margin:0 0 24px;font-size:28px}
#original-pause-menu p{margin:10px 0;padding:9px;border:1px solid #3d4b50}
</style></head><body>
<canvas id="unity-canvas" tabindex="0" width="960" height="540"></canvas>
<div id="original-pause-menu" hidden><section><h1>PAUSED</h1><p>CONTINUE</p><p>OPTIONS</p><p>RETURN TO SPAWN</p></section></div>
<script>
const version = new URLSearchParams(location.search).get('version');
const canvas = document.getElementById('unity-canvas');
const pauseMenu = document.getElementById('original-pause-menu');
let paused = false;
let selected = 1;
let slots = Array.from({length:9},(_,i)=>({slot:i+1,occupied:false,scene:'',x:0,y:0}));
const send=(type,p={})=>parent.postMessage({type,version,...p},location.origin);
function marker(){send('practice-runner-marker-state',{selected,slots});}
function publishState(room='White_Palace_06', atBench=true){send('practice-runner-state',{currentRoom:room,playerX:2.2,playerY:3.4,cameraX:0,cameraY:0,paused,enteringScene:false,atBench,timer:{phase:'waiting',gameTimeSeconds:0,realTimeSeconds:0,activeSplitIndex:0,splitTimes:[],paused,lastEvent:'',eventSerial:0}})}
addEventListener('keydown',event=>{
  if(event.code==='Escape'){
    paused=!paused;
    pauseMenu.hidden=!paused;
    publishState();
    return;
  }
  if(/^Digit[1-9]$/.test(event.code)){
    selected=Number(event.code.slice(-1));
    marker();
    return;
  }
  if(event.code==='NumpadAdd'||(event.code==='Equal'&&event.key==='+')){
    slots[selected-1]={slot:selected,occupied:true,scene:'White_Palace_18',x:297.7,y:12.4};
    marker();
    return;
  }
  if(event.code==='Backquote'){
    publishState('White_Palace_18',false);
  }
});
send('practice-runner-mounted');marker();publishState();send('practice-runner-ready');canvas.focus();
</script></body></html>`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { localStorage.clear(); localStorage.setItem('openpop-locale','zh-CN'); });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type()==='error') errors.push(message.text()); });
  await page.route('**/practice/runner?**', route => route.fulfill({ status: 200, contentType: 'text/html', body: mockRunner }));
  await page.goto(`${baseUrl}/practice`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.render_game_to_text === 'function');
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).mode === 'running');
  let state = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  ensure(state.runningVersion === '1.5.78.11833', `default version mismatch: ${JSON.stringify(state)}`);
  ensure(await page.locator('#practice-menu').count() === 0, 'outer practice menu still exists');

  const frame = page.frames().find(item => item.url().includes('/practice/runner?'));
  ensure(frame, 'mock runner missing');
  await frame.locator('#unity-canvas').click();
  await page.keyboard.press('Escape');
  await frame.waitForSelector('#original-pause-menu:not([hidden])');
  ensure(await page.locator('#practice-menu').count() === 0, 'Escape opened an outer overlay');
  await page.screenshot({ path: path.join(outputDir,'01-original-escape-menu.png') });

  await page.keyboard.press('Escape');
  await frame.locator('#original-pause-menu').waitFor({ state: 'hidden' });
  await page.keyboard.press('3');
  await page.keyboard.press('Shift+Equal');
  await page.waitForFunction(() => { const current=JSON.parse(window.render_game_to_text()); return current.markers.selected===3 && current.markers.slots[2].occupied; });
  await page.screenshot({ path: path.join(outputDir,'02-direct-hotkeys.png') });
  await page.keyboard.press('`');
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).practice?.currentRoom === 'White_Palace_18');

  await page.selectOption('#locale-select','en');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await page.screenshot({ path: path.join(outputDir,'03-en-page.png') });
  state = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  ensure(state.locale === 'en' && state.markers.selected === 3, 'locale or direct hotkey state lost');
  ensure(errors.length === 0, `browser errors: ${errors.join(' | ')}`);

  const badPage = await context.newPage();
  await badPage.route('**/api/practice/builds', route => route.fulfill({ status: 200, contentType: 'application/json', body: '' }));
  await badPage.goto(`${baseUrl}/practice`, { waitUntil: 'domcontentloaded' });
  await badPage.waitForSelector('#error-screen:not([hidden])');
  const protocolError = await badPage.locator('#error-message').textContent();
  ensure(protocolError && protocolError.includes('空响应'), `empty JSON was not normalized: ${protocolError}`);

  const summary = {
    defaultVersion: state.runningVersion,
    locale: state.locale,
    outerPracticeMenuExists: false,
    originalPauseMenuVisibleOnEscape: true,
    directHotkeys: { selectedSlot: state.markers.selected, slot3: state.markers.slots[2], returnedRoom: state.practice.currentRoom },
    protocolError,
    errors,
  };
  fs.writeFileSync(path.join(outputDir,'summary.json'), JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary,null,2));
  await browser.close();
})().catch(error => { console.error(error.stack||error); process.exit(1); });
