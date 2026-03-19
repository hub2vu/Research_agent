"""Hosted Notion MCP OAuth, transport, and note save helpers."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import re
import secrets
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlencode

import httpx

from mcp.base import ExecutionError, MCPTool, ToolParameter
from runtime.service_config import (
    clear_notion_connection,
    get_notion_connection,
    require_notion_connection,
    update_notion_connection,
)

logger = logging.getLogger(__name__)

NOTION_MCP_URL = "https://mcp.notion.com/mcp"
MCP_PROTOCOL_VERSION = "2025-11-05"
MCP_USER_AGENT = "research-agent-util/1.0"
AUTH_SESSION_TTL = timedelta(minutes=10)
TOKEN_REFRESH_SKEW = timedelta(minutes=2)
INITIAL_NOTION_PAGE_LIST_QUERIES: Tuple[str, ...] = ("a", "e", "1")

_OAUTH_SESSIONS: Dict[str, Dict[str, str]] = {}
_OAUTH_LOCK = threading.RLock()
_TOKEN_REFRESH_LOCK = asyncio.Lock()
_NOTION_PAGE_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


class NotionConnectionError(RuntimeError):
    """Raised when the local Notion OAuth state is missing or invalid."""


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _format_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _parse_utc(value: str) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _json_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except TypeError:
        return str(value)


def _clean_identifier(value: str) -> str:
    return re.sub(r"[^0-9a-fA-F-]", "", str(value or "")).strip()


def _normalize_page_id(value: str) -> str:
    raw = _clean_identifier(value)
    if len(raw) == 32 and "-" not in raw:
        return f"{raw[0:8]}-{raw[8:12]}-{raw[12:16]}-{raw[16:20]}-{raw[20:32]}"
    return raw


def _notion_url_to_page_id(value: str) -> str:
    match = re.search(r"([0-9a-fA-F]{32})", str(value or ""))
    return _normalize_page_id(match.group(1)) if match else ""


def _is_likely_notion_page_id(value: str) -> bool:
    return bool(_NOTION_PAGE_ID_PATTERN.fullmatch(str(value or "").strip()))


def _normalize_human_page_label(value: str, *, page_id: str = "", page_url: str = "") -> str:
    label = _coalesce(value)
    if not label:
        return ""
    if _is_likely_notion_page_id(label):
        return ""

    normalized_page_id = _normalize_page_id(page_id).lower()
    normalized_label_id = _normalize_page_id(label).lower()
    if normalized_page_id and normalized_label_id and normalized_page_id == normalized_label_id:
        return ""

    normalized_page_url = page_url.strip().lower()
    normalized_label = label.strip().lower()
    if normalized_page_url and normalized_label == normalized_page_url:
        return ""

    return label


def _sanitize_page_summary(page: Dict[str, str]) -> Dict[str, str]:
    page_id = _normalize_page_id(page.get("id", ""))
    page_url = page.get("url", "")
    title = _normalize_human_page_label(page.get("title", ""), page_id=page_id, page_url=page_url)
    path = _normalize_human_page_label(page.get("path", ""), page_id=page_id, page_url=page_url)
    if not title and path:
        title = path
    return {
        "id": page_id or _notion_url_to_page_id(page_url),
        "url": page_url,
        "title": title,
        "path": path,
        "kind": page.get("kind", "page"),
    }


def _generate_code_verifier() -> str:
    return secrets.token_urlsafe(64)


def _build_code_challenge(code_verifier: str) -> str:
    digest = hashlib.sha256(code_verifier.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).decode("utf-8").rstrip("=")


def _coalesce(*values: Any) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _dedupe_strings(values: Iterable[str]) -> List[str]:
    seen = set()
    result: List[str] = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _extract_text_from_tool_result(tool_result: Any) -> str:
    if tool_result is None:
        return ""
    if isinstance(tool_result, str):
        return tool_result
    if isinstance(tool_result, dict):
        texts: List[str] = []
        for item in tool_result.get("content", []) or []:
            if isinstance(item, dict) and item.get("type") == "text":
                text = item.get("text")
                if isinstance(text, str):
                    texts.append(text)
        if texts:
            return "\n".join(texts)
        for key in ("structuredContent", "result", "data"):
            if key in tool_result:
                return _extract_text_from_tool_result(tool_result[key])
    if isinstance(tool_result, list):
        return "\n".join(_extract_text_from_tool_result(item) for item in tool_result)
    return _json_text(tool_result)


def _schema_properties(schema: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(schema, dict):
        return {}
    properties = schema.get("properties")
    return properties if isinstance(properties, dict) else {}


def _first_matching_key(keys: Iterable[str], candidates: Iterable[str]) -> str:
    lowered = {key.lower(): key for key in keys}
    for candidate in candidates:
        if candidate.lower() in lowered:
            return lowered[candidate.lower()]
    for candidate in candidates:
        candidate_lower = candidate.lower()
        for key in keys:
            if candidate_lower in key.lower():
                return key
    return ""


def _extract_structured_payload(tool_result: Any) -> Any:
    if isinstance(tool_result, dict):
        for key in ("structuredContent", "result", "data"):
            if key in tool_result:
                return tool_result[key]
    return tool_result


def _extract_page_candidates(value: Any, bucket: Dict[str, Dict[str, str]]) -> None:
    if isinstance(value, dict):
        candidate_id = _coalesce(
            value.get("id"),
            value.get("page_id"),
            value.get("target_page_id"),
            _notion_url_to_page_id(value.get("url", "")),
        )
        candidate_url = _coalesce(value.get("url"), value.get("href"))
        candidate_title = _coalesce(
            value.get("title"),
            value.get("name"),
            value.get("page_title"),
            value.get("display_title"),
            value.get("plain_text"),
        )
        candidate_path = _coalesce(
            value.get("path"),
            value.get("breadcrumb"),
            value.get("page_path"),
            value.get("full_path"),
        )
        candidate_kind = _coalesce(value.get("object"), value.get("type"), "page")
        if candidate_id or (candidate_url and "notion" in candidate_url):
            key = candidate_id or candidate_url
            existing = bucket.get(key, {})
            bucket[key] = {
                "id": _normalize_page_id(candidate_id) or existing.get("id", ""),
                "url": candidate_url or existing.get("url", ""),
                "title": candidate_title or existing.get("title", ""),
                "path": candidate_path or existing.get("path", ""),
                "kind": candidate_kind or existing.get("kind", "page"),
            }
        for child in value.values():
            _extract_page_candidates(child, bucket)
        return

    if isinstance(value, list):
        for item in value:
            _extract_page_candidates(item, bucket)
        return

    if not isinstance(value, str):
        return

    stripped_value = value.strip()
    if stripped_value.startswith("{") or stripped_value.startswith("["):
        try:
            parsed_value = json.loads(stripped_value)
        except (TypeError, ValueError):
            parsed_value = None
        if parsed_value is not None:
            _extract_page_candidates(parsed_value, bucket)
            return

    markdown_link_pattern = re.compile(r"\[([^\]]+)\]\((https://[^\s)]+)\)")
    for title, url in markdown_link_pattern.findall(value):
        page_id = _notion_url_to_page_id(url)
        if page_id:
            bucket[page_id] = {
                "id": page_id,
                "url": url,
                "title": title.strip(),
                "path": "",
                "kind": "page",
            }

    plain_url_pattern = re.compile(r"https://(?:www\.)?notion\.so/[^\s)]+")
    for url in plain_url_pattern.findall(value):
        page_id = _notion_url_to_page_id(url)
        if page_id:
            bucket.setdefault(
                page_id,
                {
                    "id": page_id,
                    "url": url,
                    "title": "",
                    "path": "",
                    "kind": "page",
                },
            )


def _normalize_page_candidates(tool_result: Any) -> List[Dict[str, str]]:
    bucket: Dict[str, Dict[str, str]] = {}
    _extract_page_candidates(_extract_structured_payload(tool_result), bucket)
    _extract_page_candidates(_extract_text_from_tool_result(tool_result), bucket)
    pages = []
    for page in bucket.values():
        page_id = _normalize_page_id(page.get("id", ""))
        page_url = page.get("url", "")
        if not page_id and not page_url:
            continue
        pages.append(_sanitize_page_summary(page))
    pages.sort(key=lambda item: ((item["title"] or item["path"] or "untitled page").lower(), item["id"]))
    return pages


def _pick_tool(tools: List[Dict[str, Any]], preferred_names: Iterable[str]) -> Dict[str, Any]:
    name_map = {tool["name"]: tool for tool in tools if isinstance(tool, dict) and tool.get("name")}
    for name in preferred_names:
        if name in name_map:
            return name_map[name]
    lowered = {name.lower(): tool for name, tool in name_map.items()}
    for name in preferred_names:
        tool = lowered.get(name.lower())
        if tool:
            return tool
    for tool in tools:
        tool_name = str(tool.get("name", "")).lower()
        if any(name.lower() in tool_name for name in preferred_names):
            return tool
    raise NotionConnectionError(f"Required Notion MCP tool not available: {', '.join(preferred_names)}")


def _public_base_to_callback_url(public_base_url: str) -> str:
    return f"{public_base_url.rstrip('/')}/notion/oauth/callback"


async def _fetch_json(url: str) -> Dict[str, Any]:
    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
        response = await client.get(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": MCP_USER_AGENT,
            },
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise NotionConnectionError(f"Invalid JSON payload from {url}")
        return payload


def _build_metadata_candidates(base_url: str, suffix: str) -> List[str]:
    url = httpx.URL(base_url)
    origin = f"{url.scheme}://{url.host}"
    if url.port is not None:
        origin = f"{origin}:{url.port}"
    path = url.path.rstrip("/")
    candidates = [
        f"{base_url.rstrip('/')}/{suffix.lstrip('/')}",
        f"{origin}/{suffix.lstrip('/')}{path if path else ''}",
        f"{origin}/{suffix.lstrip('/')}",
    ]
    return _dedupe_strings(candidates)


async def _discover_auth_metadata(server_url: str = NOTION_MCP_URL) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    protected_resource: Optional[Dict[str, Any]] = None
    last_error: Optional[Exception] = None
    for candidate in _build_metadata_candidates(server_url, ".well-known/oauth-protected-resource"):
        try:
            protected_resource = await _fetch_json(candidate)
            break
        except Exception as exc:  # noqa: PERF203
            last_error = exc
    if protected_resource is None:
        raise NotionConnectionError(f"Failed to discover Notion protected resource metadata: {last_error}")

    auth_servers = protected_resource.get("authorization_servers") or []
    if isinstance(auth_servers, str):
        auth_servers = [auth_servers]
    auth_server = auth_servers[0] if auth_servers else ""
    if not auth_server:
        raise NotionConnectionError("Protected resource metadata did not advertise an authorization server.")

    auth_metadata: Optional[Dict[str, Any]] = None
    last_error = None
    for candidate in _dedupe_strings(
        [
            f"{auth_server.rstrip('/')}/.well-known/oauth-authorization-server",
            f"{auth_server.rstrip('/')}/.well-known/openid-configuration",
        ]
    ):
        try:
            auth_metadata = await _fetch_json(candidate)
            break
        except Exception as exc:  # noqa: PERF203
            last_error = exc
    if auth_metadata is None:
        raise NotionConnectionError(f"Failed to discover Notion authorization metadata: {last_error}")

    challenge_methods = auth_metadata.get("code_challenge_methods_supported") or []
    if challenge_methods and "S256" not in challenge_methods:
        raise NotionConnectionError("Notion authorization server does not advertise PKCE S256 support.")
    return protected_resource, auth_metadata


async def _register_public_client(auth_metadata: Dict[str, Any], redirect_uri: str) -> Dict[str, Any]:
    registration_endpoint = _coalesce(auth_metadata.get("registration_endpoint"))
    if not registration_endpoint:
        raise NotionConnectionError("Authorization metadata is missing a dynamic client registration endpoint.")

    payload = {
        "client_name": "Research Agent Util",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "application_type": "web",
    }

    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
        response = await client.post(
            registration_endpoint,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": MCP_USER_AGENT,
            },
            json=payload,
        )
        response.raise_for_status()
        registered = response.json()
        if not isinstance(registered, dict) or not registered.get("client_id"):
            raise NotionConnectionError("Client registration did not return a client_id.")
        return registered


async def start_notion_oauth(public_base_url: str, frontend_origin: str) -> Dict[str, str]:
    public_base_url = public_base_url.rstrip("/")
    frontend_origin = frontend_origin.rstrip("/")
    if not public_base_url or not frontend_origin:
        raise NotionConnectionError("Missing public_base_url or frontend_origin for Notion OAuth.")

    callback_url = _public_base_to_callback_url(public_base_url)
    protected_resource, auth_metadata = await _discover_auth_metadata(NOTION_MCP_URL)
    registration = await _register_public_client(auth_metadata, callback_url)

    code_verifier = _generate_code_verifier()
    state = secrets.token_urlsafe(32)
    scope_candidates = auth_metadata.get("scopes_supported") or []
    scope = "offline_access" if "offline_access" in scope_candidates else ""

    authorization_params = {
        "response_type": "code",
        "client_id": registration["client_id"],
        "redirect_uri": callback_url,
        "state": state,
        "code_challenge": _build_code_challenge(code_verifier),
        "code_challenge_method": "S256",
    }
    if scope:
        authorization_params["scope"] = scope

    with _OAUTH_LOCK:
        now = _utc_now()
        expired_states: List[str] = []
        for key, value in _OAUTH_SESSIONS.items():
            created_at = _parse_utc(value.get("created_at", ""))
            if created_at is None or now - created_at > AUTH_SESSION_TTL:
                expired_states.append(key)
        for expired_state in expired_states:
            _OAUTH_SESSIONS.pop(expired_state, None)

        _OAUTH_SESSIONS[state] = {
            "code_verifier": code_verifier,
            "client_id": registration["client_id"],
            "client_secret": _coalesce(registration.get("client_secret")),
            "registration_client_uri": _coalesce(registration.get("registration_client_uri")),
            "redirect_uri": callback_url,
            "token_endpoint": _coalesce(auth_metadata.get("token_endpoint")),
            "auth_server": _coalesce((protected_resource.get("authorization_servers") or [""])[0]),
            "frontend_origin": frontend_origin,
            "scope": scope,
            "created_at": _format_utc(now),
        }

    auth_url = f"{auth_metadata['authorization_endpoint']}?{urlencode(authorization_params)}"
    return {"authorization_url": auth_url, "state": state}


async def _exchange_token(
    token_endpoint: str,
    payload: Dict[str, str],
    client_id: str,
    client_secret: str,
) -> Dict[str, Any]:
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": MCP_USER_AGENT,
    }
    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
        response = await client.post(
            token_endpoint,
            headers=headers,
            data=payload,
            auth=(client_id, client_secret) if client_secret else None,
        )
        response.raise_for_status()
        token_data = response.json()
        if not isinstance(token_data, dict):
            raise NotionConnectionError("Notion token endpoint returned an unexpected payload.")
        return token_data


async def _fetch_notion_identity(connection: Dict[str, str]) -> Dict[str, str]:
    try:
        client = NotionRemoteMCPClient(connection)
        tools = await client.list_tools()
        self_tool = _pick_tool(tools, ["notion-get-self", "get-self", "self"])
        result = await client.call_tool(self_tool["name"], {})
        payload = _extract_structured_payload(result)
        identity = payload if isinstance(payload, dict) else {}
        return {
            "workspace_id": _coalesce(identity.get("workspace_id"), identity.get("workspaceId")),
            "workspace_name": _coalesce(
                identity.get("workspace_name"),
                identity.get("workspaceName"),
                identity.get("workspace"),
            ),
            "workspace_icon": _coalesce(identity.get("workspace_icon"), identity.get("workspaceIcon")),
            "bot_id": _coalesce(identity.get("bot_id"), identity.get("botId")),
            "owner_user_id": _coalesce(
                identity.get("owner_user_id"),
                identity.get("ownerUserId"),
                identity.get("user_id"),
            ),
        }
    except Exception as exc:  # noqa: PERF203
        logger.warning("Failed to fetch Notion identity after OAuth connect: %s", exc)
        return {}


async def complete_notion_oauth(state: str, code: str) -> Dict[str, Any]:
    with _OAUTH_LOCK:
        session = _OAUTH_SESSIONS.pop(state, None)
    if session is None:
        raise NotionConnectionError("Invalid or expired Notion OAuth state.")

    if not code:
        raise NotionConnectionError("Missing Notion OAuth authorization code.")

    token_data = await _exchange_token(
        session["token_endpoint"],
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": session["redirect_uri"],
            "client_id": session["client_id"],
            "code_verifier": session["code_verifier"],
        },
        session["client_id"],
        session["client_secret"],
    )

    expires_in = int(token_data.get("expires_in") or 3600)
    connection = update_notion_connection(
        {
            "server_url": NOTION_MCP_URL,
            "auth_server": session["auth_server"],
            "client_id": session["client_id"],
            "client_secret": session["client_secret"],
            "registration_client_uri": session["registration_client_uri"],
            "redirect_uri": session["redirect_uri"],
            "scope": _coalesce(token_data.get("scope"), session["scope"]),
            "access_token": _coalesce(token_data.get("access_token")),
            "refresh_token": _coalesce(token_data.get("refresh_token")),
            "token_type": _coalesce(token_data.get("token_type"), "Bearer"),
            "expires_at": _format_utc(_utc_now() + timedelta(seconds=expires_in)),
            "connected_at": _format_utc(_utc_now()),
        }
    )
    identity = await _fetch_notion_identity(connection)
    if identity:
        connection = update_notion_connection(identity)
    return {"connection": connection, "frontend_origin": session["frontend_origin"]}


def disconnect_notion() -> Dict[str, Any]:
    connection = clear_notion_connection()
    return {
        "connected": False,
        "workspace_name": connection["workspace_name"],
    }


async def _refresh_notion_connection() -> Dict[str, str]:
    async with _TOKEN_REFRESH_LOCK:
        latest = require_notion_connection()
        latest_expires_at = _parse_utc(latest["expires_at"])
        if latest_expires_at and latest_expires_at - _utc_now() > TOKEN_REFRESH_SKEW and latest["access_token"]:
            return latest

        if not latest["refresh_token"]:
            raise NotionConnectionError("Notion refresh token is missing. Reconnect the Notion account.")

        _, auth_metadata = await _discover_auth_metadata(latest["server_url"] or NOTION_MCP_URL)
        token_endpoint = _coalesce(auth_metadata.get("token_endpoint"))
        if not token_endpoint:
            raise NotionConnectionError("Notion authorization metadata is missing a token endpoint.")

        token_data = await _exchange_token(
            token_endpoint,
            {
                "grant_type": "refresh_token",
                "refresh_token": latest["refresh_token"],
                "client_id": latest["client_id"],
            },
            latest["client_id"],
            latest["client_secret"],
        )
        expires_in = int(token_data.get("expires_in") or 3600)
        refreshed = update_notion_connection(
            {
                "access_token": _coalesce(token_data.get("access_token")),
                "refresh_token": _coalesce(token_data.get("refresh_token"), latest["refresh_token"]),
                "token_type": _coalesce(token_data.get("token_type"), latest["token_type"], "Bearer"),
                "scope": _coalesce(token_data.get("scope"), latest["scope"]),
                "expires_at": _format_utc(_utc_now() + timedelta(seconds=expires_in)),
            }
        )
        return refreshed


async def get_active_notion_connection() -> Dict[str, str]:
    connection = require_notion_connection()
    expires_at = _parse_utc(connection["expires_at"])
    if connection["access_token"] and expires_at and expires_at - _utc_now() > TOKEN_REFRESH_SKEW:
        return connection
    if connection["refresh_token"]:
        return await _refresh_notion_connection()
    if connection["access_token"]:
        return connection
    raise NotionConnectionError("Notion is not connected. Reconnect the Notion account.")


def get_notion_status() -> Dict[str, Any]:
    connection = get_notion_connection()
    connected = bool(connection["access_token"] or connection["refresh_token"])
    return {
        "connected": connected,
        "server_url": connection["server_url"],
        "workspace_id": connection["workspace_id"],
        "workspace_name": connection["workspace_name"],
        "workspace_icon": connection["workspace_icon"],
        "bot_id": connection["bot_id"],
        "owner_user_id": connection["owner_user_id"],
        "connected_at": connection["connected_at"],
        "expires_at": connection["expires_at"],
    }


def render_notion_note_body(
    paper_id: str,
    paper_title: str,
    notes: List[Dict[str, Any]],
    updated_at: str = "",
) -> str:
    lines = [
        f"Paper ID: {paper_id}",
        f"Paper Title: {paper_title or paper_id}",
    ]
    if updated_at:
        lines.append(f"Updated At: {updated_at}")
    lines.extend(["", "---", ""])

    for note in notes:
        note_title = str(note.get("title") or "Untitled note").strip()
        lines.append(f"## {note_title}")
        lines.append("")
        sections = [
            ("Memo", _coalesce(note.get("memo"))),
            ("Translation", _coalesce(note.get("translation"), note.get("translate"))),
            ("Analysis", _coalesce(note.get("analysis"))),
            ("Prompt", _coalesce(note.get("prompt"), note.get("qa"))),
        ]
        for label, content in sections:
            if not content:
                continue
            lines.append(f"### {label}")
            lines.append("")
            lines.append(content)
            lines.append("")
        lines.append("")
    return "\n".join(lines).strip()


class NotionRemoteMCPClient:
    """Minimal JSON-RPC over HTTP client for the hosted Notion MCP server."""

    def __init__(self, connection: Dict[str, str]) -> None:
        self.server_url = _coalesce(connection.get("server_url"), NOTION_MCP_URL)
        self.access_token = connection.get("access_token", "")
        self.protocol_version = MCP_PROTOCOL_VERSION
        self.session_id = ""
        self._client = httpx.AsyncClient(timeout=60.0, follow_redirects=True)

    async def __aenter__(self) -> "NotionRemoteMCPClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    async def close(self) -> None:
        await self._client.aclose()

    def _headers(self) -> Dict[str, str]:
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.access_token}",
            "MCP-Protocol-Version": self.protocol_version,
            "User-Agent": MCP_USER_AGENT,
        }
        if self.session_id:
            headers["MCP-Session-Id"] = self.session_id
        return headers

    async def _parse_jsonrpc_response(self, response: httpx.Response) -> Dict[str, Any]:
        content_type = response.headers.get("Content-Type", "")
        if "text/event-stream" in content_type:
            body = await response.aread()
            data_chunks: List[str] = []
            for line in body.decode("utf-8").splitlines():
                if line.startswith("data:"):
                    data_chunks.append(line[5:].strip())
            payload_text = "\n".join(chunk for chunk in data_chunks if chunk)
            return json.loads(payload_text) if payload_text else {}

        payload = response.json()
        if not isinstance(payload, dict):
            raise NotionConnectionError("Unexpected JSON-RPC payload from Notion MCP server.")
        return payload

    async def initialize(self) -> None:
        response = await self._client.post(
            self.server_url,
            headers=self._headers(),
            json={
                "jsonrpc": "2.0",
                "id": str(uuid.uuid4()),
                "method": "initialize",
                "params": {
                    "protocolVersion": self.protocol_version,
                    "capabilities": {},
                    "clientInfo": {
                        "name": "research-agent-util",
                        "version": "1.0.0",
                    },
                },
            },
        )
        response.raise_for_status()
        self.session_id = response.headers.get("MCP-Session-Id", self.session_id)
        payload = await self._parse_jsonrpc_response(response)
        result = payload.get("result") or {}
        server_protocol = result.get("protocolVersion")
        if isinstance(server_protocol, str) and server_protocol:
            self.protocol_version = server_protocol

        await self._client.post(
            self.server_url,
            headers=self._headers(),
            json={
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
                "params": {},
            },
        )

    async def _call(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if not self.session_id:
            await self.initialize()

        response = await self._client.post(
            self.server_url,
            headers=self._headers(),
            json={
                "jsonrpc": "2.0",
                "id": str(uuid.uuid4()),
                "method": method,
                "params": params or {},
            },
        )
        response.raise_for_status()
        payload = await self._parse_jsonrpc_response(response)
        if payload.get("error"):
            message = payload["error"].get("message") if isinstance(payload["error"], dict) else payload["error"]
            raise NotionConnectionError(str(message))
        return payload.get("result") or {}

    async def list_tools(self) -> List[Dict[str, Any]]:
        result = await self._call("tools/list", {})
        tools = result.get("tools")
        return tools if isinstance(tools, list) else []

    async def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        result = await self._call(
            "tools/call",
            {
                "name": tool_name,
                "arguments": arguments,
            },
        )
        if result.get("isError"):
            raise NotionConnectionError(_extract_text_from_tool_result(result) or f"Tool call failed: {tool_name}")
        return result


def _build_search_arguments(schema: Dict[str, Any], query: str, limit: int) -> Dict[str, Any]:
    properties = _schema_properties(schema)
    keys = list(properties.keys())
    args: Dict[str, Any] = {}

    query_key = _first_matching_key(keys, ["query", "search", "q"])
    if query_key:
        args[query_key] = query

    limit_key = _first_matching_key(keys, ["limit", "page_size", "pageSize", "max_results", "maxResults", "count"])
    if limit_key:
        args[limit_key] = limit

    type_key = _first_matching_key(keys, ["types", "object_types", "objectTypes", "kind"])
    if type_key:
        if properties[type_key].get("type") == "array":
            args[type_key] = ["page"]
        else:
            args[type_key] = "page"

    return args


def _build_create_payload_candidates(
    schema: Dict[str, Any],
    parent_page_id: str,
    title: str,
    content: str,
) -> List[Dict[str, Any]]:
    properties = _schema_properties(schema)
    if properties:
        missing_keys = [key for key in ("parent", "pages") if key not in properties]
        if missing_keys:
            raise NotionConnectionError(
                f"Hosted Notion create-pages schema is missing expected fields: {', '.join(missing_keys)}"
            )

    return [
        {
            "parent": {"page_id": parent_page_id},
            "pages": [
                {
                    "properties": {"title": title},
                    "content": content,
                }
            ],
        }
    ]


def _normalize_newlines(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n")


def _append_markdown(existing_content: str, appended_content: str) -> str:
    if not existing_content.strip():
        return appended_content
    if existing_content.endswith("\n\n"):
        return f"{existing_content}{appended_content}"
    if existing_content.endswith("\n"):
        return f"{existing_content}\n{appended_content}"
    return f"{existing_content}\n\n{appended_content}"


def _build_update_payload_candidates(
    schema: Dict[str, Any],
    page_id: str,
    existing_content: str,
    appended_content: str,
) -> List[Dict[str, Any]]:
    properties = _schema_properties(schema)
    if properties:
        required_keys = [key for key in ("page_id", "command") if key not in properties]
        if required_keys:
            raise NotionConnectionError(
                f"Hosted Notion update-page schema is missing expected fields: {', '.join(required_keys)}"
            )
        if "content_updates" not in properties and "new_str" not in properties:
            raise NotionConnectionError(
                "Hosted Notion update-page schema does not support content updates."
            )

    next_content = _append_markdown(existing_content, appended_content)
    if existing_content.strip():
        return [
            {
                "page_id": page_id,
                "command": "update_content",
                "content_updates": [
                    {
                        "old_str": existing_content,
                        "new_str": next_content,
                    }
                ],
            }
        ]

    return [
        {
            "page_id": page_id,
            "command": "replace_content",
            "new_str": next_content,
        }
    ]


def _extract_first_page_evidence(tool_result: Any) -> Dict[str, str]:
    for candidate in _normalize_page_candidates(tool_result):
        if candidate.get("id") or candidate.get("url"):
            return candidate
    return {}


def _extract_matching_page_evidence(tool_result: Any, page_ref: str) -> Dict[str, str]:
    normalized_ref = _normalize_page_id(page_ref)
    normalized_url = page_ref.strip().lower()
    for candidate in _normalize_page_candidates(tool_result):
        candidate_id = _normalize_page_id(candidate.get("id", ""))
        candidate_url = candidate.get("url", "").strip().lower()
        if normalized_ref and candidate_id == normalized_ref:
            return candidate
        if normalized_url and candidate_url and candidate_url == normalized_url:
            return candidate
    return _extract_first_page_evidence(tool_result)


def _require_page_evidence(tool_result: Any, action_label: str) -> Dict[str, str]:
    page_evidence = _extract_first_page_evidence(tool_result)
    if page_evidence.get("id") or page_evidence.get("url"):
        return page_evidence
    raise NotionConnectionError(
        f"Hosted Notion {action_label} did not return a page ID or URL to confirm the save."
    )


async def _fetch_notion_page(client: NotionRemoteMCPClient, tools: List[Dict[str, Any]], page_ref: str) -> Dict[str, Any]:
    fetch_tool = _pick_tool(tools, ["notion-fetch", "fetch"])
    schema = fetch_tool.get("inputSchema") or {}
    properties = _schema_properties(schema)
    if properties and "id" not in properties:
        raise NotionConnectionError("Hosted Notion fetch schema is missing the page identifier field.")
    return await client.call_tool(fetch_tool["name"], {"id": page_ref})


def _page_needs_hydration(page: Dict[str, str]) -> bool:
    if not page.get("id") and not page.get("url"):
        return False
    title = page.get("title", "")
    return not title or _is_likely_notion_page_id(title)


async def _hydrate_page_summaries(
    client: NotionRemoteMCPClient,
    tools: List[Dict[str, Any]],
    pages: List[Dict[str, str]],
) -> List[Dict[str, str]]:
    if not pages:
        return pages

    semaphore = asyncio.Semaphore(4)

    async def hydrate(page: Dict[str, str]) -> Dict[str, str]:
        if not _page_needs_hydration(page):
            return _sanitize_page_summary(page)

        page_ref = page.get("id") or page.get("url", "")
        if not page_ref:
            return _sanitize_page_summary(page)

        try:
            async with semaphore:
                fetched_page = await _fetch_notion_page(client, tools, page_ref)
            hydrated_candidate = _extract_matching_page_evidence(fetched_page, page_ref)
            if not hydrated_candidate:
                return _sanitize_page_summary(page)
            return _sanitize_page_summary({
                **page,
                "title": hydrated_candidate.get("title", "") or page.get("title", ""),
                "path": hydrated_candidate.get("path", "") or page.get("path", ""),
                "url": hydrated_candidate.get("url", "") or page.get("url", ""),
            })
        except Exception:
            return _sanitize_page_summary(page)

    return await asyncio.gather(*(hydrate(page) for page in pages))


async def _call_first_successful_payload(
    client: NotionRemoteMCPClient,
    tool_name: str,
    payload_candidates: List[Dict[str, Any]],
) -> Dict[str, Any]:
    last_error: Optional[Exception] = None
    for payload in payload_candidates:
        try:
            return await client.call_tool(tool_name, payload)
        except Exception as exc:  # noqa: PERF203
            last_error = exc
    raise NotionConnectionError(str(last_error) if last_error else f"Failed to call Notion MCP tool {tool_name}")


async def search_notion_pages(query: str, limit: int = 20) -> Dict[str, Any]:
    connection = await get_active_notion_connection()
    async with NotionRemoteMCPClient(connection) as client:
        tools = await client.list_tools()
        search_tool = _pick_tool(tools, ["notion-search", "search"])
        raw_result = await client.call_tool(
            search_tool["name"],
            _build_search_arguments(search_tool.get("inputSchema") or {}, query, limit),
        )
        pages = await _hydrate_page_summaries(client, tools, _normalize_page_candidates(raw_result)[:limit])
        return {
            "pages": pages[:limit],
            "raw_text": _extract_text_from_tool_result(raw_result),
        }


async def list_notion_pages(limit: int = 10) -> Dict[str, Any]:
    connection = await get_active_notion_connection()
    async with NotionRemoteMCPClient(connection) as client:
        tools = await client.list_tools()
        search_tool = _pick_tool(tools, ["notion-search", "search"])
        collected_pages: List[Dict[str, str]] = []
        seen_keys = set()
        raw_texts: List[str] = []

        for starter_query in INITIAL_NOTION_PAGE_LIST_QUERIES:
            raw_result = await client.call_tool(
                search_tool["name"],
                _build_search_arguments(search_tool.get("inputSchema") or {}, starter_query, limit),
            )
            raw_text = _extract_text_from_tool_result(raw_result)
            if raw_text:
                raw_texts.append(raw_text)

            hydrated_pages = await _hydrate_page_summaries(
                client,
                tools,
                _normalize_page_candidates(raw_result)[:limit],
            )
            for page in hydrated_pages:
                key = page.get("id") or page.get("url", "")
                if not key or key in seen_keys:
                    continue
                seen_keys.add(key)
                collected_pages.append(page)
                if len(collected_pages) >= limit:
                    break
            if len(collected_pages) >= limit:
                break

        return {
            "pages": collected_pages[:limit],
            "raw_text": "\n\n".join(raw_texts),
        }


async def save_notes_to_notion(
    paper_id: str,
    paper_title: str,
    notes: List[Dict[str, Any]],
    target_page_id: str,
    destination_title: str,
    create_new_page: bool,
    updated_at: str = "",
) -> Dict[str, Any]:
    normalized_target_page_id = _normalize_page_id(target_page_id)
    if not normalized_target_page_id:
        raise NotionConnectionError("A target Notion page must be selected before saving.")

    content_body = render_notion_note_body(paper_id, paper_title, notes, updated_at)
    destination_title = destination_title.strip() or f"[{paper_id}] {paper_title or paper_id}"
    append_content = f"## {destination_title}\n\n{content_body}"

    connection = await get_active_notion_connection()
    async with NotionRemoteMCPClient(connection) as client:
        tools = await client.list_tools()

        if create_new_page:
            create_tool = _pick_tool(tools, ["notion-create-pages", "create-pages", "create-page"])
            raw_result = await _call_first_successful_payload(
                client,
                create_tool["name"],
                _build_create_payload_candidates(
                    create_tool.get("inputSchema") or {},
                    normalized_target_page_id,
                    destination_title,
                    content_body,
                ),
            )
            created_page = _require_page_evidence(raw_result, "create-pages")
            return {
                "mode": "created",
                "page_id": created_page.get("id", ""),
                "page_url": created_page.get("url", ""),
                "page_title": created_page.get("title", "") or destination_title,
                "raw_text": _extract_text_from_tool_result(raw_result),
            }

        before_fetch_result = await _fetch_notion_page(client, tools, normalized_target_page_id)
        existing_page_content = _extract_text_from_tool_result(before_fetch_result)
        update_tool = _pick_tool(tools, ["notion-update-page", "update-page"])
        raw_result = await _call_first_successful_payload(
            client,
            update_tool["name"],
            _build_update_payload_candidates(
                update_tool.get("inputSchema") or {},
                normalized_target_page_id,
                existing_page_content,
                append_content,
            ),
        )
        after_fetch_result = await _fetch_notion_page(client, tools, normalized_target_page_id)
        after_page_content = _normalize_newlines(_extract_text_from_tool_result(after_fetch_result))
        expected_fragment = _normalize_newlines(append_content)
        if expected_fragment not in after_page_content:
            raise NotionConnectionError(
                "Hosted Notion update could not be verified from the saved page content."
            )
        updated_page = _extract_first_page_evidence(after_fetch_result)
        return {
            "mode": "updated",
            "page_id": updated_page.get("id", ""),
            "page_url": updated_page.get("url", ""),
            "page_title": updated_page.get("title", "") or destination_title,
            "raw_text": _extract_text_from_tool_result(raw_result),
        }


class SaveToNotionTool(MCPTool):
    """Compatibility wrapper for the web/app save_to_notion tool name."""

    @property
    def name(self) -> str:
        return "save_to_notion"

    @property
    def description(self) -> str:
        return "Save paper notes into Notion through the official hosted Notion MCP server."

    @property
    def category(self) -> str:
        return "notion"

    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter("paper_id", "string", "The paper ID.", required=True),
            ToolParameter("paper_title", "string", "The paper title.", required=True),
            ToolParameter(
                "notes",
                "array",
                "List of note payloads: {title, memo, translation, analysis, prompt|qa}.",
                required=True,
                items_type="object",
            ),
            ToolParameter("target_page_id", "string", "Target Notion page id.", required=True),
            ToolParameter(
                "destination_title",
                "string",
                "Title to use for the destination page or inserted section.",
                required=False,
                default="",
            ),
            ToolParameter(
                "create_new_page",
                "boolean",
                "Create a new child page under target_page_id instead of writing into it directly.",
                required=False,
                default=True,
            ),
            ToolParameter("updated_at", "string", "Optional ISO timestamp.", required=False, default=""),
        ]

    async def execute(
        self,
        paper_id: str,
        paper_title: str,
        notes: List[Dict[str, Any]],
        target_page_id: str,
        destination_title: str = "",
        create_new_page: bool = True,
        updated_at: str = "",
    ) -> Any:
        try:
            return await save_notes_to_notion(
                paper_id=paper_id,
                paper_title=paper_title,
                notes=notes,
                target_page_id=target_page_id,
                destination_title=destination_title,
                create_new_page=create_new_page,
                updated_at=updated_at,
            )
        except (NotionConnectionError, httpx.HTTPError) as exc:
            raise ExecutionError(str(exc), tool_name=self.name) from exc


__all__ = [
    "NOTION_MCP_URL",
    "NotionConnectionError",
    "SaveToNotionTool",
    "complete_notion_oauth",
    "disconnect_notion",
    "get_active_notion_connection",
    "get_notion_status",
    "list_notion_pages",
    "render_notion_note_body",
    "save_notes_to_notion",
    "search_notion_pages",
    "start_notion_oauth",
]
