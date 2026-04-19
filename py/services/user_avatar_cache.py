"""
用户头像本地缓存：扩展根目录下 user_avatars/，按「净化后的用户名」存盘，
供用户视图侧边栏使用 /api/lm/user-avatars/<文件名> 访问（避免仅依赖外链）。
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Any, Dict, List, Optional

from ..utils.settings_paths import get_project_root
from .downloader import get_downloader

logger = logging.getLogger(__name__)

USER_AVATARS_DIRNAME = "user_avatars"
_AVATAR_EXTENSIONS = (".webp", ".png", ".jpg", ".jpeg", ".gif")
_MIN_BYTES = 48

_avatar_locks: Dict[str, asyncio.Lock] = {}
_avatar_locks_guard = asyncio.Lock()


def get_user_avatars_directory() -> str:
    """返回并确保存在：扩展仓库根目录下的 user_avatars 文件夹。"""
    path = os.path.join(get_project_root(), USER_AVATARS_DIRNAME)
    os.makedirs(path, exist_ok=True)
    return path


def register_user_avatars_static_route(app: Any) -> None:
    """注册 /api/lm/user-avatars/ → 本地 user_avatars 目录（与 lora_manager / standalone 共用）。"""
    root = get_user_avatars_directory()
    app.router.add_static("/api/lm/user-avatars", root)
    logger.info("User avatars static route: /api/lm/user-avatars -> %s", root)


def sanitize_username_for_filename(username: str) -> str:
    """文件名安全：仅保留常见安全字符，避免路径穿越。"""
    if not isinstance(username, str):
        return "_invalid"
    s = username.strip()
    if not s:
        return "_empty"
    s = re.sub(r"[^a-zA-Z0-9._-]+", "_", s)
    if len(s) > 120:
        s = s[:120]
    return s or "_empty"


def _should_fetch_avatar(username: str) -> bool:
    if not username or not isinstance(username, str):
        return False
    u = username.strip()
    if not u or u == "__unknown__":
        return False
    if u.startswith("__") and u.endswith("__"):
        return False
    return True


def find_local_avatar_file(username: str) -> Optional[str]:
    """若已存在任一扩展名的头像文件，返回绝对路径。"""
    base = sanitize_username_for_filename(username)
    root = os.path.join(get_project_root(), USER_AVATARS_DIRNAME)
    for ext in _AVATAR_EXTENSIONS:
        p = os.path.join(root, base + ext)
        try:
            if os.path.isfile(p) and os.path.getsize(p) >= _MIN_BYTES:
                return p
        except OSError:
            continue
    return None


def public_url_for_local_avatar(abs_path: str) -> str:
    name = os.path.basename(abs_path.replace("\\", "/"))
    return f"/api/lm/user-avatars/{name}"


def _ext_from_content_type(content_type: Optional[str]) -> str:
    if not content_type:
        return "webp"
    ct = content_type.split(";", 1)[0].strip().lower()
    mapping = {
        "image/webp": "webp",
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/gif": "gif",
    }
    return mapping.get(ct, "webp")


def _ext_from_url(url: str) -> Optional[str]:
    path = url.split("?", 1)[0].lower()
    for ext in _AVATAR_EXTENSIONS:
        if path.endswith(ext):
            return ext[1:]
    return None


async def _get_username_lock(key: str) -> asyncio.Lock:
    async with _avatar_locks_guard:
        lock = _avatar_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            _avatar_locks[key] = lock
        return lock


async def _download_avatar_to_user_folder(url: str, username: str) -> Optional[str]:
    """下载头像到 user_avatars/<safe>.<ext>，成功返回绝对路径。"""
    root = get_user_avatars_directory()
    base = sanitize_username_for_filename(username)
    tmp = os.path.join(root, f".{base}.download")
    try:
        downloader = await get_downloader()
        success, content, headers = await downloader.download_to_memory(
            url, use_auth=False, return_headers=True
        )
        if not success or not isinstance(content, (bytes, bytearray)):
            return None
        data = bytes(content)
        if len(data) < _MIN_BYTES:
            return None
        hdr = headers if isinstance(headers, dict) else {}
        ctype = hdr.get("Content-Type")
        ext = _ext_from_url(url) or _ext_from_content_type(ctype)
        if ext not in {e[1:] for e in _AVATAR_EXTENSIONS}:
            ext = "webp"
        dest = os.path.join(root, f"{base}.{ext}")
        os.makedirs(root, exist_ok=True)
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, dest)
        if os.path.isfile(dest) and os.path.getsize(dest) >= _MIN_BYTES:
            return dest
        return None
    except Exception as exc:
        logger.debug("avatar download failed %s: %s", url[:80], exc)
        try:
            if os.path.isfile(tmp):
                os.remove(tmp)
        except OSError:
            pass
        return None


async def ensure_local_avatar_url(username: str, remote_hint: Optional[str]) -> str:
    """
    返回用于前端展示的 avatar URL：优先已缓存的本地文件；否则尝试 remote_hint 或 Civitai 解析后下载。
    失败时退回 remote_hint（保持原有外链行为）。
    """
    if not _should_fetch_avatar(username):
        return (remote_hint or "").strip()

    existing = find_local_avatar_file(username)
    if existing:
        return public_url_for_local_avatar(existing)

    key = sanitize_username_for_filename(username)
    lock = await _get_username_lock(key)
    async with lock:
        existing2 = find_local_avatar_file(username)
        if existing2:
            return public_url_for_local_avatar(existing2)

        url_to_fetch = (remote_hint or "").strip()
        if not url_to_fetch:
            from .civitai_client import CivitaiClient
            from .errors import RateLimitError

            try:
                client = await CivitaiClient.get_instance()
                url_to_fetch = (await client.fetch_creator_image_url(username) or "").strip()
            except RateLimitError:
                return (remote_hint or "").strip()

        if not url_to_fetch:
            return (remote_hint or "").strip()

        saved = await _download_avatar_to_user_folder(url_to_fetch, username)
        if saved:
            return public_url_for_local_avatar(saved)

        return (remote_hint or url_to_fetch).strip()


async def hydrate_sidebar_creator_avatars(users: List[Dict[str, Any]]) -> None:
    """并发为用户行写入 avatar_url（本地命中则换成本站 URL）。"""
    if not users:
        return
    sem = asyncio.Semaphore(6)

    async def _one(row: Dict[str, Any]) -> None:
        username = row.get("username") or ""
        remote = (row.get("avatar_url") or "").strip()
        async with sem:
            try:
                row["avatar_url"] = await ensure_local_avatar_url(username, remote or None)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.debug("hydrate avatar %s: %s", username, exc)

    await asyncio.gather(*(_one(u) for u in users))
