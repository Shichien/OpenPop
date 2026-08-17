"use strict";

const gameHost = document.getElementById("game-host");
const loadingScreen = document.getElementById("loading-screen");
const loadingTitle = document.getElementById("loading-title");
const loadingDetail = document.getElementById("loading-detail");
const progressFill = document.getElementById("progress-fill");
const errorScreen = document.getElementById("error-screen");
const errorMessage = document.getElementById("error-message");
const debugPanel = document.getElementById("debug-panel");
const panelToggle = document.getElementById("panel-toggle");
const versionInputs = Array.from(document.querySelectorAll('input[name="game-version"]'));
const debugButtons = Array.from(document.querySelectorAll("[data-debug-method]"));
const statefulDebugMethods = new Set([
  "ToggleNoclip",
  "ToggleInfiniteHealth",
  "ToggleInfiniteSoul",
]);
const liveTimer = document.getElementById("live-timer");
const timerClock = document.getElementById("timer-clock");
const timerToggle = document.getElementById("timer-toggle");
const timerSplit = document.getElementById("timer-split");
const timerReset = document.getElementById("timer-reset");
const timerRows = Array.from(document.querySelectorAll("#timer-splits li"));
const replayGhostCanvas = document.getElementById("replay-ghost-canvas");
const replayGhostContext = replayGhostCanvas.getContext("2d");
const replayGhostToggle = document.getElementById("replay-ghost-toggle");
const replayGhostRun = document.getElementById("replay-ghost-run");
const replayGhostOpacity = document.getElementById("replay-ghost-opacity");
const replayGhostStatus = document.getElementById("replay-ghost-status");
const replayExportPrompt = document.getElementById("replay-export-prompt");
const replayExportRoom = document.getElementById("replay-export-room");
const replayExportTime = document.getElementById("replay-export-time");
const replayExportFrames = document.getElementById("replay-export-frames");
const replayExportDownload = document.getElementById("replay-export-download");
const replayExportDismiss = document.getElementById("replay-export-dismiss");
const replayExportError = document.getElementById("replay-export-error");

const TIMER_SEGMENTS = [
  { room: "White_Palace_18", name: "R1" },
  { room: "White_Palace_17", name: "R2" },
  { room: "White_Palace_19", name: "R3" },
  { room: "White_Palace_20", name: "R4" },
];
const TIMER_ROOM_NAMES = new Set(TIMER_SEGMENTS.map((segment) => segment.room));

const state = {
  builds: new Map(),
  selectedVersion: null,
  runningVersion: null,
  frame: null,
  switching: false,
  status: "initializing",
  progress: 0,
  practice: null,
  debugFlags: new Map(),
  timer: {
    phase: "waiting",
    elapsedMs: 0,
    realElapsedMs: 0,
    completedSplits: [],
    currentRoom: null,
    activeSplitIndex: 0,
    runtimePaused: true,
    pauseReason: "等待官方入口",
    eventSerial: 0,
    lastEvent: "",
  },
  replayGhost: {
    enabled: false,
    opacity: Number(replayGhostOpacity.value),
    roomName: null,
    roomPayload: null,
    selectedRun: null,
    selectedRuns: new Map(),
    loadFailures: [],
    requestToken: 0,
    manifest: null,
    atlasImages: new Map(),
    atlasPromises: new Map(),
    elapsedMs: 0,
    lastFrameMs: performance.now(),
    statusText: "",
  },
  replayCapture: {
    current: null,
    queue: [],
    exporting: false,
  },
};

const PRACTICE_ROOM_LABELS = new Map([
  ["White_Palace_18", "第一房"],
  ["White_Palace_17", "第二房"],
  ["White_Palace_19", "第三房"],
  ["White_Palace_20", "第四房"],
]);

function showNextReplayExport() {
  if (!state.replayCapture.current) {
    state.replayCapture.current = state.replayCapture.queue.shift() || null;
  }
  const replay = state.replayCapture.current;
  replayExportPrompt.hidden = !replay;
  replayExportError.hidden = true;
  replayExportError.textContent = "";
  if (!replay) return;
  replayExportRoom.textContent = `· ${PRACTICE_ROOM_LABELS.get(replay.sceneName) || replay.sceneName}`;
  replayExportTime.textContent = `· ${formatTimer(Number(replay.totalTime) * 1000)}`;
  replayExportFrames.textContent = `· ${String(replay.frames?.length || 0)}帧`;
}

function queueReplayExport(replay) {
  if (!replay || !Array.isArray(replay.frames) || replay.frames.length < 2) return;
  state.replayCapture.queue.push(replay);
  setPanelCollapsed(false);
  showNextReplayExport();
}

function closeCurrentReplayExport() {
  state.replayCapture.current = null;
  showNextReplayExport();
}

function downloadTextFile(filename, contents) {
  const url = URL.createObjectURL(new Blob([contents], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function exportCurrentReplay() {
  const replay = state.replayCapture.current;
  if (!replay || state.replayCapture.exporting) return;
  state.replayCapture.exporting = true;
  replayExportDownload.disabled = true;
  replayExportDismiss.disabled = true;
  replayExportError.hidden = true;
  try {
    const response = await fetch("/api/practice/replay/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(replay),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || `Replay 导出失败：${response.status}`);
    }
    downloadTextFile(payload.filename, `${payload.shareText}\n`);
    closeCurrentReplayExport();
  } catch (error) {
    replayExportError.textContent = error instanceof Error ? error.message : String(error);
    replayExportError.hidden = false;
  } finally {
    state.replayCapture.exporting = false;
    replayExportDownload.disabled = false;
    replayExportDismiss.disabled = false;
  }
}

function setReplayGhostStatus(message) {
  if (state.replayGhost.statusText === message) return;
  state.replayGhost.statusText = message;
  replayGhostStatus.textContent = message;
  window.dispatchEvent(new CustomEvent("practice-replay-selection-status", {
    detail: { message },
  }));
}

function clearReplayGhostCanvas() {
  replayGhostContext.setTransform(1, 0, 0, 1, 0, 0);
  replayGhostContext.clearRect(0, 0, replayGhostCanvas.width, replayGhostCanvas.height);
}

function normalizeReplayClipName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function formatReplayRunTime(seconds) {
  const milliseconds = Math.max(0, Number(seconds) || 0) * 1000;
  return formatTimer(milliseconds);
}

async function loadReplayHeroManifest() {
  const response = await fetch("/api/hero-animation?game=hollow_knight", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`官方人物动画读取失败：${response.status}`);
  }
  const payload = await response.json();
  if (!payload.hero?.clips || !payload.hero?.collections || !payload.hero?.atlases) {
    throw new Error("官方人物动画清单不完整");
  }
  await Promise.all(Object.values(payload.hero.atlases).map(ensureReplayAtlasImage));
  state.replayGhost.manifest = payload.hero;
}

function replayRunLabel(run) {
  const entry = run.entry_from_scene || "入口";
  const exit = run.exit_to_scene || "出口";
  return `${run.player_name} · ${formatReplayRunTime(run.total_time)} · ${entry} → ${exit}`;
}

function selectReplayRun(index, resetClock = true) {
  const runs = state.replayGhost.roomPayload?.runs || [];
  const normalizedIndex = Math.max(0, Math.min(Number(index) || 0, runs.length - 1));
  state.replayGhost.selectedRun = runs[normalizedIndex] || null;
  state.replayGhost.selectedRuns = state.replayGhost.selectedRun
    ? new Map([[`legacy-${normalizedIndex}`, { run: state.replayGhost.selectedRun, color: "#7ee7ff", opacity: state.replayGhost.opacity }]])
    : new Map();
  replayGhostRun.value = state.replayGhost.selectedRun ? String(normalizedIndex) : "";
  if (resetClock) {
    state.replayGhost.elapsedMs = 0;
    state.replayGhost.lastFrameMs = performance.now();
  }
}

async function loadReplayRoom(sceneName) {
  const requestToken = state.replayGhost.requestToken + 1;
  state.replayGhost.requestToken = requestToken;
  state.replayGhost.roomName = sceneName;
  state.replayGhost.roomPayload = null;
  state.replayGhost.selectedRun = null;
  state.replayGhost.selectedRuns = new Map();
  state.replayGhost.loadFailures = [];
  state.replayGhost.elapsedMs = 0;
  state.replayGhost.lastFrameMs = performance.now();
  replayGhostRun.disabled = true;
  clearReplayGhostCanvas();
  window.dispatchEvent(new CustomEvent("practice-room-change", { detail: { sceneName } }));

  if (!TIMER_ROOM_NAMES.has(sceneName)) {
    replayGhostRun.innerHTML = '<option value="">进入苦痛之路后自动载入</option>';
    setReplayGhostStatus(state.replayGhost.enabled ? "等待进入苦痛之路" : "显影已关闭");
    return;
  }

  replayGhostRun.innerHTML = '<option value="">正在读取当前房间回放</option>';
  setReplayGhostStatus("正在读取当前房间回放");

  try {
    const response = await fetch(`/api/practice/replay?scene_name=${encodeURIComponent(sceneName)}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`当前房间回放读取失败：${response.status}`);
    }
    const payload = await response.json();
    if (requestToken !== state.replayGhost.requestToken || state.replayGhost.roomName !== sceneName) {
      return;
    }
    state.replayGhost.roomPayload = payload;
    const runs = Array.isArray(payload.runs) ? payload.runs : [];
    if (!runs.length) {
      replayGhostRun.innerHTML = '<option value="">当前房间没有 Replay 数据</option>';
      setReplayGhostStatus("当前房间没有可显影的 Replay");
      return;
    }
    replayGhostRun.innerHTML = runs
      .map((run, index) => `<option value="${index}">${replayRunLabel(run)}</option>`)
      .join("");
    replayGhostRun.disabled = !state.replayGhost.enabled;
    selectReplayRun(0, true);
    setReplayGhostStatus(`已载入 ${runs.length} 条回放`);
  } catch (error) {
    if (requestToken !== state.replayGhost.requestToken) return;
    replayGhostRun.innerHTML = '<option value="">回放读取失败</option>';
    setReplayGhostStatus(error instanceof Error ? error.message : String(error));
  }
}

function replayHeroFrame(frameState) {
  const manifest = state.replayGhost.manifest;
  if (!manifest || !frameState) return null;
  const sourceClipName = String(frameState.anim_clip || "").trim();
  const clipName = manifest.clips[sourceClipName]
    ? sourceClipName
    : manifest.clip_lookup?.[normalizeReplayClipName(sourceClipName)];
  const clip = manifest.clips?.[clipName];
  if (!clip?.frames?.length) return null;

  const rawFrame = Math.max(0, Math.floor(Number(frameState.anim_frame) || 0));
  const frameIndex = clip.loop
    ? rawFrame % clip.frames.length
    : Math.min(rawFrame, clip.frames.length - 1);
  const frame = clip.frames[frameIndex];
  const collection = manifest.collections?.[String(frame.collection_id)];
  const sprite = collection?.sprites?.[String(frame.sprite_id)];
  if (!sprite || sprite.packed_rotation !== "none") return null;
  const atlas = manifest.atlases?.[String(sprite.atlas_texture_id)];
  if (!atlas?.image_url) return null;
  return { clipName, sprite, atlas };
}

function ensureReplayAtlasImage(atlas) {
  const key = String(atlas.texture_id);
  const loaded = state.replayGhost.atlasImages.get(key);
  if (loaded?.complete && loaded.naturalWidth > 0) return Promise.resolve(loaded);
  if (!state.replayGhost.atlasPromises.has(key)) {
    const promise = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        state.replayGhost.atlasImages.set(key, image);
        resolve(image);
      };
      image.onerror = () => reject(new Error(`官方人物图集读取失败：${atlas.image_name || key}`));
      image.src = atlas.image_url;
    });
    state.replayGhost.atlasPromises.set(key, promise);
  }
  return state.replayGhost.atlasPromises.get(key);
}

function replayAtlasImage(atlas) {
  const key = String(atlas.texture_id);
  const loaded = state.replayGhost.atlasImages.get(key);
  if (loaded?.complete && loaded.naturalWidth > 0) return loaded;
  ensureReplayAtlasImage(atlas).catch((error) => {
    setReplayGhostStatus(error instanceof Error ? error.message : String(error));
  });
  return null;
}

function resizeReplayGhostCanvas() {
  const width = Math.max(1, gameHost.clientWidth);
  const height = Math.max(1, gameHost.clientHeight);
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  const targetWidth = Math.round(width * pixelRatio);
  const targetHeight = Math.round(height * pixelRatio);
  if (replayGhostCanvas.width !== targetWidth || replayGhostCanvas.height !== targetHeight) {
    replayGhostCanvas.width = targetWidth;
    replayGhostCanvas.height = targetHeight;
  }
  replayGhostContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  replayGhostContext.clearRect(0, 0, width, height);
  return { width, height };
}

function replayProjectionViewport(width, height, projection) {
  const actualAspect = width / Math.max(1, height);
  const minimumAspect = Number(projection.minimum_aspect);
  const maximumAspect = Number(projection.maximum_aspect);
  const clampedAspect = Math.max(minimumAspect, Math.min(maximumAspect, actualAspect));
  if (actualAspect > clampedAspect) {
    const viewportWidth = height * clampedAspect;
    return { x: (width - viewportWidth) / 2, y: 0, width: viewportWidth, height };
  }
  if (actualAspect < clampedAspect) {
    const viewportHeight = width / clampedAspect;
    return { x: 0, y: (height - viewportHeight) / 2, width, height: viewportHeight };
  }
  return { x: 0, y: 0, width, height };
}

function renderReplayGhost(now) {
  const viewportSize = resizeReplayGhostCanvas();
  const ghost = state.replayGhost;
  const practice = state.practice;
  const projection = ghost.roomPayload?.projection;
  const selectedRuns = [...ghost.selectedRuns.values()];

  const canAdvance = ghost.enabled
    && state.status === "running"
    && practice
    && !practice.paused
    && !practice.enteringScene
    && !document.hidden
    && selectedRuns.length > 0;
  if (canAdvance) {
    ghost.elapsedMs += Math.max(0, Math.min(100, now - ghost.lastFrameMs));
  }
  ghost.lastFrameMs = now;

  if (!ghost.enabled || !practice || !selectedRuns.length || !projection || state.status !== "running") {
    return;
  }
  if (!ghost.manifest) {
    setReplayGhostStatus("正在读取官方人物动画");
    return;
  }

  const baselineWorldHeight = Number(projection.baseline_world_height);
  if (!(baselineWorldHeight > 0)) return;
  const viewport = replayProjectionViewport(viewportSize.width, viewportSize.height, projection);
  const pixelsPerUnit = viewport.height / baselineWorldHeight;
  let rendered = 0;
  for (const entry of selectedRuns) {
    const run = entry.run;
    const frameCount = Math.min(Number(run.frame_count) || 0, run.frame_states?.length || 0);
    if (frameCount <= 0 || !(Number(run.total_time) > 0)) continue;
    const frameIntervalMs = Number(run.total_time) * 1000 / Math.max(1, frameCount - 1);
    const frameIndex = Math.min(frameCount - 1, Math.floor(ghost.elapsedMs / frameIntervalMs));
    const frameState = run.frame_states[frameIndex];
    const heroFrame = replayHeroFrame(frameState);
    if (!heroFrame) continue;
    const atlasImage = replayAtlasImage(heroFrame.atlas);
    if (!atlasImage) continue;
    const screenX = viewport.x + viewport.width / 2
      + (Number(frameState.x) - Number(practice.cameraX)) * pixelsPerUnit;
    const screenY = viewport.y + viewport.height / 2
      - (Number(frameState.y) - Number(practice.cameraY)) * pixelsPerUnit;
    const src = heroFrame.sprite.src_rect;
    const bounds = heroFrame.sprite.local_bounds;
    const unitWidth = Number(bounds.max_x) - Number(bounds.min_x);
    const unitHeight = Number(bounds.max_y) - Number(bounds.min_y);
    if (!(unitWidth > 0) || !(unitHeight > 0)) continue;
    const semantics = String(ghost.manifest.facing_right_semantics || "inverted");
    const facingRight = semantics === "natural" ? frameState.facing_right === true : frameState.facing_right === false;
    replayGhostContext.save();
    replayGhostContext.translate(screenX, screenY);
    replayGhostContext.scale(facingRight ? 1 : -1, 1);
    replayGhostContext.globalAlpha = Number(entry.opacity) || ghost.opacity;
    replayGhostContext.globalCompositeOperation = "screen";
    replayGhostContext.shadowColor = entry.color || "rgba(126, 231, 255, 0.9)";
    replayGhostContext.shadowBlur = 8;
    replayGhostContext.imageSmoothingEnabled = true;
    replayGhostContext.drawImage(atlasImage, Number(src.x), Number(src.y), Number(src.width), Number(src.height), Number(bounds.min_x) * pixelsPerUnit, -Number(bounds.max_y) * pixelsPerUnit, unitWidth * pixelsPerUnit, unitHeight * pixelsPerUnit);
    replayGhostContext.restore();
    rendered += 1;
  }
  if (rendered) {
    const failed = ghost.loadFailures.length;
    setReplayGhostStatus(failed
      ? `${rendered} 条 Replay 同步播放，${failed} 条读取失败`
      : `${rendered} 条 Replay 同步播放`);
  }
}

function formatTimer(milliseconds) {
  const hundredths = Math.floor(Math.max(0, milliseconds) / 10);
  const minutes = Math.floor(hundredths / 6000);
  const seconds = Math.floor(hundredths / 100) % 60;
  const fraction = hundredths % 100;
  if (minutes === 0) return `${seconds}.${String(fraction).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

function timerIsPaused() {
  return state.timer.runtimePaused;
}

function currentComparison() {
  return "neutral";
}

function renderTimer() {
  const completed = state.timer.completedSplits.length;
  const displayState = state.timer.phase === "running" && timerIsPaused()
    ? "paused"
    : state.timer.phase;
  liveTimer.dataset.timerState = displayState;
  liveTimer.dataset.comparison = currentComparison();
  timerClock.textContent = formatTimer(state.timer.elapsedMs);
  const realClock = document.getElementById("timer-real-clock");
  if (realClock) realClock.textContent = `Real Time ${formatTimer(state.timer.realElapsedMs)}`;
  timerToggle.innerHTML = state.timer.phase === "running" ? "&#9208;" : "&#9654;";
  timerToggle.disabled = true;
  timerSplit.disabled = true;

  timerRows.forEach((row, index) => {
    const actual = state.timer.completedSplits[index];
    row.classList.toggle("completed", actual != null);
    row.classList.toggle(
      "current",
      state.timer.phase !== "finished" && index === Math.min(completed, TIMER_SEGMENTS.length - 1),
    );
    const timeLabel = row.querySelector("time");
    timeLabel.textContent = actual == null ? "—" : formatTimer(actual);
  });
}

function resetPracticeTimer() {
  state.timer.phase = "waiting";
  state.timer.elapsedMs = 0;
  state.timer.realElapsedMs = 0;
  state.timer.completedSplits = [];
  state.timer.currentRoom = null;
  state.timer.activeSplitIndex = 0;
  state.timer.runtimePaused = true;
  state.timer.pauseReason = "等待官方入口";
  state.timer.eventSerial = 0;
  state.timer.lastEvent = "";
  state.practice = null;
  state.replayGhost.roomName = null;
  state.replayGhost.roomPayload = null;
  state.replayGhost.selectedRun = null;
  state.replayGhost.elapsedMs = 0;
  state.replayGhost.lastFrameMs = performance.now();
  replayGhostRun.disabled = true;
  replayGhostRun.innerHTML = '<option value="">等待进入房间</option>';
  clearReplayGhostCanvas();
  setReplayGhostStatus(state.replayGhost.enabled ? "等待进入房间" : "显影已关闭");
  renderTimer();
}

function requestOfficialTimerReset() {
  resetPracticeTimer();
  sendDebugCommand("ResetPracticeTimer");
}

function startPracticeTimer() {
  // Timer start is owned by the official Unity state publisher.
}

function completeTimerSegment() {
  // Automatic splits are emitted by Unity; a browser click cannot fabricate one.
}

function applyPracticeState(practiceState) {
  const previousRoom = state.timer.currentRoom;
  state.practice = practiceState;
  state.timer.currentRoom = practiceState.currentRoom;
  if (previousRoom !== practiceState.currentRoom) {
    state.replayGhost.elapsedMs = 0;
    state.replayGhost.lastFrameMs = performance.now();
    if (practiceState.currentRoom) {
      loadReplayRoom(practiceState.currentRoom);
    }
  }
  const officialTimer = practiceState.timer;
  if (officialTimer) {
    state.timer.phase = officialTimer.phase || "waiting";
    state.timer.elapsedMs = Math.max(0, Number(officialTimer.gameTimeSeconds) || 0) * 1000;
    state.timer.realElapsedMs = Math.max(0, Number(officialTimer.realTimeSeconds) || 0) * 1000;
    state.timer.activeSplitIndex = Math.max(0, Number(officialTimer.activeSplitIndex) || 0);
    state.timer.completedSplits = Array.isArray(officialTimer.splitTimes)
      ? officialTimer.splitTimes.map((value) => Math.max(0, Number(value) || 0) * 1000)
      : [];
    state.timer.runtimePaused = Boolean(officialTimer.paused);
    state.timer.pauseReason = String(officialTimer.pauseReason || "");
    state.timer.eventSerial = Number(officialTimer.eventSerial) || 0;
    state.timer.lastEvent = String(officialTimer.lastEvent || "");
  } else {
    state.timer.runtimePaused = true;
    state.timer.pauseReason = state.status === "running" ? "等待官方计时状态" : "运行包加载中";
  }
  renderTimer();
}

function resetDebugButtonStates() {
  state.debugFlags.clear();
  for (const button of debugButtons) {
    if (!statefulDebugMethods.has(button.dataset.debugMethod)) continue;
    button.classList.remove("enabled");
    button.setAttribute("aria-pressed", "false");
  }
}

function setDebugButtonState(method, enabled) {
  if (!statefulDebugMethods.has(method)) return;
  const button = debugButtons.find((candidate) => candidate.dataset.debugMethod === method);
  if (!button) return;
  const active = Boolean(enabled);
  state.debugFlags.set(method, active);
  button.classList.toggle("enabled", active);
  button.setAttribute("aria-pressed", String(active));
}

function timerFrame(now) {
  renderTimer();
  renderReplayGhost(now);
  window.requestAnimationFrame(timerFrame);
}

function focusRunner() {
  state.frame?.focus();
  state.frame?.contentWindow?.focus();
}

function setLoading(title, detail = "", progress = 0) {
  loadingScreen.hidden = false;
  errorScreen.hidden = true;
  loadingTitle.textContent = title;
  loadingDetail.textContent = detail;
  progressFill.style.width = `${Math.max(0, Math.min(100, progress * 100))}%`;
  state.status = "loading";
  state.progress = progress;
  state.timer.runtimePaused = true;
  clearReplayGhostCanvas();
  renderTimer();
}

function showError(message) {
  loadingScreen.hidden = true;
  errorScreen.hidden = false;
  errorMessage.textContent = message;
  state.status = "error";
  state.timer.runtimePaused = true;
  clearReplayGhostCanvas();
  renderTimer();
}

function setReady(version) {
  loadingScreen.hidden = true;
  errorScreen.hidden = true;
  state.status = "running";
  state.progress = 1;
  liveTimer.hidden = false;
  state.timer.runtimePaused = Boolean(state.practice?.paused);
  if (state.practice?.currentRoom) {
    loadReplayRoom(state.practice.currentRoom);
  }
  renderTimer();
}

function waitForRunnerMounted(frame) {
  if (frame.dataset.mounted === "true") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      window.removeEventListener("message", handleMessage);
      reject(new Error("旧版本的运行页面尚未准备好，已停止切换"));
    }, 10000);

    function handleMessage(event) {
      if (
        event.source !== frame.contentWindow ||
        event.origin !== window.location.origin ||
        event.data?.type !== "practice-runner-mounted"
      ) {
        return;
      }
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", handleMessage);
      frame.dataset.mounted = "true";
      resolve();
    }

    window.addEventListener("message", handleMessage);
  });
}

async function waitForRunnerQuit(frame) {
  await waitForRunnerMounted(frame);
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      window.removeEventListener("message", handleMessage);
      reject(new Error("旧版本未能在 30 秒内完成退出，已停止切换"));
    }, 30000);

    function handleMessage(event) {
      if (event.source !== frame.contentWindow || event.origin !== window.location.origin) {
        return;
      }
      if (event.data?.type === "practice-runner-quit-complete") {
        window.clearTimeout(timeoutId);
        window.removeEventListener("message", handleMessage);
        resolve();
      } else if (event.data?.type === "practice-runner-quit-error") {
        window.clearTimeout(timeoutId);
        window.removeEventListener("message", handleMessage);
        reject(new Error(event.data.message || "旧版本退出失败"));
      }
    }

    window.addEventListener("message", handleMessage);
    frame.contentWindow.postMessage({ type: "practice-runner-quit" }, window.location.origin);
  });
}

async function destroyCurrentRunner() {
  const frame = state.frame;
  if (!frame) {
    return;
  }
  await waitForRunnerQuit(frame);
  frame.remove();
  state.frame = null;
  state.runningVersion = null;
  resetDebugButtonStates();
  resetPracticeTimer();
}

function createRunner(version) {
  const frame = document.createElement("iframe");
  frame.className = "game-runner";
  frame.title = `Hollow Knight ${version}`;
  frame.allow = "autoplay; fullscreen";
  frame.dataset.mounted = "false";
  frame.src = `/practice/runner?version=${encodeURIComponent(version)}`;
  gameHost.prepend(frame);
  state.frame = frame;
  state.runningVersion = version;
}

async function switchVersion(version) {
  if (state.switching || version === state.runningVersion) {
    return;
  }

  const build = state.builds.get(version);
  state.selectedVersion = version;
  window.localStorage.setItem("hk-practice-version", version);
  if (!build?.available) {
    showError(build?.error || `${version} 的官方运行包不可用`);
    return;
  }

  state.switching = true;
  for (const input of versionInputs) {
    input.disabled = true;
  }

  try {
    if (state.frame) {
      setLoading("正在退出当前版本", "等待 Unity 释放画布、输入和内存", 0);
      await destroyCurrentRunner();
    }
    setLoading(`正在载入 ${version}`, "使用该版本的官方程序集与场景", 0);
    createRunner(version);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    state.switching = false;
    for (const input of versionInputs) {
      input.disabled = !state.builds.get(input.value)?.available;
    }
  }
}

function handleRunnerMessage(event) {
  if (!state.frame || event.source !== state.frame.contentWindow || event.origin !== window.location.origin) {
    return;
  }
  const message = event.data || {};
  if (message.version !== state.runningVersion) {
    return;
  }
  if (message.type === "practice-runner-mounted") {
    state.frame.dataset.mounted = "true";
    resetDebugButtonStates();
  } else if (message.type === "practice-runner-progress") {
    setLoading(`正在载入 ${message.version}`, "使用该版本的官方程序集与场景", Number(message.progress) || 0);
  } else if (message.type === "practice-runner-ready") {
    setReady(message.version);
    focusRunner();
  } else if (message.type === "practice-runner-state") {
    applyPracticeState(message);
  } else if (message.type === "practice-runner-debug-state") {
    setDebugButtonState(String(message.method || ""), Boolean(message.enabled));
  } else if (message.type === "practice-runner-replay-complete") {
    queueReplayExport(message.replay);
  } else if (message.type === "practice-runner-timer-command") {
    if (message.command === "reset") {
      resetPracticeTimer();
    }
  } else if (message.type === "practice-runner-error") {
    showError(message.message || `${message.version} 启动失败`);
  }
}

function sendDebugCommand(method) {
  if (!state.frame?.contentWindow || state.status !== "running") {
    return false;
  }
  state.frame.contentWindow.postMessage(
    { type: "practice-debug-command", method },
    window.location.origin,
  );
  if (statefulDebugMethods.has(method)) {
    setDebugButtonState(method, !state.debugFlags.get(method));
  }
  return true;
}

async function initialize() {
  const response = await fetch("/api/practice/builds", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`版本清单读取失败：${response.status}`);
  }
  const manifest = await response.json();
  for (const build of manifest.versions || []) {
    state.builds.set(build.id, build);
    const input = versionInputs.find((candidate) => candidate.value === build.id);
    if (input) {
      input.disabled = !build.available;
    }
  }

  const savedVersion = window.localStorage.getItem("hk-practice-version");
  const savedBuild = state.builds.get(savedVersion);
  const initialVersion = savedBuild?.available && savedBuild.replayCaptureAvailable
    ? savedVersion
    : manifest.defaultVersion;
  const initialInput = versionInputs.find((input) => input.value === initialVersion);
  if (initialInput) {
    initialInput.checked = true;
  }
  await switchVersion(initialVersion);
}

for (const input of versionInputs) {
  input.addEventListener("change", () => {
    if (input.checked) {
      switchVersion(input.value);
    }
  });
}

function setPanelCollapsed(collapsed) {
  debugPanel.classList.toggle("collapsed", collapsed);
  panelToggle.setAttribute("aria-expanded", String(!collapsed));
  panelToggle.title = collapsed ? "展开 Debug 面板" : "收起 Debug 面板";
  panelToggle.querySelector("span").textContent = collapsed ? ">" : "<";
}

panelToggle.addEventListener("click", () => {
  setPanelCollapsed(!debugPanel.classList.contains("collapsed"));
});

timerToggle.addEventListener("click", () => {
  focusRunner();
});

timerSplit.addEventListener("click", () => {
  focusRunner();
});

timerReset.addEventListener("click", () => {
  requestOfficialTimerReset();
  focusRunner();
});

window.addEventListener("keydown", (event) => {
  if (event.code !== "F5" && event.code !== "F6") return;
  event.preventDefault();
  if (event.code === "F5") {
    requestOfficialTimerReset();
  }
});

document.addEventListener("visibilitychange", () => {
  state.replayGhost.lastFrameMs = performance.now();
  renderTimer();
});

replayGhostToggle.addEventListener("change", () => {
  state.replayGhost.enabled = replayGhostToggle.checked;
  replayGhostRun.disabled = !state.replayGhost.enabled || !(state.replayGhost.roomPayload?.runs?.length);
  state.replayGhost.elapsedMs = 0;
  state.replayGhost.lastFrameMs = performance.now();
  if (!state.replayGhost.enabled) {
    clearReplayGhostCanvas();
    setReplayGhostStatus("显影已关闭");
  } else if (state.practice?.currentRoom) {
    setReplayGhostStatus(state.replayGhost.selectedRun ? "显影已开启" : "正在读取当前房间回放");
    if (!state.replayGhost.roomPayload) loadReplayRoom(state.practice.currentRoom);
  } else {
    setReplayGhostStatus("等待进入苦痛之路");
  }
});

let socialSelectionToken = 0;
window.addEventListener("practice-replay-selection-change", async (event) => {
  const detail = event.detail || {};
  const sceneName = String(detail.sceneName || "");
  const selections = Array.isArray(detail.selected) ? detail.selected.slice(0, 8) : [];
  socialSelectionToken += 1;
  const token = socialSelectionToken;
  state.replayGhost.enabled = selections.length > 0;
  state.replayGhost.selectedRun = null;
  state.replayGhost.selectedRuns = new Map();
  state.replayGhost.loadFailures = [];
  state.replayGhost.elapsedMs = 0;
  state.replayGhost.lastFrameMs = performance.now();
  if (!selections.length) {
    clearReplayGhostCanvas();
    setReplayGhostStatus("显影已关闭");
    return;
  }
  if (state.replayGhost.roomName !== sceneName || !state.replayGhost.roomPayload) {
    await loadReplayRoom(sceneName);
  }
  if (token !== socialSelectionToken) return;
  if (!state.replayGhost.roomPayload) {
    state.replayGhost.loadFailures = selections.map((selection) => ({
      runId: String(selection.runId || ""),
      message: "当前房间基础数据读取失败",
    }));
    setReplayGhostStatus("当前房间基础数据读取失败");
    return;
  }
  state.replayGhost.selectedRun = null;
  state.replayGhost.selectedRuns = new Map();
  setReplayGhostStatus(`正在载入 ${selections.length} 条 Replay`);
  const results = await Promise.all(selections.map(async (selection) => {
    const runId = String(selection.runId || "");
    try {
      const response = await fetch(`/api/social/replays/${encodeURIComponent(String(selection.runId))}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `Replay 读取失败：${response.status}`);
      const replay = payload.replay;
      if (replay?.scene_name !== sceneName) throw new Error("Replay 房间与当前场景不一致");
      return {
        runId,
        entry: {
          run: replay,
          color: String(selection.color || "#7ee7ff"),
          opacity: Math.max(0.2, Math.min(0.85, Number(selection.opacity) || 0.58)),
        },
      };
    } catch (error) {
      return {
        runId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  if (token !== socialSelectionToken) return;
  const loaded = results.filter((result) => result.entry);
  state.replayGhost.selectedRuns = new Map(loaded.map((result) => [result.runId, result.entry]));
  state.replayGhost.loadFailures = results
    .filter((result) => result.error)
    .map((result) => ({ runId: result.runId, message: result.error }));
  const failed = state.replayGhost.loadFailures.length;
  setReplayGhostStatus(failed
    ? `${loaded.length} 条 Replay 已载入，${failed} 条读取失败`
    : `${loaded.length} 条 Replay 已载入`);
});

replayGhostRun.addEventListener("change", () => {
  selectReplayRun(replayGhostRun.value, true);
  if (state.replayGhost.enabled) setReplayGhostStatus("显影已开启");
});

replayGhostOpacity.addEventListener("input", () => {
  state.replayGhost.opacity = Math.max(0.2, Math.min(0.85, Number(replayGhostOpacity.value) || 0.55));
});

for (const button of debugButtons) {
  button.addEventListener("click", () => sendDebugCommand(button.dataset.debugMethod));
}

// Keep the export choice active even if Unity temporarily replaces focusable DOM around the overlay.
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("#replay-export-download, #replay-export-dismiss") : null;
  if (target === replayExportDownload) exportCurrentReplay();
  if (target === replayExportDismiss) closeCurrentReplayExport();
});

if (window.matchMedia("(max-width: 720px)").matches) {
  setPanelCollapsed(true);
}

window.addEventListener("message", handleRunnerMessage);
window.addEventListener("beforeunload", () => {
  if (state.frame?.contentWindow) {
    state.frame.contentWindow.postMessage({ type: "practice-runner-quit" }, window.location.origin);
  }
});

window.render_game_to_text = () => JSON.stringify({
  mode: state.status,
  selectedVersion: state.selectedVersion,
  runningVersion: state.runningVersion,
  switching: state.switching,
  progress: state.progress,
  practice: state.practice
    ? {
      currentRoom: state.practice.currentRoom,
      playerX: state.practice.playerX,
      playerY: state.practice.playerY,
      cameraX: state.practice.cameraX,
      cameraY: state.practice.cameraY,
      paused: state.practice.paused,
      enteringScene: state.practice.enteringScene,
    }
    : null,
  timer: {
    phase: state.timer.phase,
    elapsedSeconds: state.timer.elapsedMs / 1000,
    realElapsedSeconds: state.timer.realElapsedMs / 1000,
    currentRoom: state.timer.currentRoom,
    activeSegmentIndex: state.timer.activeSplitIndex,
    runtimePaused: state.timer.runtimePaused,
    pauseReason: state.timer.pauseReason,
    eventSerial: state.timer.eventSerial,
    lastEvent: state.timer.lastEvent,
    finishSignal: "官方 PlayerData.newDataBindingSeal",
    splits: TIMER_SEGMENTS.map((segment, index) => ({
      name: segment.name,
      room: segment.room,
      actualSeconds: state.timer.completedSplits[index] == null
        ? null
        : state.timer.completedSplits[index] / 1000,
    })),
  },
  replayGhost: {
    enabled: state.replayGhost.enabled,
    room: state.replayGhost.roomName,
    player: state.replayGhost.selectedRun?.player_name || null,
    frame: state.replayGhost.selectedRun
      ? Math.min(
        Math.max(0, state.replayGhost.selectedRun.frame_count - 1),
        Math.floor(
          state.replayGhost.elapsedMs
          / Math.max(
            1,
            Number(state.replayGhost.selectedRun.total_time) * 1000
            / Math.max(1, state.replayGhost.selectedRun.frame_count - 1),
          ),
        ),
      )
      : null,
    opacity: state.replayGhost.opacity,
    status: state.replayGhost.statusText,
    selectedCount: state.replayGhost.selectedRuns.size,
    selectedRunIds: [...state.replayGhost.selectedRuns.keys()],
    loadFailures: state.replayGhost.loadFailures,
  },
  replayCapture: {
    pendingCount: state.replayCapture.queue.length + (state.replayCapture.current ? 1 : 0),
    currentRoom: state.replayCapture.current?.sceneName || null,
    exporting: state.replayCapture.exporting,
  },
  availableVersions: Array.from(state.builds.values()).map((build) => ({
    id: build.id,
    available: build.available,
    error: build.error || null,
  })),
  coordinateSystem: "Unity game coordinates are owned by the official runtime inside the child frame",
});

window.advanceTime = (milliseconds) => {
  state.replayGhost.elapsedMs += state.replayGhost.enabled
    ? Math.max(0, Number(milliseconds) || 0)
    : 0;
  state.replayGhost.lastFrameMs = performance.now();
  renderTimer();
  renderReplayGhost(state.replayGhost.lastFrameMs);
};

resetPracticeTimer();
window.requestAnimationFrame(timerFrame);

initialize().catch((error) => {
  showError(error instanceof Error ? error.message : String(error));
});

loadReplayHeroManifest().catch((error) => {
  setReplayGhostStatus(error instanceof Error ? error.message : String(error));
});
