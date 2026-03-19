"""
Translation tools for paper-level and section-level workflows.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..base import MCPTool, ToolParameter, ExecutionError
from runtime.service_config import build_openai_client

logger = logging.getLogger("mcp.tools.translate")

OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", "/data/output"))

try:
    import openai

    HAS_OPENAI = True
except ImportError:
    openai = None  # type: ignore[assignment]
    HAS_OPENAI = False


def _build_openai_client(tool_name: str):
    try:
        return build_openai_client()
    except RuntimeError as exc:
        raise ExecutionError(str(exc), tool_name=tool_name) from exc


def _load_full_text(paper_dir: Path, tool_name: str) -> str:
    json_file = paper_dir / "extracted_text.json"
    if json_file.exists():
        try:
            data = json.loads(json_file.read_text(encoding="utf-8"))
            full_text = data.get("full_text", "")
            if full_text:
                return str(full_text)
        except (OSError, json.JSONDecodeError) as exc:
            raise ExecutionError(
                f"Failed to read extracted_text.json: {exc}",
                tool_name=tool_name,
            ) from exc

    text_file = paper_dir / "extracted_text.txt"
    if text_file.exists():
        try:
            return text_file.read_text(encoding="utf-8")
        except OSError as exc:
            raise ExecutionError(
                f"Failed to read extracted_text.txt: {exc}",
                tool_name=tool_name,
            ) from exc

    raise ExecutionError(
        f"Text file not found for paper: {paper_dir.name}",
        tool_name=tool_name,
    )


def _write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _extract_abstract_intro(text: str) -> str:
    abstract_match = re.search(
        r"(?is)^\s*(abstract|summary)\s*:?\s*\n(.*?)(?=\n\s*(1\.|introduction|keywords|index terms))",
        text,
        re.MULTILINE,
    )
    intro_match = re.search(
        r"(?is)^\s*(1\.\s*)?introduction\s*:?\s*\n(.*?)(?=\n\s*(2\.|related work|background|method|approach))",
        text,
        re.MULTILINE,
    )

    sections: List[str] = []
    if abstract_match:
        sections.append(abstract_match.group(2).strip())
    if intro_match:
        sections.append(intro_match.group(2).strip())

    joined = "\n\n".join(section for section in sections if section)
    return joined[:8000] if joined else text[:5000]


def _split_into_chunks(text: str, max_chunk_size: int = 5000) -> List[str]:
    paragraphs = [paragraph.strip() for paragraph in re.split(r"\n\s*\n", text) if paragraph.strip()]
    if not paragraphs:
        return [text[:max_chunk_size]] if text else [""]

    chunks: List[str] = []
    current = ""

    for paragraph in paragraphs:
        candidate = f"{current}\n\n{paragraph}" if current else paragraph
        if len(candidate) <= max_chunk_size:
            current = candidate
            continue

        if current:
            chunks.append(current)
            current = ""

        if len(paragraph) <= max_chunk_size:
            current = paragraph
            continue

        sentences = re.split(r"(?<=[.!?])\s+", paragraph)
        for sentence in sentences:
            sentence = sentence.strip()
            if not sentence:
                continue
            candidate = f"{current} {sentence}".strip() if current else sentence
            if len(candidate) <= max_chunk_size:
                current = candidate
            else:
                if current:
                    chunks.append(current)
                current = sentence[:max_chunk_size]

    if current:
        chunks.append(current)

    return chunks or [text[:max_chunk_size]]


def _extract_glossary(
    abstract_intro_text: str,
    source_lang: str,
    target_lang: str,
    client: Any,
) -> Dict[str, str]:
    if not abstract_intro_text.strip():
        return {}

    prompt = f"""You are a professional academic translator.
Extract 10-20 important technical terms from the text and translate them from {source_lang} to {target_lang}.
Return only a JSON object mapping source terms to translated terms."""

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": abstract_intro_text[:8000]},
            ],
            temperature=0.2,
        )
        content = (response.choices[0].message.content or "").strip()
        content = re.sub(r"^```json\s*", "", content)
        content = re.sub(r"```$", "", content).strip()
        payload = json.loads(content)
        if isinstance(payload, dict):
            return {str(k): str(v) for k, v in payload.items()}
    except Exception as exc:
        logger.warning("Glossary extraction failed: %s", exc)

    return {}


async def _translate_with_retry(
    client: Any,
    messages: List[Dict[str, str]],
    tool_name: str,
    max_retries: int = 3,
) -> str:
    for attempt in range(max_retries):
        try:
            response = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=messages,
                temperature=0.3,
            )
            return response.choices[0].message.content or ""
        except Exception as exc:
            rate_limit_error = HAS_OPENAI and isinstance(exc, openai.RateLimitError)
            timeout_error = HAS_OPENAI and isinstance(exc, openai.APITimeoutError)
            if attempt < max_retries - 1 and (rate_limit_error or timeout_error):
                time.sleep(2**attempt)
                continue
            raise ExecutionError(f"Translation failed: {exc}", tool_name=tool_name) from exc

    raise ExecutionError(
        f"Translation failed after {max_retries} retries",
        tool_name=tool_name,
    )


class TranslatePaperTool(MCPTool):
    @property
    def name(self) -> str:
        return "translate_paper"

    @property
    def description(self) -> str:
        return "Translate a paper from source language to target language with glossary support."

    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter("paper_id", "string", "Paper ID", required=True),
            ToolParameter(
                "target_language",
                "string",
                "Target language",
                required=False,
                default="Korean",
            ),
            ToolParameter(
                "source_language",
                "string",
                "Source language",
                required=False,
                default="English",
            ),
        ]

    @property
    def category(self) -> str:
        return "translation"

    async def execute(
        self,
        paper_id: str,
        target_language: str = "Korean",
        source_language: str = "English",
    ) -> Dict[str, Any]:
        if not HAS_OPENAI:
            raise ExecutionError(
                "'openai' package is not installed. Run 'pip install openai' first.",
                tool_name=self.name,
            )

        paper_dir = OUTPUT_DIR / paper_id
        full_text = _load_full_text(paper_dir, self.name)
        full_text = full_text.encode("utf-8", "replace").decode("utf-8")

        client = _build_openai_client(self.name)
        started_at = datetime.now().isoformat()
        glossary = _extract_glossary(
            _extract_abstract_intro(full_text),
            source_language,
            target_language,
            client,
        )

        glossary_path = paper_dir / "translation_glossary.json"
        _write_json(
            glossary_path,
            {
                "paper_id": paper_id,
                "source_language": source_language,
                "target_language": target_language,
                "glossary": glossary,
                "created_at": started_at,
            },
        )

        chunks = _split_into_chunks(full_text, max_chunk_size=5000)
        total_chunks = len(chunks)
        status_path = paper_dir / "translation_status.json"
        status_data: Dict[str, Any] = {
            "status": "in_progress",
            "paper_id": paper_id,
            "source_language": source_language,
            "target_language": target_language,
            "total_chunks": total_chunks,
            "completed_chunks": 0,
            "started_at": started_at,
            "completed_at": None,
            "error": None,
        }
        _write_json(status_path, status_data)

        translated_chunks: List[str] = []
        glossary_str = "\n".join(f"{term}: {translation}" for term, translation in glossary.items())

        try:
            for index, chunk in enumerate(chunks):
                prev_context = "\n\n".join(translated_chunks[-2:]) if translated_chunks else ""
                system_prompt = f"""You are a professional academic translator.
Translate the given text from {source_language} to {target_language} accurately and naturally.

CRITICAL RULES:
1. Translate accurately without paraphrasing or simplifying
2. Preserve technical terms consistently using the glossary
3. Keep citations, equations, and reference numbers unchanged
4. Do not translate text inside $...$ or $$...$$
5. Maintain the original structure"""
                user_prompt = f"""[Context]
{prev_context if prev_context else "(No previous context)"}

[Glossary]
{glossary_str if glossary_str else "(No glossary available)"}

[Text]
{chunk}"""
                translated_chunk = await _translate_with_retry(
                    client,
                    [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    tool_name=self.name,
                )
                translated_chunks.append(translated_chunk)
                status_data["completed_chunks"] = index + 1
                _write_json(status_path, status_data)
                if index < total_chunks - 1:
                    time.sleep(0.5)
        except Exception as exc:
            status_data["status"] = "failed"
            status_data["error"] = str(exc)
            status_data["completed_at"] = datetime.now().isoformat()
            _write_json(status_path, status_data)
            if isinstance(exc, ExecutionError):
                raise
            raise ExecutionError(f"Translation failed: {exc}", tool_name=self.name) from exc

        translated_text = "\n\n".join(translated_chunks)
        translated_path = paper_dir / f"translated_text_{target_language}.txt"
        translated_path.write_text(translated_text, encoding="utf-8")

        status_data["status"] = "completed"
        status_data["completed_at"] = datetime.now().isoformat()
        _write_json(status_path, status_data)

        return {
            "status": "success",
            "paper_id": paper_id,
            "translated_path": str(translated_path),
            "glossary_path": str(glossary_path),
            "total_chunks": total_chunks,
            "preview": translated_text[:200],
        }


class GetTranslationTool(MCPTool):
    @property
    def name(self) -> str:
        return "get_translation"

    @property
    def description(self) -> str:
        return "Retrieve the generated translation with status information."

    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter("paper_id", "string", "Paper ID", required=True),
            ToolParameter(
                "target_language",
                "string",
                "Target language",
                required=False,
                default="Korean",
            ),
        ]

    @property
    def category(self) -> str:
        return "translation"

    async def execute(
        self,
        paper_id: str,
        target_language: str = "Korean",
    ) -> Dict[str, Any]:
        paper_dir = OUTPUT_DIR / paper_id
        translated_path = paper_dir / f"translated_text_{target_language}.txt"
        status_path = paper_dir / "translation_status.json"

        status = "not_started"
        progress = None
        error = None

        if status_path.exists():
            try:
                status_data = json.loads(status_path.read_text(encoding="utf-8"))
                status = status_data.get("status", status)
                total_chunks = int(status_data.get("total_chunks", 0) or 0)
                completed_chunks = int(status_data.get("completed_chunks", 0) or 0)
                if total_chunks > 0:
                    progress = f"{completed_chunks}/{total_chunks} chunks"
                error = status_data.get("error")
            except (OSError, json.JSONDecodeError):
                status = "unknown"

        if translated_path.exists():
            return {
                "found": True,
                "status": status,
                "content": translated_path.read_text(encoding="utf-8"),
                "progress": progress,
                "error": error,
            }

        if status_path.exists():
            return {
                "found": False,
                "status": status,
                "content": None,
                "progress": progress,
                "error": error,
                "message": f"Translation {status}. File not yet created.",
            }

        return {
            "found": False,
            "status": "not_started",
            "content": None,
            "progress": None,
            "error": None,
            "message": "Translation not found. Run translate_paper first.",
        }


class TranslateSectionTool(MCPTool):
    @property
    def name(self) -> str:
        return "translate_section"

    @property
    def description(self) -> str:
        return "Translate a specific section of a paper."

    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter("paper_id", "string", "Paper ID", required=True),
            ToolParameter("section_title", "string", "Section title", required=True),
            ToolParameter(
                "next_section_title",
                "string",
                "Next section title",
                required=False,
                default="",
            ),
            ToolParameter(
                "start_index",
                "integer",
                "Start character index",
                required=False,
            ),
            ToolParameter(
                "end_index",
                "integer",
                "End character index",
                required=False,
            ),
            ToolParameter(
                "target_language",
                "string",
                "Target language",
                required=False,
                default="Korean",
            ),
            ToolParameter(
                "source_language",
                "string",
                "Source language",
                required=False,
                default="English",
            ),
        ]

    @property
    def category(self) -> str:
        return "translation"

    def _extract_section_from_text(
        self,
        full_text: str,
        section_title: str,
        next_section_title: str,
    ) -> str:
        start_pattern = re.compile(
            rf"(?im)^\s*(?:\d+[\.\d]*\s+)?{re.escape(section_title)}\s*$"
        )
        start_match = start_pattern.search(full_text)
        if not start_match:
            normalized_title = section_title.strip().lower()
            lines = full_text.splitlines()
            start_index = -1
            for index, line in enumerate(lines):
                candidate = re.sub(r"^\s*\d+[\.\d]*\s*", "", line.strip()).lower()
                if normalized_title and normalized_title in candidate:
                    start_index = index
                    break
            if start_index < 0:
                raise ExecutionError(
                    f"Section '{section_title}' not found in extracted text.",
                    tool_name=self.name,
                )
            remaining_lines = lines[start_index + 1 :]
            if next_section_title:
                normalized_next = next_section_title.strip().lower()
                collected: List[str] = []
                for line in remaining_lines:
                    candidate = re.sub(r"^\s*\d+[\.\d]*\s*", "", line.strip()).lower()
                    if normalized_next and normalized_next in candidate:
                        break
                    collected.append(line)
                section_text = "\n".join(collected).strip()
            else:
                section_text = "\n".join(remaining_lines).strip()
            if section_text:
                return section_text
            raise ExecutionError(
                f"No text content found for section '{section_title}'.",
                tool_name=self.name,
            )

        section_start = start_match.end()
        remaining = full_text[section_start:]
        if next_section_title:
            end_pattern = re.compile(
                rf"(?im)^\s*(?:\d+[\.\d]*\s+)?{re.escape(next_section_title)}\s*$"
            )
            end_match = end_pattern.search(remaining)
            if end_match:
                return remaining[: end_match.start()].strip()
        return remaining.strip()

    async def execute(
        self,
        paper_id: str,
        section_title: str,
        next_section_title: str = "",
        start_index: Optional[int] = None,
        end_index: Optional[int] = None,
        target_language: str = "Korean",
        source_language: str = "English",
        **kwargs: Any,
    ) -> Dict[str, Any]:
        if not HAS_OPENAI:
            raise ExecutionError(
                "'openai' package is not installed. Run 'pip install openai' first.",
                tool_name=self.name,
            )

        paper_dir = OUTPUT_DIR / paper_id
        full_text = _load_full_text(paper_dir, self.name)
        full_text = full_text.encode("utf-8", "replace").decode("utf-8")

        if start_index is not None and end_index is not None:
            section_text = full_text[start_index:end_index].strip()
            if not section_text:
                raise ExecutionError(
                    f"No text found for section '{section_title}' (indices: {start_index}-{end_index}).",
                    tool_name=self.name,
                )
        else:
            section_text = self._extract_section_from_text(
                full_text,
                section_title,
                next_section_title,
            )

        client = _build_openai_client(self.name)
        chunks = _split_into_chunks(section_text, max_chunk_size=5000)
        translated_chunks: List[str] = []

        for index, chunk in enumerate(chunks):
            prev_context = "\n\n".join(translated_chunks[-2:]) if translated_chunks else ""
            system_prompt = f"""You are a professional academic translator.
Translate the given text from {source_language} to {target_language} accurately and naturally.
Keep formulas, citations, and structure unchanged."""
            user_prompt = f"""[Context]
{prev_context if prev_context else "(No previous context)"}

[Text]
{chunk}"""
            translated_chunk = await _translate_with_retry(
                client,
                [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                tool_name=self.name,
            )
            translated_chunks.append(translated_chunk)
            if index < len(chunks) - 1:
                time.sleep(0.5)

        translated_text = "\n\n".join(translated_chunks)

        notes_dir = paper_dir / "notes"
        notes_dir.mkdir(parents=True, exist_ok=True)
        notes_file = notes_dir / "notes.json"
        notes_data: Dict[str, Any] = {"notes": [], "updated_at": None}
        if notes_file.exists():
            try:
                notes_data = json.loads(notes_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                notes_data = {"notes": [], "updated_at": None}

        notes_list = notes_data.get("notes", [])
        note_found = False
        for note in notes_list:
            if note.get("title") != section_title:
                continue
            note["content"] = translated_text
            note["translated_at"] = datetime.now().isoformat()
            note["target_language"] = target_language
            if start_index is not None and end_index is not None:
                note["sectionBoundary"] = {
                    "startIndex": start_index,
                    "endIndex": end_index,
                    "sourceFile": "json",
                }
            note_found = True
            break

        if not note_found:
            note: Dict[str, Any] = {
                "id": f"note_{int(time.time())}_{section_title[:20].replace(' ', '_')}",
                "title": section_title,
                "content": translated_text,
                "isOpen": True,
                "translated_at": datetime.now().isoformat(),
                "target_language": target_language,
            }
            if start_index is not None and end_index is not None:
                note["sectionBoundary"] = {
                    "startIndex": start_index,
                    "endIndex": end_index,
                    "sourceFile": "json",
                }
            notes_list.append(note)

        notes_data["notes"] = notes_list
        notes_data["updated_at"] = datetime.now().isoformat()
        _write_json(notes_file, notes_data)

        return {
            "status": "success",
            "paper_id": paper_id,
            "section_title": section_title,
            "target_language": target_language,
            "translated_text": translated_text,
            "saved_to": str(notes_file),
        }


class SaveNotesTool(MCPTool):
    @property
    def name(self) -> str:
        return "save_notes"

    @property
    def description(self) -> str:
        return "Save note data to the local output directory."

    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter("paper_id", "string", "Paper ID", required=True),
            ToolParameter(
                "notes",
                "array",
                "Array of note objects",
                required=True,
            ),
        ]

    @property
    def category(self) -> str:
        return "notes"

    async def execute(self, paper_id: str, notes: List[Dict[str, Any]]) -> Dict[str, Any]:
        notes_file = OUTPUT_DIR / paper_id / "notes" / "notes.json"
        _write_json(
            notes_file,
            {
                "notes": notes,
                "updated_at": datetime.now().isoformat(),
            },
        )
        return {
            "status": "success",
            "paper_id": paper_id,
            "saved_to": str(notes_file),
            "notes_count": len(notes),
        }
