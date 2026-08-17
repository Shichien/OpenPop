"use strict";

const canvas = document.getElementById("unity-canvas");
const container = document.getElementById("unity-container");
const warningBanner = document.getElementById("unity-warning");
const version = new URLSearchParams(window.location.search).get("version");

let unityInstance = null;
let loaderScript = null;
let quitting = false;
let statePollId = null;
let lastStateKey = "";
let originalPracticeState = null;
let replayRecording = null;
let pendingReplayTransition = null;
let closedReplayScene = null;
let lastBridgedState = null;
let practiceVisible = false;

const PRACTICE_REPLAY_ROUTES = new Map([
  ["White_Palace_18", { entry: "White_Palace_06", exit: "White_Palace_17" }],
  ["White_Palace_17", { entry: "White_Palace_18", exit: "White_Palace_19" }],
  ["White_Palace_19", { entry: "White_Palace_17", exit: "White_Palace_20" }],
  ["White_Palace_20", { entry: "White_Palace_19", exit: "White_Palace_06" }],
]);

const PRACTICE_REPLAY_SPLIT_INDEX = new Map([
  ["White_Palace_18", 1],
  ["White_Palace_17", 2],
  ["White_Palace_19", 3],
  ["White_Palace_20", 4],
]);

const originalConsoleLog = console.log.bind(console);
console.log = (...values) => {
  const line = values.map((value) => String(value)).join(" ");
  const debugMatch = line.match(/ORIGINAL_PRACTICE_DEBUG_(NOCLIP|INFINITE_HEALTH|INFINITE_SOUL)\s+(enabled|disabled)/);
  if (debugMatch) {
    const methods = {
      NOCLIP: "ToggleNoclip",
      INFINITE_HEALTH: "ToggleInfiniteHealth",
      INFINITE_SOUL: "ToggleInfiniteSoul",
    };
    send("practice-runner-debug-state", {
      method: methods[debugMatch[1]],
      enabled: debugMatch[2] === "enabled",
    });
  }
  const markerIndex = line.indexOf("ORIGINAL_PRACTICE_STATE ");
  if (markerIndex >= 0) {
    const fields = {};
    const record = line.slice(markerIndex);
    for (const match of record.matchAll(/(\w+)=([^\s]+)/g)) {
      fields[match[1]] = match[2];
    }
    const acceptingInput = fields.acceptingInput === "True";
    originalPracticeState = {
      currentRoom: fields.scene || null,
      roomIndex: 0,
      roomCount: 4,
      mode: acceptingInput ? "playing" : "paused",
      paused: !acceptingInput,
      enteringScene: !acceptingInput,
      playerX: Number(fields.heroX) || 0,
      playerY: Number(fields.heroY) || 0,
      enemiesAlive: 0,
    };
    return;
  }
  originalConsoleLog(...values);
};

function send(type, payload = {}) {
  window.parent.postMessage({ type, version, ...payload }, window.location.origin);
}

function discardReplayRecording() {
  replayRecording = null;
  pendingReplayTransition = null;
}

function finishReplayRecording(recording, exitScene, completed, timerState) {
  if (!recording) return;
  const finishedScene = recording.scene;
  const route = PRACTICE_REPLAY_ROUTES.get(finishedScene);
  const isOfficialExit = route?.exit === exitScene;
  const requiresCompletion = finishedScene === "White_Palace_20";
  const expectedSplitIndex = PRACTICE_REPLAY_SPLIT_INDEX.get(finishedScene) || 0;
  const splitAdvanced = Boolean(
    timerState
    && Number(timerState.activeSplitIndex) === expectedSplitIndex
    && Number(timerState.eventSerial) > Number(recording.startEventSerial)
    && (requiresCompletion
      ? timerState.phase === "finished" && completed
      : timerState.lastEvent === "split")
  );
  if (
    isOfficialExit
    && splitAdvanced
    && (!requiresCompletion || completed)
    && recording.frames.length >= 2
  ) {
    const frames = recording.frames;
    send("practice-runner-replay-complete", {
      replay: {
        format: "original-practice-replay-v1",
        gameVersion: version,
        sceneName: recording.scene,
        entryFromScene: route.entry,
        exitToScene: route.exit,
        totalTime: Number(frames[frames.length - 1].elapsed) || 0,
        frames,
      },
    });
  }
  closedReplayScene = finishedScene;
}

window.OriginalPracticeReceiveReplayFrame = (rawFrame) => {
  try {
    const frame = JSON.parse(rawFrame);
    const route = PRACTICE_REPLAY_ROUTES.get(frame.scene);
    if (!route) return;
    if (closedReplayScene === frame.scene) return;
    if (closedReplayScene && closedReplayScene !== frame.scene) {
      closedReplayScene = null;
    }
    if (replayRecording?.scene !== frame.scene) {
      if (replayRecording) {
        pendingReplayTransition = {
          recording: replayRecording,
          exitScene: frame.scene,
        };
      }
      replayRecording = {
        scene: frame.scene,
        frames: [],
        startEventSerial: Number(lastBridgedState?.timer?.eventSerial) || 0,
      };
    }
    replayRecording.frames.push({
      elapsed: Number(frame.elapsed) || 0,
      x: Number(frame.x) || 0,
      y: Number(frame.y) || 0,
      facingRight: Boolean(frame.facingRight),
      animClip: String(frame.clip || ""),
      animFrame: Math.max(0, Math.floor(Number(frame.animFrame) || 0)),
    });
  } catch (error) {
    console.error("Replay 帧读取失败", error);
  }
};

function showBanner(message, type) {
  const item = document.createElement("div");
  item.textContent = message;
  item.dataset.type = type || "warning";
  warningBanner.appendChild(item);
  if (type !== "error") {
    window.setTimeout(() => item.remove(), 5000);
  }
}

function readCompactPracticeState() {
  if (typeof window.__originalPracticeState === "string" && window.__originalPracticeState) {
    const officialState = JSON.parse(window.__originalPracticeState);
    const gameState = officialState.gameState || "INACTIVE";
    const uiState = officialState.uiState || "INACTIVE";
    const transitionState = officialState.transitionState || "WAITING_TO_ENTER_LEVEL";
    const acceptingInput = Boolean(officialState.acceptingInput);
    const paused = (
      ((gameState === "PLAYING" || gameState === "ENTERING_LEVEL") && uiState !== "PLAYING")
      || (gameState !== "PLAYING" && !acceptingInput)
      || gameState === "EXITING_LEVEL"
      || gameState === "LOADING"
      || transitionState === "WAITING_TO_ENTER_LEVEL"
    );
    return {
      currentRoom: officialState.scene || null,
      nextScene: officialState.nextScene || "",
      roomIndex: 0,
      roomCount: 4,
      mode: paused ? "paused" : "playing",
      gameState,
      uiState,
      transitionState,
      acceptingInput,
      paused,
      enteringScene: Boolean(officialState.enteringScene),
      completed: Boolean(officialState.completed),
      atBench: Boolean(officialState.atBench),
      playerX: Number(officialState.heroX) || 0,
      playerY: Number(officialState.heroY) || 0,
      cameraX: Number(officialState.cameraX) || 0,
      cameraY: Number(officialState.cameraY) || 0,
      health: Number(officialState.health) || 0,
      maxHealth: Number(officialState.maxHealth) || 0,
      maxHealthBase: Number(officialState.maxHealthBase) || 0,
      maxHealthCap: Number(officialState.maxHealthCap) || 0,
      mpCharge: Number(officialState.MPCharge) || 0,
      maxMP: Number(officialState.maxMP) || 0,
      mpReserve: Number(officialState.MPReserve) || 0,
      mpReserveMax: Number(officialState.MPReserveMax) || 0,
      mpReserveCap: Number(officialState.MPReserveCap) || 0,
      hasShadowDash: Boolean(officialState.hasShadowDash),
      canShadowDash: Boolean(officialState.canShadowDash),
      fireballLevel: Number(officialState.fireballLevel) || 0,
      quakeLevel: Number(officialState.quakeLevel) || 0,
      screamLevel: Number(officialState.screamLevel) || 0,
      shadeFireballLevel: Number(officialState.shadeFireballLevel) || 0,
      shadeQuakeLevel: Number(officialState.shadeQuakeLevel) || 0,
      shadeScreamLevel: Number(officialState.shadeScreamLevel) || 0,
      hasDoubleJump: Boolean(officialState.hasDoubleJump),
      hasWalljump: Boolean(officialState.hasWalljump),
      hasSuperDash: Boolean(officialState.hasSuperDash),
      enemiesAlive: 0,
      cameraTeleporting: Boolean(officialState.cameraTeleporting),
      hazardRespawning: Boolean(officialState.hazardRespawning),
      tilemapDirty: Boolean(officialState.tilemapDirty),
      usesSceneTransitionRoutine: Boolean(officialState.usesSceneTransitionRoutine),
      timer: officialState.timer || null,
    };
  }
  if (typeof window.__unityPracticeState !== "string" || !window.__unityPracticeState) {
    return originalPracticeState;
  }
  const practiceState = JSON.parse(window.__unityPracticeState);
  const enemies = Array.isArray(practiceState.enemies) ? practiceState.enemies : [];
  return {
    currentRoom: practiceState.current_room || null,
    nextScene: practiceState.next_scene || "",
    roomIndex: Number(practiceState.room_index) || 0,
    roomCount: Number(practiceState.room_count) || 0,
    mode: practiceState.mode || "playing",
    paused: Boolean(practiceState.input?.paused),
    enteringScene: Boolean(practiceState.player?.entering_scene),
    completed: Boolean(practiceState.completed),
    playerX: Number(practiceState.player?.x) || 0,
    playerY: Number(practiceState.player?.y) || 0,
    cameraX: Number(practiceState.camera?.x) || 0,
    cameraY: Number(practiceState.camera?.y) || 0,
    health: Number(practiceState.player?.health) || 0,
    maxHealth: Number(practiceState.player?.max_health) || 0,
    maxHealthBase: Number(practiceState.player?.max_health_base) || 0,
    maxHealthCap: Number(practiceState.player?.max_health_cap) || 0,
    mpCharge: Number(practiceState.player?.mp_charge) || 0,
    maxMP: Number(practiceState.player?.max_mp) || 0,
    mpReserve: Number(practiceState.player?.mp_reserve) || 0,
    mpReserveMax: Number(practiceState.player?.mp_reserve_max) || 0,
    mpReserveCap: Number(practiceState.player?.mp_reserve_cap) || 0,
    hasShadowDash: Boolean(practiceState.player?.has_shadow_dash),
    canShadowDash: Boolean(practiceState.player?.can_shadow_dash),
    fireballLevel: Number(practiceState.player?.fireball_level) || 0,
    quakeLevel: Number(practiceState.player?.quake_level) || 0,
    screamLevel: Number(practiceState.player?.scream_level) || 0,
    shadeFireballLevel: Number(practiceState.player?.shade_fireball_level) || 0,
    shadeQuakeLevel: Number(practiceState.player?.shade_quake_level) || 0,
    shadeScreamLevel: Number(practiceState.player?.shade_scream_level) || 0,
    hasDoubleJump: Boolean(practiceState.player?.has_double_jump),
    hasWalljump: Boolean(practiceState.player?.has_walljump),
    hasSuperDash: Boolean(practiceState.player?.has_super_dash),
    enemiesAlive: enemies.filter((enemy) => Number(enemy.hp) > 0).length,
    cameraTeleporting: false,
    hazardRespawning: false,
    tilemapDirty: false,
    usesSceneTransitionRoutine: false,
    timer: null,
  };
}

function startStateBridge() {
  window.clearInterval(statePollId);
  statePollId = window.setInterval(() => {
    try {
      const compactState = readCompactPracticeState();
      if (!compactState) return;
      if (
        !practiceVisible
        && compactState.currentRoom === "White_Palace_06"
        && compactState.atBench === true
      ) {
        practiceVisible = true;
        canvas.style.setProperty("visibility", "visible", "important");
        canvas.focus();
        send("practice-runner-ready");
      }
      if (closedReplayScene && closedReplayScene !== compactState.currentRoom) {
        closedReplayScene = null;
      }
      if (pendingReplayTransition && pendingReplayTransition.exitScene === compactState.currentRoom) {
        finishReplayRecording(
          pendingReplayTransition.recording,
          pendingReplayTransition.exitScene,
          compactState.completed,
          compactState.timer,
        );
        pendingReplayTransition = null;
      } else if (
        replayRecording?.scene === "White_Palace_20"
        && compactState.completed
        && !lastBridgedState?.completed
      ) {
        finishReplayRecording(replayRecording, "White_Palace_06", true, compactState.timer);
      }
      const stateKey = JSON.stringify(compactState);
      if (stateKey === lastStateKey) return;
      lastStateKey = stateKey;
      lastBridgedState = compactState;
      send("practice-runner-state", compactState);
    } catch (error) {
      console.error("苦痛之路计时状态读取失败", error);
    }
  }, 100);
}

function handleTimerHotkey(event) {
  if (event.code !== "F5" && event.code !== "F6") return;
  event.preventDefault();
  if (event.code === "F5" && unityInstance) {
    unityInstance.SendMessage("Original WebGL Practice Launcher", "ResetPracticeTimer");
  }
}

async function readBuild() {
  const response = await fetch("/api/practice/builds", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`版本清单读取失败：${response.status}`);
  }
  const manifest = await response.json();
  const build = (manifest.versions || []).find((candidate) => candidate.id === version);
  if (!build) {
    throw new Error(`未知的游戏版本：${version || "未指定"}`);
  }
  if (!build.available) {
    throw new Error(build.error || `${version} 的官方运行包不可用`);
  }
  return build;
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    loaderScript = document.createElement("script");
    loaderScript.src = url;
    loaderScript.onload = resolve;
    loaderScript.onerror = () => reject(new Error(`${version} 的 Unity 加载器读取失败`));
    document.body.appendChild(loaderScript);
  });
}

async function start() {
  const build = await readBuild();
  await loadScript(build.loaderUrl);
  if (typeof window.createUnityInstance !== "function") {
    throw new Error(`${version} 的 Unity 加载器没有提供启动函数`);
  }

  const config = {
    arguments: [],
    dataUrl: build.dataUrl,
    frameworkUrl: build.frameworkUrl,
    codeUrl: build.codeUrl,
    streamingAssetsUrl: build.streamingAssetsUrl,
    companyName: build.companyName,
    productName: build.productName,
    productVersion: build.productVersion,
    showBanner,
  };
  unityInstance = await window.createUnityInstance(canvas, config, (progress) => {
    send("practice-runner-progress", { progress });
  });
  startStateBridge();
}

async function quit() {
  if (quitting) {
    return;
  }
  quitting = true;
  try {
    if (unityInstance) {
      await unityInstance.Quit();
      unityInstance = null;
    }
    window.clearInterval(statePollId);
    statePollId = null;
    lastStateKey = "";
    lastBridgedState = null;
    practiceVisible = false;
    closedReplayScene = null;
    discardReplayRecording();
    delete window.OriginalPracticeReceiveReplayFrame;
    window.removeEventListener("message", handleMessage);
    loaderScript?.remove();
    loaderScript = null;
    canvas.remove();
    warningBanner.replaceChildren();
    container.replaceChildren();
    send("practice-runner-quit-complete");
  } catch (error) {
    quitting = false;
    send("practice-runner-quit-error", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleMessage(event) {
  if (event.source !== window.parent || event.origin !== window.location.origin) {
    return;
  }
  if (event.data?.type === "practice-runner-quit") {
    quit();
  } else if (event.data?.type === "practice-debug-command") {
    if (!unityInstance) {
      return;
    }
    const method = String(event.data.method || "");
    const allowedMethods = new Set([
      "ToggleNoclip",
      "ToggleInfiniteHealth",
      "ToggleInfiniteSoul",
      "SetHazardRespawn",
      "SetPracticeReturnPoint",
      "HazardRespawn",
      "ResetPracticeTimer",
      "ReturnToPracticeSpawn",
      "ReturnToMarkedPoint",
    ]);
    if (allowedMethods.has(method)) {
      unityInstance.SendMessage("Original WebGL Practice Launcher", method);
    }
  }
}

window.addEventListener("message", handleMessage);
window.addEventListener("keydown", handleTimerHotkey, { capture: true });
send("practice-runner-mounted");
start().catch((error) => {
  send("practice-runner-error", {
    message: error instanceof Error ? error.message : String(error),
  });
});
