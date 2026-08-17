"use client";

import { useEffect, useMemo, useState } from "react";

type Provider = "github" | "discord";
type User = {
  id: string;
  handle: string;
  display_name: string;
  avatar_url: string;
  providers?: Array<{ provider: Provider; login: string }>;
};
type LeaderboardRun = {
  rank: number;
  run_id: string;
  total_time: number;
  frame_count: number;
  created_at: string;
  user: User & { provider: Provider | "" };
};
type SelectedReplay = { runId: string; color: string; opacity: number };
type ProviderState = { enabled: boolean; login_url: string };

const ROOM_LABELS: Record<string, string> = {
  White_Palace_18: "第一房",
  White_Palace_17: "第二房",
  White_Palace_19: "第三房",
  White_Palace_20: "第四房",
};
const COLORS = ["#5be7c4", "#ffd166", "#8ab4ff", "#ff8fab", "#c7a7ff", "#f9a65a", "#76e5ff", "#c7f464"];

function formatTime(seconds: number): string {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const remainder = value - minutes * 60;
  return minutes ? `${minutes}:${remainder.toFixed(2).padStart(5, "0")}` : remainder.toFixed(2);
}

function avatar(user: User): string {
  return user.avatar_url || `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(user.handle)}`;
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.detail || `请求失败：${response.status}`);
  }
  return payload as T;
}

export default function SocialReplayPanel() {
  const [user, setUser] = useState<User | null>(null);
  const [providers, setProviders] = useState<Record<Provider, ProviderState>>({
    github: { enabled: false, login_url: "/auth/github" },
    discord: { enabled: false, login_url: "/auth/discord" },
  });
  const [scene, setScene] = useState<string>("");
  const [runs, setRuns] = useState<LeaderboardRun[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploadStatus, setUploadStatus] = useState("");
  const [leaderboardStatus, setLeaderboardStatus] = useState("");
  const [ghostStatus, setGhostStatus] = useState("");
  const [loading, setLoading] = useState(false);

  const selectedPayload = useMemo<SelectedReplay[]>(() => {
    return [...selected].map((runId, index) => ({
      runId,
      color: COLORS[index % COLORS.length],
      opacity: 0.58,
    }));
  }, [selected]);

  useEffect(() => {
    fetchJson<{ user: User | null; providers: Record<Provider, ProviderState> }>("/api/auth/me", { credentials: "same-origin" })
      .then((payload) => {
        setUser(payload.user || null);
        setProviders(payload.providers || {});
        setUploadStatus("");
      })
      .catch(() => setUploadStatus("账号状态读取失败"));
  }, []);

  useEffect(() => {
    const onRoomChange = (event: Event) => {
      const nextScene = (event as CustomEvent<{ sceneName?: string }>).detail?.sceneName || "";
      setScene(nextScene);
      setSelected(new Set());
    };
    window.addEventListener("practice-room-change", onRoomChange);
    return () => window.removeEventListener("practice-room-change", onRoomChange);
  }, []);

  useEffect(() => {
    const onGhostStatus = (event: Event) => {
      setGhostStatus((event as CustomEvent<{ message?: string }>).detail?.message || "");
    };
    window.addEventListener("practice-replay-selection-status", onGhostStatus);
    return () => window.removeEventListener("practice-replay-selection-status", onGhostStatus);
  }, []);

  useEffect(() => {
    if (!scene || !ROOM_LABELS[scene]) {
      setRuns([]);
      setLeaderboardStatus("");
      return;
    }
    setLoading(true);
    setLeaderboardStatus("");
    fetchJson<{ runs: LeaderboardRun[] }>(`/api/social/leaderboards/${encodeURIComponent(scene)}`, { credentials: "same-origin" })
      .then((payload) => setRuns(Array.isArray(payload.runs) ? payload.runs : []))
      .catch((error) => {
        setRuns([]);
        setLeaderboardStatus(error instanceof Error ? error.message : "榜单读取失败");
      })
      .finally(() => setLoading(false));
  }, [scene]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("practice-replay-selection-change", {
      detail: { sceneName: scene, selected: selectedPayload },
    }));
  }, [scene, selectedPayload]);

  function toggleRun(runId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else if (next.size < 8) next.add(runId);
      return next;
    });
  }

  async function upload(file: File | undefined) {
    if (!file || !user) return;
    setUploadStatus("正在校验并上传");
    const form = new FormData();
    form.append("replay_file", file);
    try {
      const payload = await fetchJson<{ upload: { room_count: number } }>("/api/social/replays", {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      setUploadStatus(`已保存 ${payload.upload.room_count} 个房间`);
      if (scene) {
        const nextPayload = await fetchJson<{ runs: LeaderboardRun[] }>(`/api/social/leaderboards/${encodeURIComponent(scene)}`, { credentials: "same-origin" });
        setRuns(Array.isArray(nextPayload.runs) ? nextPayload.runs : []);
      }
    } catch (error) {
      setUploadStatus(error instanceof Error ? error.message : "上传失败");
    }
  }

  async function logout() {
    try {
      await fetchJson<{ ok: boolean }>("/auth/logout", { method: "POST", credentials: "same-origin" });
      setUser(null);
      setUploadStatus("");
    } catch (error) {
      setUploadStatus(error instanceof Error ? error.message : "退出失败");
    }
  }

  return (
    <section className="social-panel" aria-label="Replay 社区">
      <header className="social-header">
        <h2>房间榜单</h2>
        <span className="social-room">{ROOM_LABELS[scene] || "前置房"}</span>
      </header>

      {user ? (
        <div className="social-user">
          <img src={avatar(user)} alt="" />
          <span>{user.display_name}</span>
          <button type="button" onClick={logout} title="退出登录">退出</button>
        </div>
      ) : (
        <div className="social-login-buttons">
          {(["github", "discord"] as Provider[]).map((provider) => (
            providers[provider]?.enabled ? (
              <a key={provider} className={`oauth-button oauth-${provider}`} href={providers[provider].login_url}>
                {provider === "github" ? "GitHub" : "Discord"}
              </a>
            ) : (
              <button key={provider} type="button" className={`oauth-button oauth-${provider}`} disabled>
                {provider === "github" ? "GitHub" : "Discord"}
              </button>
            )
          ))}
        </div>
      )}

      <label className={`social-upload ${!user ? "is-disabled" : ""}`}>
        <span>上传 Replay JSON</span>
        <input type="file" accept=".json,.txt,.rtmc" disabled={!user} onChange={(event) => upload(event.target.files?.[0])} />
      </label>
      {uploadStatus ? <p className="social-status" role="status">{uploadStatus}</p> : null}

      <div className="social-runs">
        {leaderboardStatus ? <p className="social-empty is-error">{leaderboardStatus}</p> : null}
        {scene && ROOM_LABELS[scene] && !loading && !runs.length ? <p className="social-empty">当前房间还没有用户成绩</p> : null}
        {runs.map((run) => (
          <label className={`social-run ${selected.has(run.run_id) ? "is-selected" : ""}`} key={run.run_id}>
            <input type="checkbox" checked={selected.has(run.run_id)} onChange={() => toggleRun(run.run_id)} />
            <span className="social-rank">{String(run.rank).padStart(2, "0")}</span>
            <img src={avatar(run.user)} alt="" />
            <span className="social-run-user">{run.user.display_name}<small>@{run.user.handle}</small></span>
            <time>{formatTime(run.total_time)}</time>
          </label>
        ))}
      </div>
      {selected.size ? <p className="social-status" role="status">{ghostStatus || "正在载入 Replay"}</p> : null}
    </section>
  );
}
