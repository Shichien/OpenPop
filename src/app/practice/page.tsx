import { ChevronLeft, Play, RotateCcw, SkipForward } from "lucide-react";
import Script from "next/script";

import SocialReplayPanel from "@/components/social-replay-panel";

const versions = ["1.5.78.11833", "1.5.12620"] as const;
const debugActions = [
  ["ToggleNoclip", "飞行"],
  ["ToggleInfiniteHealth", "无限血量"],
  ["ToggleInfiniteSoul", "无限灵魂"],
  ["SetHazardRespawn", "设置保存点"],
  ["SetPracticeReturnPoint", "标记返回点"],
  ["ReturnToMarkedPoint", "返回标记点"],
] as const;

export default function PracticePage() {
  return (
    <>
      <link rel="stylesheet" href="/static/unity-practice.css" />
      <link rel="stylesheet" href="/static/social/social.css" />
      <main className="practice-stage">
        <section id="game-host" className="game-host" aria-label="苦痛之路练习场景">
          <canvas id="replay-ghost-canvas" className="replay-ghost-canvas" aria-hidden="true" />
          <section id="live-timer" className="live-timer" aria-label="苦痛之路计时器" hidden>
            <ol id="timer-splits" className="timer-splits">
              {["R1", "R2", "R3", "R4"].map((label, index) => (
                <li data-segment-index={index} key={label}><span>{label}</span><time>—</time></li>
              ))}
            </ol>
            <div className="live-timer-clock"><output id="timer-clock" aria-live="off">0.00</output></div>
            <div className="live-timer-real"><output id="timer-real-clock">Real Time 0.00</output></div>
            <footer className="live-timer-footer">
              <div className="timer-actions">
                <button id="timer-toggle" type="button" title="开始或暂停计时" aria-label="开始或暂停计时"><Play size={12} /></button>
                <button id="timer-split" type="button" title="手动分段" aria-label="手动分段"><SkipForward size={12} /></button>
                <button id="timer-reset" type="button" title="重置计时" aria-label="重置计时"><RotateCcw size={12} /></button>
              </div>
            </footer>
          </section>
          <div id="loading-screen" className="loading-screen" role="status" aria-live="polite">
            <div className="seal" aria-hidden="true" />
            <p id="loading-title">正在检查官方运行包</p>
            <div className="progress-track" aria-hidden="true"><span id="progress-fill" /></div>
            <p id="loading-detail" className="loading-detail" />
          </div>
          <div id="error-screen" className="error-screen" role="alert" hidden>
            <p>启动失败</p>
            <strong id="error-message" />
          </div>
        </section>

        <aside id="debug-panel" className="debug-panel" aria-label="调试面板">
          <button id="panel-toggle" className="panel-toggle" type="button" aria-expanded="true" title="收起调试面板">
            <ChevronLeft size={17} aria-hidden="true" />
          </button>
          <div className="debug-content">
            <header className="practice-header">
              <img className="panel-knight" src="/static/knight-ui.png" alt="" />
              <h1>苦痛之路</h1>
            </header>

            <fieldset className="version-picker" aria-label="游戏版本">
              {versions.map((version) => (
                <label className="version-option" key={version}>
                  <input type="radio" name="game-version" value={version} />
                  <span><strong>{version}</strong></span>
                </label>
              ))}
            </fieldset>

            <fieldset className="debug-actions" aria-label="调试功能">
              {debugActions.map(([method, label]) => (
                <button
                  type="button"
                  data-debug-method={method}
                  aria-pressed={method.startsWith("Toggle") ? "false" : undefined}
                  key={method}
                >
                  {label}
                </button>
              ))}
            </fieldset>

            <div id="social-replay-root" aria-label="Replay 社区"><SocialReplayPanel /></div>
            <div hidden aria-hidden="true">
              <input id="replay-ghost-toggle" type="checkbox" />
              <select id="replay-ghost-run" defaultValue="" />
              <input id="replay-ghost-opacity" type="range" min="0.2" max="0.85" step="0.05" defaultValue="0.55" />
              <p id="replay-ghost-status" />
            </div>
          </div>
          <section id="replay-export-prompt" className="replay-export-prompt" role="dialog" aria-labelledby="replay-export-title" hidden>
            <div className="replay-export-summary" aria-live="polite">
              <strong id="replay-export-title">Replay 已记录</strong>
              <span id="replay-export-room" />
              <span id="replay-export-time" />
              <span id="replay-export-frames" />
            </div>
            <div className="replay-export-actions">
              <button id="replay-export-download" type="button">导出 Replay</button>
              <button id="replay-export-dismiss" type="button">暂不导出</button>
            </div>
            <p id="replay-export-error" role="alert" hidden />
          </section>
        </aside>
      </main>
      <Script src="/static/unity-practice.js" strategy="afterInteractive" />
    </>
  );
}
