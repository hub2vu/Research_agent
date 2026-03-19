import os
import logging
import json
import re
import time
from datetime import datetime
from typing import Any, Dict, List
from pathlib import Path
from openai import AsyncOpenAI

from ..base import MCPTool, ToolParameter, ExecutionError

# LLM Logging
import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from logs.llm_logger import get_logger as get_llm_logger, SummaryType
from runtime.service_config import build_async_openai_client

# PDF 라이브러리
try:
    from pypdf import PdfReader
except ImportError:
    PdfReader = None

# 로거 설정
logger = logging.getLogger("mcp.tools.page_analyzer")
logger.setLevel(logging.INFO)

# OpenAI 클라이언트
OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", "data/output"))


def _get_client() -> AsyncOpenAI:
    return build_async_openai_client()


# =============================================================================
# 헬퍼 함수: 논문 전체 텍스트 가져오기 (Long Context용)
# =============================================================================
def get_full_paper_text(paper_dir: Path) -> str:
    """JSON 파일에서 논문 전체 텍스트를 로드합니다."""
    try:
        json_path = paper_dir / "extracted_text.json"
        if json_path.exists():
            with open(json_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            if isinstance(data, dict) and "full_text" in data:
                return data["full_text"][:150000]
            if isinstance(data, dict) and "pages" in data:
                return "\n".join([p.get("text", "") for p in data["pages"]])[:150000]
            if isinstance(data, list):
                return "\n".join([p.get("text", "") for p in data])[:150000]

    except Exception as e:
        logger.warning(f"전체 텍스트 로드 실패: {e}")

    return ""  # 실패 시 빈 문자열 반환


def find_paper_directory(base_path: Path, paper_id: str) -> Path:
    target_dir = base_path / paper_id
    if target_dir.exists():
        return target_dir

    core_id = paper_id.split("arxiv.")[-1] if "arxiv." in paper_id else paper_id
    if not base_path.exists():
        return None

    for folder in base_path.iterdir():
        if folder.is_dir() and (core_id in folder.name or folder.name in paper_id):
            return folder
    return None


def get_page_text_smart(paper_dir: Path, page_num: int) -> str:
    """JSON 우선 확인 후 PDF 직접 읽기"""
    json_path = paper_dir / "extracted_text.json"

    if json_path.exists():
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            pages_list = []
            if isinstance(data, dict) and "pages" in data:
                pages_list = data["pages"]
            elif isinstance(data, list):
                pages_list = data

            for p in pages_list:
                p_num = p.get("page") or p.get("page_number")
                if str(p_num) == str(page_num):
                    return p.get("text", "") or p.get("content", "")
        except Exception:
            pass

    pdf_files = list(paper_dir.glob("*.pdf"))
    if pdf_files and PdfReader:
        try:
            reader = PdfReader(pdf_files[0])
            idx = int(page_num) - 1
            if 0 <= idx < len(reader.pages):
                return reader.pages[idx].extract_text()
        except Exception:
            pass

    return None


# =============================================================================
# 메인 함수: 페이지 해석
# =============================================================================
async def interpret_paper_page(paper_id: str, page_num: int) -> Dict[str, Any]:
    try:
        logger.info(f"🚀 [해석 요청] ID: {paper_id}, Page: {page_num}")

        base_path = OUTPUT_DIR
        paper_dir = find_paper_directory(base_path, paper_id)

        if not paper_dir:
            return {"error": f"Folder not found: {paper_id}"}

        page_text = get_page_text_smart(paper_dir, page_num)
        if not page_text:
            return {
                "page": page_num,
                "original_text": "텍스트 없음",
                "interpretation": "해당 페이지의 텍스트를 찾을 수 없습니다.",
            }

        # 🔥 전체 맥락 가져오기
        full_context = get_full_paper_text(paper_dir)

        prompt = f"""
        당신은 노련한 AI 연구원입니다. 아래 제공된 **[논문 전체 맥락]**을 참고하여, 사용자가 보고 있는 **[현재 페이지]**를 한국어로 명확하게 해설해 주세요.

        [참고: 논문 전체 맥락]
        {full_context[:10000]}... (생략)

        [분석할 현재 페이지 (Page {page_num})]
        {page_text[:4000]}

        **지침:**
        1. **단순 번역 금지**: 내용을 완전히 소화한 뒤, 당신의 언어로 풀어서 설명하세요.
        2. **전체 맥락 반영**: 이 페이지가 논문 전체 흐름에서 어떤 위치인지, 앞뒤 내용과 어떻게 연결되는지 언급하세요.
        3. **형식 유지**:
           - **💡 3줄 핵심 요약**
           - **📖 상세 해설**
           - **🧠 주요 개념/용어**
        """

        start_time = time.time()
        response = await _get_client().chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "system",
                    "content": "You are a helpful and expert research assistant.",
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.3,
        )

        latency_ms = (time.time() - start_time) * 1000
        interpretation = response.choices[0].message.content

        # Extract token usage
        token_usage = {}
        if hasattr(response, 'usage') and response.usage:
            token_usage = {
                "prompt_tokens": response.usage.prompt_tokens,
                "completion_tokens": response.usage.completion_tokens,
                "total_tokens": response.usage.total_tokens
            }

        # LLM Logging
        try:
            llm_logger = get_llm_logger()
            llm_logger.log_llm_call(
                model="gpt-4o",
                prompt=prompt[:5000],
                response=interpretation[:5000],
                tool_name="interpret_paper_page",
                temperature=0.3,
                token_usage=token_usage,
                latency_ms=latency_ms,
                paper_id=paper_id,
                metadata={"page_num": page_num, "page_text_length": len(page_text)}
            )
        except Exception as log_error:
            logger.warning(f"Failed to log page interpretation: {log_error}")

        return {
            "page": page_num,
            "original_text": (
                page_text[:200] + "..." if len(page_text) > 200 else page_text
            ),
            "interpretation": interpretation,
        }

    except Exception as e:
        logger.error(f"🔥 Server Error: {e}", exc_info=True)
        return {"error": str(e)}


# =============================================================================
# Tool: Section Analysis (전체 맥락 반영 + 텍스트 출력 유지)
# =============================================================================
class AnalyzeSectionTool(MCPTool):
    """Analyze a specific section using full paper context."""

    @property
    def name(self) -> str:
        return "analyze_section"

    @property
    def description(self) -> str:
        return "Analyze a specific section of a paper with full context awareness."

    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter(
                name="paper_id", type="string", description="Paper ID", required=True
            ),
            ToolParameter(
                name="section_title",
                type="string",
                description="Section heading",
                required=True,
            ),
            ToolParameter(
                name="next_section_title",
                type="string",
                description="Next section heading",
                required=False,
                default="",
            ),
        ]

    # 사용자님의 튼튼한 추출 로직 그대로 사용
    def _extract_section_from_text(
        self, full_text: str, section_title: str, next_section_title: str
    ) -> str:
        lines = full_text.split("\n")

        def normalize(s: str) -> str:
            return re.sub(r"\s+", " ", s).strip().lower()

        def strip_section_number(s: str) -> str:
            s = re.sub(r"^[\d]+\.[\d.]*\s*", "", s)
            s = re.sub(r"^[A-Za-z]\.[\d.]*\s*", "", s)
            s = re.sub(r"^\d+\s+", "", s)
            return s.strip()

        def normalize_for_match(s: str) -> str:
            s = normalize(s)
            s = strip_section_number(s)
            s = re.sub(r"[:\-–—]", " ", s)
            s = re.sub(r"\s+", " ", s).strip()
            return s

        def get_core_words(s: str) -> set:
            norm = normalize_for_match(s)
            return {w for w in norm.split() if len(w) > 2}

        def match_score(title: str, line: str) -> float:
            norm_title = normalize_for_match(title)
            norm_line = normalize_for_match(line)
            if norm_title == norm_line:
                return 1.0
            if norm_title in norm_line or norm_line in norm_title:
                return 0.9
            title_words = get_core_words(title)
            line_words = get_core_words(line)
            if not title_words:
                return 0.0
            overlap = len(title_words & line_words)
            return overlap / len(title_words)

        norm_target = normalize(section_title)
        norm_next = normalize(next_section_title) if next_section_title else ""

        start_idx = None
        best_score = 0.0

        for i, line in enumerate(lines):
            if len(line.strip()) < 3:
                continue
            score = match_score(section_title, line)
            if i + 1 < len(lines):
                combined = line + " " + lines[i + 1]
                combined_score = match_score(section_title, combined)
                score = max(score, combined_score)
            if score > best_score and score >= 0.5:
                best_score = score
                start_idx = i
            if score >= 0.9:
                break

        if start_idx is None:
            target_words = get_core_words(section_title)
            if target_words:
                longest_word = max(target_words, key=len)
                if len(longest_word) >= 4:
                    for i, line in enumerate(lines):
                        if longest_word in normalize(line):
                            start_idx = i
                            break

        if start_idx is None:
            logger.warning(
                f"섹션 타이틀 '{section_title}'을 찾지 못해 전체 텍스트 일부를 사용합니다."
            )
            return full_text[:4000]

        end_idx = len(lines)
        if norm_next:
            best_end_score = 0.0
            for i in range(start_idx + 1, len(lines)):
                line = lines[i]
                if len(line.strip()) < 3:
                    continue
                score = match_score(next_section_title, line)
                if i + 1 < len(lines):
                    combined = line + " " + lines[i + 1]
                    combined_score = match_score(next_section_title, combined)
                    score = max(score, combined_score)
                if score > best_end_score and score >= 0.5:
                    best_end_score = score
                    end_idx = i
                if score >= 0.9:
                    break

        section_lines = lines[start_idx + 1 : end_idx]
        section_text = "\n".join(section_lines).strip()

        if not section_text:
            return full_text[start_idx : start_idx + 4000]

        return section_text

    async def execute(
        self, paper_id: str, section_title: str, next_section_title: str = "", **kwargs
    ) -> Dict[str, Any]:
        paper_dir = OUTPUT_DIR / paper_id

        # 1. 파일 읽기
        text_file = paper_dir / "extracted_text.txt"
        full_text = ""

        if not text_file.exists():
            json_file = paper_dir / "extracted_text.json"
            if json_file.exists():
                with open(json_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    full_text = data.get("full_text", "")
        else:
            with open(text_file, "r", encoding="utf-8") as f:
                full_text = f.read()

        # Fallback
        if not full_text:
            full_text = get_full_paper_text(paper_dir)

        if isinstance(full_text, str):
            full_text = full_text.encode("utf-8", "replace").decode("utf-8")

        # 2. 섹션 텍스트 추출 (기존 추출 로직 사용)
        section_text = self._extract_section_from_text(
            full_text, section_title, next_section_title
        )

        # 3. 프롬프트 수정 (Full Context 추가)
        prompt = f"""당신은 노련한 AI 연구원으로서, 동료에게 논문 내용을 쉽게 설명해주는 역할을 맡았습니다.

아래 제공된 **[논문 전체 내용]**을 참고하여 맥락을 이해하되, 설명은 반드시 **[분석할 섹션 내용]**에 집중해서 작성해 주세요.

[참고: 논문 전체 내용]
{full_text[:10000]} 
(이 내용은 전체 흐름 이해용으로만 사용하세요.)

[분석할 섹션 내용: {section_title}]
{section_text[:8000]}

**반드시 지켜야 할 지침:**
1. **범위 제한**: 전체 내용을 요약하지 말고, 오직 위 **[분석할 섹션 내용]**에 해당하는 부분만 상세히 해설하세요.
2. **심층 해설**: 단순 번역이 아니라, 전체 맥락 속에서 이 섹션이 갖는 의미를 풀어서 설명하세요.
3. **구조화된 출력**: 결과물은 반드시 아래 형식을 따르세요. (JSON 아님, 텍스트 형식 유지)
   - **3줄 핵심 요약**: 이 섹션의 핵심을 3문장으로 요약.
   - **상세 해설**: 문단별 내용을 논리적 흐름에 따라 설명.
   - **주요 개념/용어**: 등장하는 전문 용어 풀이.
4. **톤앤매너**: 전문적이지만 이해하기 쉽게 한국어로 작성하세요.
"""

        start_time = time.time()
        response = await _get_client().chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "system",
                    "content": "You are a helpful and expert research assistant.",
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.3,
        )

        latency_ms = (time.time() - start_time) * 1000
        analysis_text = response.choices[0].message.content

        # Extract token usage
        token_usage = {}
        if hasattr(response, 'usage') and response.usage:
            token_usage = {
                "prompt_tokens": response.usage.prompt_tokens,
                "completion_tokens": response.usage.completion_tokens,
                "total_tokens": response.usage.total_tokens
            }

        # LLM Logging - Log section analysis
        try:
            llm_logger = get_llm_logger()

            llm_logger.log_summary(
                paper_id=paper_id,
                summary_type=SummaryType.SECTION_WISE,
                summary_prompt=prompt[:5000],
                summary_response=analysis_text,
                source_text_length=len(section_text),
                model="gpt-4o",
                temperature=0.3,
                metadata={
                    "section_title": section_title,
                    "next_section_title": next_section_title,
                    "full_text_context_length": len(full_text)
                }
            )

            llm_logger.log_llm_call(
                model="gpt-4o",
                prompt=prompt[:5000],
                response=analysis_text[:5000],
                tool_name="analyze_section",
                temperature=0.3,
                token_usage=token_usage,
                latency_ms=latency_ms,
                paper_id=paper_id,
                metadata={"section_title": section_title}
            )
        except Exception as log_error:
            logger.warning(f"Failed to log section analysis: {log_error}")

        # Save to file system
        notes_dir = paper_dir / "notes"
        notes_dir.mkdir(parents=True, exist_ok=True)
        notes_file = notes_dir / "notes.json"
        
        # Load existing notes if available
        notes_data = {"notes": [], "updated_at": None}
        if notes_file.exists():
            try:
                with open(notes_file, "r", encoding="utf-8") as f:
                    notes_data = json.load(f)
            except:
                pass
        
        # Find or create note for this section
        notes_list = notes_data.get("notes", [])
        note_found = False
        for note in notes_list:
            if note.get("title") == section_title:
                note["content"] = analysis_text
                note["analyzed_at"] = datetime.now().isoformat()
                note_found = True
                break
        
        if not note_found:
            notes_list.append({
                "id": f"note_{int(time.time())}_{section_title[:20].replace(' ', '_')}",
                "title": section_title,
                "content": analysis_text,
                "isOpen": True,
                "analyzed_at": datetime.now().isoformat(),
            })
        
        notes_data["notes"] = notes_list
        notes_data["updated_at"] = datetime.now().isoformat()
        
        with open(notes_file, "w", encoding="utf-8") as f:
            json.dump(notes_data, f, ensure_ascii=False, indent=2)

        return {
            "status": "success",
            "paper_id": paper_id,
            "section_title": section_title,
            "analysis_text": analysis_text,
            "saved_to": str(notes_file),
        }


# =============================================================================
# 헬퍼 함수: 초록 추출 (translate.py의 _extract_abstract_intro 패턴 재사용)
# =============================================================================
def _extract_abstract(text: str) -> str:
    """
    논문 텍스트에서 Abstract 섹션을 추출합니다.
    """
    # Abstract 섹션 찾기
    abstract_pattern = re.compile(
        r"(?i)^\s*(?:abstract|summary)\s*:?\s*\n(.*?)(?=\n\s*(?:1\.|introduction|keywords|index terms|ccs concepts|acm reference format|introduction:))",
        re.MULTILINE | re.DOTALL,
    )
    
    abstract_match = abstract_pattern.search(text)
    
    if abstract_match:
        abstract_text = abstract_match.group(1).strip()
        if len(abstract_text) > 50:  # 최소 길이 체크
            return abstract_text[:3000]  # 토큰 효율성을 위해 최대 3000자
    
    # Fallback: 텍스트 앞부분 사용
    return text[:2000]


# =============================================================================
# Tool: Paper QA (초록 컨텍스트 기반 질문 답변)
# =============================================================================
class PaperQATool(MCPTool):
    """Answer questions about a paper using abstract as context."""

    @property
    def name(self) -> str:
        return "paper_qa"

    @property
    def description(self) -> str:
        return "Answer questions about a specific paper using the abstract as primary context. Optionally includes current section context."

    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter(
                name="paper_id",
                type="string",
                description="Paper ID (folder name in output directory)",
                required=True,
            ),
            ToolParameter(
                name="question",
                type="string",
                description="User's question about the paper",
                required=True,
            ),
            ToolParameter(
                name="section_context",
                type="string",
                description="Optional: current section text the user is viewing",
                required=False,
                default="",
            ),
        ]

    @property
    def category(self) -> str:
        return "analysis"

    async def execute(
        self, paper_id: str, question: str, section_context: str = "", **kwargs
    ) -> Dict[str, Any]:
        # 1. 논문 디렉토리 찾기
        paper_dir = find_paper_directory(OUTPUT_DIR, paper_id)
        if not paper_dir:
            paper_dir = OUTPUT_DIR / paper_id
        
        # 2. 전체 텍스트 로드
        full_text = get_full_paper_text(paper_dir)
        if not full_text:
            # Fallback: txt 파일 시도
            text_file = paper_dir / "extracted_text.txt"
            if text_file.exists():
                with open(text_file, "r", encoding="utf-8") as f:
                    full_text = f.read()
        
        if not full_text:
            return {
                "status": "error",
                "error": f"논문 텍스트를 찾을 수 없습니다: {paper_id}. 먼저 extract_all을 실행하세요.",
            }
        
        # 3. 초록 추출
        abstract = _extract_abstract(full_text)
        
        # 4. 프롬프트 구성
        section_part = ""
        if section_context and section_context.strip():
            section_part = f"""
[현재 보고 있는 섹션]
{section_context[:3000]}
"""
        
        prompt = f"""당신은 이 논문을 읽은 AI 연구 동료입니다. 아래 논문 정보를 바탕으로 질문에 답변하세요.

[논문 초록]
{abstract}
{section_part}
[질문]
{question}

**지침:**
1. 논문 내용을 바탕으로 정확하게 답변하세요.
2. 논문에 없는 내용은 추측하지 말고, "논문에서 직접 언급되지 않았습니다"라고 답하세요.
3. 한국어로 명확하고 이해하기 쉽게 답변하세요.
4. 필요시 논문의 맥락을 설명해주세요.
"""

        # 5. LLM 호출
        start_time = time.time()
        response = await _get_client().chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "system",
                    "content": "You are a helpful research assistant who has read the paper thoroughly.",
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.3,
        )

        latency_ms = (time.time() - start_time) * 1000
        answer = response.choices[0].message.content

        # Extract token usage
        token_usage = {}
        if hasattr(response, 'usage') and response.usage:
            token_usage = {
                "prompt_tokens": response.usage.prompt_tokens,
                "completion_tokens": response.usage.completion_tokens,
                "total_tokens": response.usage.total_tokens
            }

        # LLM Logging - Log QA interaction
        try:
            llm_logger = get_llm_logger()
            llm_logger.log_llm_call(
                model="gpt-4o",
                prompt=prompt[:5000],
                response=answer[:5000],
                tool_name="paper_qa",
                temperature=0.3,
                token_usage=token_usage,
                latency_ms=latency_ms,
                paper_id=paper_id,
                metadata={
                    "question": question,
                    "has_section_context": bool(section_context),
                    "abstract_length": len(abstract)
                }
            )
        except Exception as log_error:
            logger.warning(f"Failed to log paper QA: {log_error}")

        return {
            "status": "success",
            "paper_id": paper_id,
            "question": question,
            "answer": answer,
            "context_used": {
                "abstract_length": len(abstract),
                "section_context_provided": bool(section_context),
            },
        }
