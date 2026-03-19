"""Local runtime configuration storage for service credentials and OAuth state."""

from __future__ import annotations

import copy
import json
import os
import threading
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any, Dict


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "output"
OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", str(DEFAULT_OUTPUT_DIR)))
CONFIG_DIR = OUTPUT_DIR / "_runtime"
CONFIG_FILE = CONFIG_DIR / "service_settings.json"

_CONFIG_LOCK = threading.RLock()

DEFAULT_NOTION_CONNECTION: Dict[str, str] = {
    "server_url": "https://mcp.notion.com/mcp",
    "auth_server": "",
    "client_id": "",
    "client_secret": "",
    "registration_client_uri": "",
    "redirect_uri": "",
    "scope": "",
    "access_token": "",
    "refresh_token": "",
    "token_type": "Bearer",
    "expires_at": "",
    "workspace_id": "",
    "workspace_name": "",
    "workspace_icon": "",
    "bot_id": "",
    "owner_user_id": "",
    "connected_at": "",
}

DEFAULT_SERVICE_CONFIG: Dict[str, Any] = {
    "openai_api_key": "",
    "tavily_api_key": "",
    "discord_webhook_full": "",
    "discord_webhook_summary": "",
    "notion_connection": DEFAULT_NOTION_CONNECTION,
}


def get_service_config_path() -> Path:
    """Return the on-disk path used for runtime service settings."""
    return CONFIG_FILE


def _normalize_text(value: Any) -> str:
    return str(value or "").strip()


def _normalize_mapping(value: Any, defaults: Dict[str, Any]) -> Dict[str, Any]:
    normalized = copy.deepcopy(defaults)
    if not isinstance(value, dict):
        return normalized

    for key, default_value in defaults.items():
        raw_value = value.get(key, default_value)
        if isinstance(default_value, dict):
            normalized[key] = _normalize_mapping(raw_value, default_value)
        else:
            normalized[key] = _normalize_text(raw_value)
    return normalized


def _merge_service_config(current: Dict[str, Any], updates: Dict[str, Any]) -> Dict[str, Any]:
    merged = copy.deepcopy(current)
    for key, value in updates.items():
        if key not in DEFAULT_SERVICE_CONFIG:
            continue
        if isinstance(DEFAULT_SERVICE_CONFIG[key], dict):
            merged[key] = _normalize_mapping(value, DEFAULT_SERVICE_CONFIG[key])
        else:
            merged[key] = _normalize_text(value)
    return merged


def load_service_config() -> Dict[str, Any]:
    """Load runtime service settings from local JSON storage."""
    with _CONFIG_LOCK:
        config = copy.deepcopy(DEFAULT_SERVICE_CONFIG)
        if not CONFIG_FILE.exists():
            return config

        try:
            raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return config

        if isinstance(raw, dict):
            return _merge_service_config(config, raw)
        return config


def update_service_config(updates: Dict[str, Any]) -> Dict[str, Any]:
    """Persist partial updates to runtime service settings."""
    with _CONFIG_LOCK:
        current = load_service_config()
        merged = _merge_service_config(current, updates)
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)

        with NamedTemporaryFile(
            "w",
            encoding="utf-8",
            delete=False,
            dir=str(CONFIG_DIR),
            suffix=".tmp",
        ) as handle:
            json.dump(merged, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            temp_name = handle.name

        Path(temp_name).replace(CONFIG_FILE)
        return merged


def get_openai_api_key() -> str:
    return str(load_service_config()["openai_api_key"])


def get_tavily_api_key() -> str:
    return str(load_service_config()["tavily_api_key"])


def get_discord_webhook_full() -> str:
    return str(load_service_config()["discord_webhook_full"])


def get_discord_webhook_summary() -> str:
    return str(load_service_config()["discord_webhook_summary"])


def get_notion_connection() -> Dict[str, str]:
    config = load_service_config()
    notion_connection = config.get("notion_connection", {})
    return _normalize_mapping(notion_connection, DEFAULT_NOTION_CONNECTION)


def update_notion_connection(updates: Dict[str, Any]) -> Dict[str, str]:
    current = get_notion_connection()
    merged = _normalize_mapping({**current, **updates}, DEFAULT_NOTION_CONNECTION)
    config = update_service_config({"notion_connection": merged})
    return _normalize_mapping(config.get("notion_connection", {}), DEFAULT_NOTION_CONNECTION)


def clear_notion_connection() -> Dict[str, str]:
    config = update_service_config({"notion_connection": DEFAULT_NOTION_CONNECTION})
    return _normalize_mapping(config.get("notion_connection", {}), DEFAULT_NOTION_CONNECTION)


def sanitize_service_config_for_api(config: Dict[str, Any]) -> Dict[str, Any]:
    notion_connection = _normalize_mapping(
        config.get("notion_connection", {}),
        DEFAULT_NOTION_CONNECTION,
    )
    sanitized_notion = {
        "connected": bool(notion_connection["refresh_token"] or notion_connection["access_token"]),
        "server_url": notion_connection["server_url"],
        "auth_server": notion_connection["auth_server"],
        "workspace_id": notion_connection["workspace_id"],
        "workspace_name": notion_connection["workspace_name"],
        "workspace_icon": notion_connection["workspace_icon"],
        "bot_id": notion_connection["bot_id"],
        "owner_user_id": notion_connection["owner_user_id"],
        "connected_at": notion_connection["connected_at"],
        "expires_at": notion_connection["expires_at"],
    }
    return {
        "openai_api_key": _normalize_text(config.get("openai_api_key", "")),
        "tavily_api_key": _normalize_text(config.get("tavily_api_key", "")),
        "discord_webhook_full": _normalize_text(config.get("discord_webhook_full", "")),
        "discord_webhook_summary": _normalize_text(config.get("discord_webhook_summary", "")),
        "notion_connection": sanitized_notion,
    }


def require_openai_api_key() -> str:
    api_key = get_openai_api_key()
    if not api_key:
        raise RuntimeError(
            "OpenAI API key is not configured. Open the Account settings in the web UI and save it first."
        )
    return api_key


def require_tavily_api_key() -> str:
    api_key = get_tavily_api_key()
    if not api_key:
        raise RuntimeError(
            "Tavily API key is not configured. Open the Account settings in the web UI and save it first."
        )
    return api_key


def require_notion_connection() -> Dict[str, str]:
    notion_connection = get_notion_connection()
    if not notion_connection["access_token"] and not notion_connection["refresh_token"]:
        raise RuntimeError(
            "Notion is not connected. Open the Account settings in the web UI and connect your Notion account first."
        )
    return notion_connection


def build_openai_client():
    from openai import OpenAI

    return OpenAI(api_key=require_openai_api_key())


def build_async_openai_client():
    from openai import AsyncOpenAI

    return AsyncOpenAI(api_key=require_openai_api_key())
