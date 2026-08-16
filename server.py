from __future__ import annotations

import copy
import json
import math
import mimetypes
from pathlib import Path

import brotli
from authlib.integrations.base_client.errors import OAuthError
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from httpx import HTTPError as HttpxError
from pydantic import BaseModel
from starlette.middleware.sessions import SessionMiddleware

from pop_app import db, oauth as oauth_service, social_db
from pop_app.config import settings
from pop_app.replay_parser import (
    FrameState,
    RecordedRoom,
    ReplayParseError,
    RoomKey,
    build_action_sequence,
    classify_action,
    encode_collection,
    parse_upload,
)


UNITY_VERSIONS = (
    {"id": "1.5.78.11833", "directory": "practice-1.5.78.11833"},
    {"id": "1.5.12620", "directory": "practice-1.5.12620-live-timer-v57-formal"},
)
PRACTICE_ROUTES = {
    "White_Palace_18": ("White_Palace_06", "White_Palace_17"),
    "White_Palace_17": ("White_Palace_18", "White_Palace_19"),
    "White_Palace_19": ("White_Palace_17", "White_Palace_20"),
    "White_Palace_20": ("White_Palace_19", "White_Palace_06"),
}
PRACTICE_ROOMS = tuple(PRACTICE_ROUTES)
CAMERA_PROJECTION = {
    "baseline_world_height": 16.196809350584537,
    "minimum_aspect": 1.6,
    "maximum_aspect": 2.3916667,
}


class PracticeReplayFrameRequest(BaseModel):
    elapsed: float
    x: float
    y: float
    facingRight: bool
    animClip: str = ""
    animFrame: int = 0


class PracticeReplayExportRequest(BaseModel):
    format: str
    gameVersion: str
    sceneName: str
    entryFromScene: str
    exitToScene: str
    totalTime: float
    frames: list[PracticeReplayFrameRequest]


app = FastAPI(title="Path of Pain Practice")
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.session_secret,
    session_cookie="pop_session",
    max_age=60 * 60 * 24 * 30,
    same_site="lax",
    https_only=settings.session_cookie_secure,
)
templates = Jinja2Templates(directory=str(settings.template_dir))

settings.runtime_dir.mkdir(parents=True, exist_ok=True)
settings.unity_build_dir.mkdir(parents=True, exist_ok=True)
settings.hero_dir.mkdir(parents=True, exist_ok=True)
db.init_db()
social_db.init_social_db()

app.mount("/static", StaticFiles(directory=str(settings.static_dir)), name="static")
app.mount("/generated/hero", StaticFiles(directory=str(settings.hero_dir)), name="generated_hero")
app.mount(
    "/unity-practice-builds",
    StaticFiles(directory=str(settings.unity_build_dir)),
    name="unity_practice_builds",
)


@app.middleware("http")
async def deployment_headers(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.startswith(("/static/", "/generated/hero/", "/unity-practice-builds/")):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif path == "/" or path.startswith(("/practice", "/api/", "/auth/")):
        response.headers["Cache-Control"] = "no-store"
    if path.startswith("/unity-practice-builds/") and path.endswith(".br"):
        response.headers["Content-Encoding"] = "br"
        source_path = path[:-3]
        media_type = {
            ".data": "application/octet-stream",
            ".wasm": "application/wasm",
            ".js": "application/javascript; charset=utf-8",
        }.get(Path(source_path).suffix)
        if media_type is None:
            media_type, _ = mimetypes.guess_type(source_path)
        if media_type:
            response.headers["Content-Type"] = media_type
        response.headers["Vary"] = "Accept-Encoding"
    return response


def asset_version() -> str:
    candidates = [
        settings.static_dir / "unity-practice.js",
        settings.static_dir / "unity-practice.css",
        settings.static_dir / "unity-practice-runner.js",
        settings.static_dir / "unity-practice-runner.css",
        settings.static_dir / "social" / "social.js",
        settings.static_dir / "social" / "social.css",
    ]
    return str(max(path.stat().st_mtime_ns for path in candidates if path.is_file()))


def read_build_text(path: Path) -> str:
    payload = path.read_bytes()
    if path.suffix == ".br":
        payload = brotli.decompress(payload)
    return payload.decode("utf-8", errors="ignore")


def build_catalog_entry(version_id: str) -> dict[str, object]:
    catalog_path = settings.unity_build_dir / "build-manifest.json"
    if not catalog_path.is_file():
        return {}
    payload = json.loads(catalog_path.read_text(encoding="utf-8"))
    entry = payload.get("versions", {}).get(version_id, {})
    return entry if isinstance(entry, dict) else {}


def practice_build_manifest(version: dict[str, str]) -> dict[str, object]:
    version_id = version["id"]
    directory_name = version["directory"]
    build_directory = settings.unity_build_dir / directory_name
    build_files_directory = build_directory / "Build"
    catalog_entry = build_catalog_entry(version_id)
    catalog_files = catalog_entry.get("files", {})
    if not isinstance(catalog_files, dict):
        catalog_files = {}
    result: dict[str, object] = {
        "id": version_id,
        "label": version_id,
        "available": False,
    }
    if not (build_directory / "index.html").is_file() or not build_files_directory.is_dir():
        result["error"] = f"{version_id} 的运行包尚未生成"
        return result

    loader_files = sorted(build_files_directory.glob("*.loader.js"))
    if len(loader_files) != 1:
        result["error"] = f"{version_id} 的 Unity 加载器数量不正确"
        return result
    build_name = loader_files[0].name.removesuffix(".loader.js")
    patterns = {
        "dataUrl": f"{build_name}.data*",
        "frameworkUrl": f"{build_name}.framework.js*",
        "codeUrl": f"{build_name}.wasm*",
    }
    files: dict[str, Path] = {}
    for field_name, pattern in patterns.items():
        matches = sorted(build_files_directory.glob(pattern))
        if len(matches) == 1:
            files[field_name] = matches[0]
            continue
        remote_name = str(catalog_files.get(field_name) or "")
        if len(matches) == 0 and settings.r2_public_url and remote_name:
            files[field_name] = build_files_directory / remote_name
            continue
        if len(matches) != 1:
            result["error"] = f"{version_id} 的 {field_name} 文件数量不正确"
            return result

    local_public_root = f"/unity-practice-builds/{directory_name}"
    large_file_root = (
        f"{settings.r2_public_url}{local_public_root}"
        if settings.r2_public_url
        else local_public_root
    )
    result.update(
        {
            "available": True,
            "replayCaptureAvailable": (
                "OriginalPracticePushReplayFrame" in read_build_text(files["frameworkUrl"])
                if files["frameworkUrl"].is_file()
                else bool(catalog_entry.get("replayCaptureAvailable"))
            ),
            "loaderUrl": f"{local_public_root}/Build/{loader_files[0].name}",
            "dataUrl": f"{large_file_root}/Build/{files['dataUrl'].name}",
            "frameworkUrl": f"{large_file_root}/Build/{files['frameworkUrl'].name}",
            "codeUrl": f"{large_file_root}/Build/{files['codeUrl'].name}",
            "streamingAssetsUrl": f"{local_public_root}/StreamingAssets",
            "r2Enabled": bool(settings.r2_public_url),
            "compression": "brotli" if any(path.suffix == ".br" for path in files.values()) else "none",
            "companyName": "Team Cherry",
            "productName": "Hollow Knight",
            "productVersion": version_id,
        }
    )
    return result


def hero_manifest() -> dict[str, object]:
    manifest_path = settings.hero_dir / "knight_manifest.json"
    if not manifest_path.is_file():
        raise HTTPException(status_code=503, detail="人物动画资源尚未部署")
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    generated_at = str(payload.get("generated_at") or "1")
    result = copy.deepcopy(payload)
    for atlas in result.get("atlases", {}).values():
        image_name = str(atlas.get("image_name") or "")
        if image_name:
            atlas["image_url"] = f"/generated/hero/{image_name}?v={generated_at}"
    for particle in result.get("particle_systems", {}).values():
        image_name = str(particle.get("image_name") or "")
        if image_name:
            particle["image_url"] = f"/generated/hero/{image_name}?v={generated_at}"
    return result


@app.on_event("startup")
def startup() -> None:
    db.init_db()
    social_db.init_social_db()


@app.get("/health")
def health() -> dict[str, object]:
    manifests = [practice_build_manifest(version) for version in UNITY_VERSIONS]
    return {
        "ok": all(manifest["available"] for manifest in manifests),
        "project": "pop",
        "versions": manifests,
    }


@app.get("/", response_class=HTMLResponse)
@app.get("/practice", response_class=HTMLResponse)
def practice(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="unity_practice.html",
        context={"asset_version": asset_version()},
    )


@app.get("/practice/runner", response_class=HTMLResponse)
def practice_runner(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="unity_practice_runner.html",
        context={"asset_version": asset_version()},
    )


@app.get("/api/practice/builds")
def get_practice_builds() -> dict[str, object]:
    return {
        "defaultVersion": "1.5.12620",
        "initialLoadCount": 1,
        "versions": [practice_build_manifest(version) for version in UNITY_VERSIONS],
    }


@app.get("/api/hero-animation")
def get_hero_animation(game: str = "hollow_knight") -> dict[str, object]:
    if game.strip().lower().replace("-", "_") not in {"hollow_knight", "hk", "knight"}:
        raise HTTPException(status_code=404, detail="该人物资源不属于苦痛之路项目")
    return {"hero": hero_manifest()}


@app.get("/api/practice/replay")
def get_practice_replay(scene_name: str) -> dict[str, object]:
    if scene_name not in PRACTICE_ROOMS:
        raise HTTPException(status_code=404, detail=f"苦痛之路房间不存在：{scene_name}")
    replay_runs: list[dict[str, object]] = []
    for room in db.list_room_summaries().get("rooms", []):
        if room.get("scene_name") != scene_name:
            continue
        key = RoomKey(
            scene_name=scene_name,
            entry_from_scene=str(room.get("entry_from_scene") or ""),
            exit_to_scene=str(room.get("exit_to_scene") or ""),
        )
        for run in db.get_room_runs(key):
            replay_runs.append(
                {
                    **run,
                    "entry_from_scene": key.entry_from_scene,
                    "exit_to_scene": key.exit_to_scene,
                }
            )
    replay_runs.sort(key=lambda run: (float(run["total_time"]), str(run["player_name"])))
    return {"scene_name": scene_name, "projection": CAMERA_PROJECTION, "runs": replay_runs}


@app.post("/api/practice/replay/export")
def export_practice_replay(payload: PracticeReplayExportRequest) -> dict[str, object]:
    if payload.format != "original-practice-replay-v1":
        raise HTTPException(status_code=400, detail="Replay 录制格式无效")
    if PRACTICE_ROUTES.get(payload.sceneName) != (payload.entryFromScene, payload.exitToScene):
        raise HTTPException(status_code=400, detail="Replay 房间路线无效")
    if len(payload.frames) < 2 or len(payload.frames) > 100_000:
        raise HTTPException(status_code=400, detail="Replay 帧数无效")

    previous_elapsed = -1.0
    for frame in payload.frames:
        if (
            not math.isfinite(frame.elapsed)
            or not math.isfinite(frame.x)
            or not math.isfinite(frame.y)
            or frame.elapsed <= previous_elapsed
            or not -327.68 <= frame.x <= 327.67
            or not -327.68 <= frame.y <= 327.67
        ):
            raise HTTPException(status_code=400, detail="Replay 帧数据无效")
        previous_elapsed = frame.elapsed
    if payload.frames[0].elapsed < 0 or len({frame.animClip for frame in payload.frames if frame.animClip}) > 255:
        raise HTTPException(status_code=400, detail="Replay 时间或动画数据无效")

    frame_states = [
        FrameState(
            x=frame.x,
            y=frame.y,
            facing_right=not frame.facingRight,
            anim_clip=frame.animClip,
            anim_frame=max(0, min(frame.animFrame, 255)),
            action=classify_action(frame.animClip),
        )
        for frame in payload.frames
    ]
    room = RecordedRoom(
        key=RoomKey(payload.sceneName, payload.entryFromScene, payload.exitToScene),
        total_time=payload.frames[-1].elapsed,
        frames=[(frame.x, frame.y) for frame in frame_states],
        frame_states=frame_states,
        action_sequence=build_action_sequence(frame_states),
    )
    return {
        "filename": f"PathOfPain-{payload.sceneName}-{payload.gameVersion}.rtmc.txt",
        "shareText": encode_collection([room]),
        "sceneName": payload.sceneName,
        "totalTime": room.total_time,
        "frameCount": room.frame_count,
    }


@app.get("/api/auth/me")
def auth_me(request: Request) -> dict[str, object]:
    return {
        "user": oauth_service.current_user(request),
        "providers": {
            provider: {
                "enabled": oauth_service.provider_enabled(provider),
                "login_url": f"/auth/{provider}",
            }
            for provider in sorted(oauth_service.PROVIDERS)
        },
    }


@app.get("/auth/{provider}", name="oauth_login")
async def oauth_login(request: Request, provider: str):
    if not oauth_service.provider_enabled(provider):
        raise HTTPException(status_code=404, detail="该登录方式尚未配置")
    client = oauth_service.oauth.create_client(provider)
    return await client.authorize_redirect(request, oauth_service.callback_url(request, provider))


@app.get("/auth/{provider}/callback", name="oauth_callback")
async def oauth_callback(request: Request, provider: str):
    if not oauth_service.provider_enabled(provider):
        raise HTTPException(status_code=404, detail="该登录方式尚未配置")
    client = oauth_service.oauth.create_client(provider)
    try:
        token = await client.authorize_access_token(request)
        identity = await oauth_service.resolve_identity(provider, token)
    except OAuthError as exc:
        raise HTTPException(status_code=400, detail=f"OAuth 登录失败：{exc.error}") from exc
    except HttpxError as exc:
        raise HTTPException(status_code=502, detail="OAuth 平台暂时不可用") from exc
    user = social_db.upsert_oauth_user(provider=provider, **identity)
    request.session.clear()
    request.session["user_id"] = user["id"]
    return RedirectResponse(url="/?login=success", status_code=303)


@app.post("/auth/logout")
def oauth_logout(request: Request) -> dict[str, bool]:
    request.session.clear()
    return {"ok": True}


@app.post("/api/social/replays")
async def upload_social_replay(
    request: Request,
    replay_file: UploadFile = File(...),
    game_version: str = Form(default=""),
):
    user = oauth_service.require_user(request)
    filename = replay_file.filename or "replay.json"
    content = await replay_file.read(16 * 1024 * 1024 + 1)
    if not content:
        raise HTTPException(status_code=400, detail="上传文件为空")
    if len(content) > 16 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Replay 文件超过 16 MB")
    try:
        rooms = social_db.validate_rooms(parse_upload(filename, content), PRACTICE_ROUTES)
    except (ReplayParseError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    result = social_db.store_upload(
        user_id=str(user["id"]),
        original_filename=filename,
        rooms=rooms,
        game_version=game_version.strip()[:32],
    )
    return {"upload": result, "user": user}


@app.get("/api/social/leaderboards/{scene_name}")
def social_leaderboard(scene_name: str, limit: int = 100):
    if scene_name not in PRACTICE_ROOMS:
        raise HTTPException(status_code=404, detail="该房间不在苦痛之路排行榜中")
    return {"scene_name": scene_name, "runs": social_db.list_leaderboard(scene_name, limit=limit)}


@app.get("/api/social/replays/{run_id}")
def social_replay(run_id: str):
    replay = social_db.get_replay(run_id)
    if replay is None:
        raise HTTPException(status_code=404, detail="Replay 不存在")
    return {"replay": replay}


@app.get("/api/social/uploads")
def social_uploads(request: Request):
    user = oauth_service.require_user(request)
    return {"uploads": social_db.list_user_uploads(str(user["id"]))}


@app.delete("/api/social/uploads/{upload_id}")
def delete_social_upload(request: Request, upload_id: str):
    user = oauth_service.require_user(request)
    if not social_db.delete_upload(upload_id, str(user["id"])):
        raise HTTPException(status_code=404, detail="上传记录不存在")
    return {"ok": True}
