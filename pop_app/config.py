from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def _session_secret(data_dir: Path) -> str:
    configured = os.getenv("SESSION_SECRET", "").strip()
    if configured:
        return configured
    data_dir.mkdir(parents=True, exist_ok=True)
    secret_path = data_dir / "session-secret"
    if secret_path.is_file():
        existing = secret_path.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    generated = secrets.token_urlsafe(64)
    secret_path.write_text(generated, encoding="utf-8")
    return generated


@dataclass(frozen=True)
class Settings:
    base_dir: Path = Path(__file__).resolve().parent.parent
    runtime_dir: Path = base_dir / "data"
    db_path: Path = runtime_dir / "replays.sqlite3"
    template_dir: Path = base_dir / "templates"
    static_dir: Path = base_dir / "static"
    unity_build_dir: Path = base_dir / "runtime" / "unity-webgl"
    hero_dir: Path = base_dir / "runtime" / "hero"
    public_url: str = os.getenv("POP_PUBLIC_URL", "").strip().rstrip("/")
    r2_public_url: str = os.getenv("POP_R2_PUBLIC_URL", "").strip().rstrip("/")
    github_client_id: str = os.getenv("GITHUB_CLIENT_ID", "").strip()
    github_client_secret: str = os.getenv("GITHUB_CLIENT_SECRET", "").strip()
    discord_client_id: str = os.getenv("DISCORD_CLIENT_ID", "").strip()
    discord_client_secret: str = os.getenv("DISCORD_CLIENT_SECRET", "").strip()
    session_cookie_secure: bool = _env_flag(
        "SESSION_COOKIE_SECURE",
        os.getenv("POP_PUBLIC_URL", "").strip().lower().startswith("https://"),
    )
    session_secret: str = _session_secret(runtime_dir)


settings = Settings()
