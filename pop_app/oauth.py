from __future__ import annotations

from authlib.integrations.starlette_client import OAuth
from fastapi import HTTPException, Request

from .config import settings
from . import social_db


PROVIDERS = {"github", "discord"}
oauth = OAuth()

if settings.github_client_id and settings.github_client_secret:
    oauth.register(
        name="github",
        client_id=settings.github_client_id,
        client_secret=settings.github_client_secret,
        access_token_url="https://github.com/login/oauth/access_token",
        authorize_url="https://github.com/login/oauth/authorize",
        api_base_url="https://api.github.com/",
        client_kwargs={"scope": "read:user"},
    )

if settings.discord_client_id and settings.discord_client_secret:
    oauth.register(
        name="discord",
        client_id=settings.discord_client_id,
        client_secret=settings.discord_client_secret,
        access_token_url="https://discord.com/api/oauth2/token",
        authorize_url="https://discord.com/oauth2/authorize",
        api_base_url="https://discord.com/api/",
        client_kwargs={"scope": "identify"},
    )


def provider_enabled(provider: str) -> bool:
    return provider in PROVIDERS and oauth.create_client(provider) is not None


def callback_url(request: Request, provider: str) -> str:
    path = request.url_for("oauth_callback", provider=provider).path
    if settings.public_url:
        return f"{settings.public_url}{path}"
    return str(request.url_for("oauth_callback", provider=provider))


def current_user(request: Request) -> dict[str, object] | None:
    user_id = str(request.session.get("user_id") or "")
    return social_db.get_user(user_id) if user_id else None


def require_user(request: Request) -> dict[str, object]:
    user = current_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="请先通过 GitHub 或 Discord 登录")
    return user


async def resolve_identity(provider: str, token: dict[str, object]) -> dict[str, str]:
    client = oauth.create_client(provider)
    if client is None:
        raise HTTPException(status_code=404, detail="该登录方式尚未配置")
    if provider == "github":
        response = await client.get("user", token=token)
        response.raise_for_status()
        profile = response.json()
        login = str(profile.get("login") or "").strip()
        return {
            "provider_user_id": str(profile.get("id") or ""),
            "provider_login": login,
            "display_name": str(profile.get("name") or login).strip(),
            "avatar_url": str(profile.get("avatar_url") or "").strip(),
        }
    response = await client.get("users/@me", token=token)
    response.raise_for_status()
    profile = response.json()
    provider_user_id = str(profile.get("id") or "")
    login = str(profile.get("global_name") or profile.get("username") or "").strip()
    avatar_hash = str(profile.get("avatar") or "")
    avatar_url = (
        f"https://cdn.discordapp.com/avatars/{provider_user_id}/{avatar_hash}.png?size=128"
        if avatar_hash
        else ""
    )
    return {
        "provider_user_id": provider_user_id,
        "provider_login": str(profile.get("username") or login).strip(),
        "display_name": login,
        "avatar_url": avatar_url,
    }
