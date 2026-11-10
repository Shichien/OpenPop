const { chromium } = require('playwright');
function ensure(value,message){if(!value)throw new Error(message)}
(async()=>{
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage();
 const build={id:'1.5.78.11833',available:true,loaderUrl:'/mock-loader.js',dataUrl:'/mock.data',frameworkUrl:'/mock.framework.js',codeUrl:'/mock.wasm',streamingAssetsUrl:'/mock-stream',companyName:'Team Cherry',productName:'Hollow Knight',productVersion:'1.5.78.11833'};
 await page.addInitScript(()=>{window.__originalPracticeState=JSON.stringify({scene:'White_Palace_06',gameState:'PLAYING',uiState:'PLAYING',transitionState:'WAITING_TO_TRANSITION',acceptingInput:true,paused:false,enteringScene:false,completed:false,atBench:true,heroX:0,heroY:0,cameraX:0,cameraY:0});});
 await page.route('**/api/practice/builds',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({versions:[build]})}));
 await page.route('**/mock-loader.js',r=>r.fulfill({status:200,contentType:'application/javascript',body:`window.__unityMessages=[];window.createUnityInstance=async()=>({SendMessage:(...args)=>window.__unityMessages.push(args),Quit:async()=>{}});`}));
 await page.goto('http://127.0.0.1:8011/practice/runner?version=1.5.78.11833',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__unityMessages);
 await page.waitForFunction(()=>document.querySelector('#unity-canvas').style.visibility === 'visible');
 await page.evaluate(()=>{window.__originalPracticeState=JSON.stringify({scene:'White_Palace_03_hub',gameState:'PLAYING',uiState:'PLAYING',transitionState:'WAITING_TO_TRANSITION',acceptingInput:true,paused:false,enteringScene:false,completed:false,atBench:false,heroX:0,heroY:0,cameraX:0,cameraY:0});});
 await page.waitForFunction(()=>window.__unityMessages.some(m=>m[1]==='ReturnToPracticeSpawn'));
 const messages=await page.evaluate(()=>window.__unityMessages);
 ensure(messages.filter(m=>m[1]==='ReturnToPracticeSpawn').length===1,`recovery repeated: ${JSON.stringify(messages)}`);
 console.log(JSON.stringify({unexpectedRoom:'White_Palace_03_hub',messages},null,2));
 await browser.close();
})().catch(e=>{console.error(e.stack||e);process.exit(1)});

