"""
Research Agent Tool

LLM-Orchestrated Research Agent that dynamically decides analysis steps.
Uses existing tools (generate_report, extract_paper_sections, analyze_section)
and makes intelligent decisions based on paper content.
"""

import json
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from openai import AsyncOpenAI

from ..base import MCPTool, ToolParameter, ExecutionError
from ..registry import execute_tool
from .arxiv import convert_arxiv_to_paper_input
from .page_analyzer import get_full_paper_text, _extract_abstract

# LLM Logging
import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from logs.llm_logger import get_logger as get_llm_logger, SummaryType
from runtime.service_config import (
    build_async_openai_client,
    get_discord_webhook_full,
    get_discord_webhook_summary,
)

logger = logging.getLogger("mcp.tools.research_agent")
logger.setLevel(logging.INFO)

# Paths
OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", "data/output"))
PDF_DIR = Path(os.getenv("PDF_DIR", "data/pdf"))
STATUS_DIR = OUTPUT_DIR / "agent_status"
STATUS_DIR.mkdir(parents=True, exist_ok=True)


def _get_fallback_sections(sections: List[Dict], count: int = 2) -> List[str]:
    """Get fallback sections (non-intro sections)."""
    return [
        s.get("title") for s in sections
        if s.get("title") and "introduction" not in s.get("title", "").lower()
    ][:count]


# =============================================================================
# Data Classes
# =============================================================================

@dataclass
class ReasoningEntry:
    """A single reasoning/decision entry by the agent."""
    timestamp: str
    paper_id: str
    context: str          # What the agent observed
    decision: str         # What the agent decided
    rationale: str        # Why the agent made this decision
    action_taken: str     # The tool/action executed


@dataclass
class PaperAnalysisResult:
    """Analysis results for a single paper."""
    paper_id: str
    title: str
    summary_report: str                      # From generate_report
    selected_sections: List[str]             # Sections chosen by LLM
    section_analyses: Dict[str, str]         # section_title -> analysis
    selection_reasoning: str                 # Why these sections were chosen


@dataclass
class AgentState:
    """State management for the research agent."""
    job_id: str
    goal: str
    papers: List[str]
    analysis_mode: str = "quick"             # quick, standard, deep
    status: str = "running"                   # running, completed, failed
    current_paper_idx: int = 0
    current_step: str = ""                    # Current step description
    progress_percent: float = 0.0             # 0-100
    paper_results: List[PaperAnalysisResult] = field(default_factory=list)
    reasoning_log: List[ReasoningEntry] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""
    
    def __post_init__(self):
        if not self.created_at:
            self.created_at = datetime.now().isoformat()
        self.updated_at = datetime.now().isoformat()
    
    def log_reasoning(
        self,
        paper_id: str,
        context: str,
        decision: str,
        rationale: str,
        action_taken: str
    ):
        """Add a reasoning entry to the log."""
        entry = ReasoningEntry(
            timestamp=datetime.now().isoformat(),
            paper_id=paper_id,
            context=context,
            decision=decision,
            rationale=rationale,
            action_taken=action_taken
        )
        self.reasoning_log.append(entry)
        logger.info(f"[Agent Decision] {paper_id}: {decision}")
    
    def update_progress(self, step: str, percent: float):
        """Update progress and save state."""
        self.current_step = step
        self.progress_percent = percent
        self.updated_at = datetime.now().isoformat()
        self._save_state()
    
    def _save_state(self):
        """Save current state to JSON file."""
        try:
            state_file = STATUS_DIR / f"{self.job_id}.json"
            state_dict = {
                "job_id": self.job_id,
                "goal": self.goal,
                "papers": self.papers,
                "analysis_mode": self.analysis_mode,
                "status": self.status,
                "current_paper_idx": self.current_paper_idx,
                "current_step": self.current_step,
                "progress_percent": self.progress_percent,
                "paper_results_count": len(self.paper_results),
                "reasoning_log_count": len(self.reasoning_log),
                "errors": self.errors,
                "created_at": self.created_at,
                "updated_at": self.updated_at,
            }
            with open(state_file, "w", encoding="utf-8") as f:
                json.dump(state_dict, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.warning(f"Failed to save state: {e}")
    
    def mark_completed(self):
        """Mark job as completed and save state."""
        self.status = "completed"
        self.progress_percent = 100.0
        self.updated_at = datetime.now().isoformat()
        self._save_state()
    
    def mark_failed(self, error: str):
        """Mark job as failed and save state."""
        self.status = "failed"
        self.errors.append(error)
        self.updated_at = datetime.now().isoformat()
        self._save_state()


# =============================================================================
# LLM Orchestrator
# =============================================================================

class LLMOrchestrator:
    """Handles LLM-based decision making for the agent."""

    @staticmethod
    def _get_client() -> AsyncOpenAI:
        return build_async_openai_client()
    
    @staticmethod
    async def extract_abstract(paper_id: str) -> str:
        """
        Extract abstract from paper text.
        Uses page_analyzer's _extract_abstract logic.
        
        Args:
            paper_id: Paper ID (folder name in output directory)
            
        Returns:
            Abstract text (max 3000 chars)
        """
        try:
            paper_dir = OUTPUT_DIR / paper_id
            full_text = get_full_paper_text(paper_dir)
            
            if not full_text:
                # Fallback: try extracted_text.txt
                text_file = paper_dir / "extracted_text.txt"
                if text_file.exists():
                    with open(text_file, "r", encoding="utf-8") as f:
                        full_text = f.read()
            
            if full_text:
                abstract = _extract_abstract(full_text)
                return abstract
            
            logger.warning(f"Could not extract abstract for {paper_id}, returning empty string")
            return ""
        except Exception as e:
            logger.error(f"Abstract extraction failed for {paper_id}: {e}")
            return ""

    @staticmethod
    async def determine_analysis_strategy(
        summary_report: str,
        sections: List[Dict],
        goal: str,
        mode: str = "quick"
    ) -> Dict[str, Any]:
        """
        Determine analysis strategy based on summary + sections + goal.
        
        Args:
            summary_report: The generated summary from generate_report (contains key information)
            sections: List of sections from extract_paper_sections
            goal: User's analysis goal
            mode: Analysis depth mode (quick/standard/deep)
            
        Returns:
            Dict with 'strategy', 'strategy_reasoning', 'target_sections', 
            'focus_areas', 'analysis_questions', 'analysis_depth'
        """
        sections_list = "\n".join([
            f"- {s.get('title', 'Unknown')} (Level {s.get('level', 1)}, Page {s.get('page', '?')})"
            for s in sections
        ])
        
        prompt = f"""당신은 논문 분석 전략을 수립하는 AI 연구원입니다.

## 사용자 목표
{goal}

## 논문 정보
### 종합 요약 보고서
{summary_report[:4000]}

### 목차 (Table of Contents)
{sections_list}

## 분석 모드
{mode} (quick=2 sections, standard=3-4 sections, deep=5+ sections)

## 당신의 임무
이 논문의 특성과 사용자 목표를 종합해서 **최적의 분석 전략**을 수립하세요.

### 분석 전략 유형
1. **experiment_focused**: 실험 결과 중심 (표, 그래프, 메트릭 비교)
2. **methodology_focused**: 방법론/알고리즘 중심 (알고리즘 흐름, 핵심 수식)
3. **formula_heavy**: 수식/이론 중심 (수식 설명, 증명)
4. **implementation_focused**: 구현 세부사항 중심 (코드, 실용적 팁)
5. **comparison_focused**: 관련 연구 비교 중심 (Related Work 심층 분석)

### 판단 기준
- 요약 보고서에서 논문의 핵심이 무엇인지 파악
- 목차 구조를 보고 논문의 성격 파악 (실험 논문인지, 이론 논문인지)
- 사용자 목표에 맞는 전략 선택
- 분석 모드에 맞는 섹션 수 선택

## 응답 형식 (JSON)
{{
    "strategy": "experiment_focused",
    "strategy_reasoning": "이 논문은 실험 결과가 핵심이므로...",
    "target_sections": ["Experiments", "Results"],
    "focus_areas": {{
        "Experiments": ["Table 1: Main results", "Figure 3: Ablation study", "Ablation studies subsection"],
        "Results": ["Comparison with baselines", "Statistical significance"]
    }},
    "analysis_questions": [
        "핵심 실험 결과는 무엇인가?",
        "베이스라인 대비 성능 향상은?",
        "가장 중요한 ablation 결과는?"
    ],
    "analysis_depth": "deep"
}}

**중요**: 
- target_sections는 목차에 있는 섹션 이름과 정확히 일치해야 합니다.
- focus_areas는 각 섹션 내에서 집중할 구체적인 부분입니다 (표, 그림, 서브섹션 등).
- analysis_questions는 사용자 목표와 논문 특성에 맞는 구체적인 질문들을 생성하세요.
- analysis_depth는 논문 복잡도와 모드를 고려해서 결정하세요.

Respond ONLY with valid JSON, no additional text."""
        
        start_time = time.time()
        try:
            response = await LLMOrchestrator._get_client().chat.completions.create(
                model="gpt-4o",
                messages=[
                    {
                        "role": "system",
                        "content": "You are an expert research strategist. Always respond with valid JSON only."
                    },
                    {"role": "user", "content": prompt}
                ],
                temperature=0.3,
                response_format={"type": "json_object"}
            )

            latency_ms = (time.time() - start_time) * 1000
            result_text = response.choices[0].message.content
            result = json.loads(result_text)

            # Extract token usage
            token_usage = {}
            if hasattr(response, 'usage') and response.usage:
                token_usage = {
                    "prompt_tokens": response.usage.prompt_tokens,
                    "completion_tokens": response.usage.completion_tokens,
                    "total_tokens": response.usage.total_tokens
                }

            # Validate response structure
            if "strategy" not in result:
                result["strategy"] = "methodology_focused"
            if "strategy_reasoning" not in result:
                result["strategy_reasoning"] = "No reasoning provided"
            if "target_sections" not in result:
                result["target_sections"] = _get_fallback_sections(sections, 2)
            if "focus_areas" not in result:
                result["focus_areas"] = {}
            if "analysis_questions" not in result:
                result["analysis_questions"] = []
            if "analysis_depth" not in result:
                result["analysis_depth"] = mode

            # LLM Logging - Log the strategy decision
            try:
                llm_logger = get_llm_logger()

                # Log the LLM call
                llm_logger.log_llm_call(
                    model="gpt-4o",
                    prompt=prompt[:8000],
                    response=result_text[:5000],
                    tool_name="determine_analysis_strategy",
                    temperature=0.3,
                    token_usage=token_usage,
                    latency_ms=latency_ms,
                    metadata={"goal": goal, "mode": mode}
                )

                # Log the decision
                llm_logger.log_decision(
                    decision_id=f"strategy_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
                    decision="Analysis strategy determination",
                    options=["experiment_focused", "methodology_focused", "formula_heavy", "implementation_focused", "comparison_focused"],
                    chosen=result.get("strategy", "methodology_focused"),
                    rationale=result.get("strategy_reasoning", "")[:1000],
                    agent_name="LLMOrchestrator",
                    context=f"Goal: {goal}, Mode: {mode}, Sections: {len(sections)}",
                    evidence_links=result.get("target_sections", []),
                    metadata={
                        "focus_areas": result.get("focus_areas", {}),
                        "analysis_questions": result.get("analysis_questions", [])
                    }
                )
            except Exception as log_error:
                logger.warning(f"Failed to log strategy determination: {log_error}")

            return result

        except Exception as e:
            logger.error(f"Strategy determination failed: {e}")
            return {
                "strategy": "methodology_focused",
                "strategy_reasoning": f"Fallback due to error: {str(e)}",
                "target_sections": _get_fallback_sections(sections, 2),
                "focus_areas": {},
                "analysis_questions": [],
                "analysis_depth": mode
            }

    @staticmethod
    async def generate_executive_summary(
        paper_results: List[PaperAnalysisResult],
        goal: str
    ) -> str:
        """Generate an executive summary across all analyzed papers."""
        
        papers_info = "\n\n".join([
            f"### {r.title}\n{r.summary_report[:2000]}..."
            for r in paper_results
        ])
        
        prompt = f"""You are a Research Agent. Generate a concise executive summary
that synthesizes the key insights from all analyzed papers.

## User's Goal
{goal}

## Papers Analyzed
{papers_info}

## Instructions
1. Provide a 3-5 sentence summary highlighting the most important findings
2. Focus on insights relevant to the user's goal
3. Note any connections or contrasts between the papers
4. Write in Korean

## Response Format
Write the executive summary directly, no JSON needed.
"""

        start_time = time.time()
        try:
            response = await LLMOrchestrator._get_client().chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3
            )

            latency_ms = (time.time() - start_time) * 1000
            summary_content = response.choices[0].message.content

            # Extract token usage
            token_usage = {}
            if hasattr(response, 'usage') and response.usage:
                token_usage = {
                    "prompt_tokens": response.usage.prompt_tokens,
                    "completion_tokens": response.usage.completion_tokens,
                    "total_tokens": response.usage.total_tokens
                }

            # LLM Logging - Log the executive summary generation
            try:
                llm_logger = get_llm_logger()

                llm_logger.log_summary(
                    paper_id="multi_paper_executive",
                    summary_type=SummaryType.EXECUTIVE,
                    summary_prompt=prompt[:5000],
                    summary_response=summary_content,
                    source_text_length=len(papers_info),
                    model="gpt-4o",
                    temperature=0.3,
                    metadata={
                        "goal": goal,
                        "papers_count": len(paper_results),
                        "paper_titles": [r.title for r in paper_results]
                    }
                )

                llm_logger.log_llm_call(
                    model="gpt-4o",
                    prompt=prompt[:5000],
                    response=summary_content[:5000],
                    tool_name="generate_executive_summary",
                    temperature=0.3,
                    token_usage=token_usage,
                    latency_ms=latency_ms
                )
            except Exception as log_error:
                logger.warning(f"Failed to log executive summary: {log_error}")

            return summary_content
        except Exception as e:
            logger.error(f"Executive summary generation failed: {e}")
            return f"분석된 논문 {len(paper_results)}편에 대한 요약 (자동 생성 실패)"


# =============================================================================
# Final Report Generator
# =============================================================================

class FinalReportGenerator:
    """Generates the final analysis report including agent reasoning."""
    
    @staticmethod
    def generate(
        state: AgentState,
        executive_summary: str
    ) -> str:
        """
        Generate the complete final report.
        
        Includes:
        - Executive summary
        - Per-paper summary reports
        - Per-paper deep analyses
        - Agent decision log
        """
        report_parts = []
        
        # Header
        report_parts.append("# 📚 Research Analysis Report")
        report_parts.append(f"\n생성 일시: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
        report_parts.append(f"\n분석 목표: {state.goal}")
        report_parts.append(f"\n분석 모드: {state.analysis_mode}")
        report_parts.append(f"\n분석 논문 수: {len(state.paper_results)}")
        
        # Executive Summary
        report_parts.append("\n\n---\n")
        report_parts.append("## 📋 Executive Summary")
        report_parts.append(f"\n{executive_summary}")
        
        # Per-paper sections
        for i, result in enumerate(state.paper_results, 1):
            report_parts.append(f"\n\n---\n")
            report_parts.append(f"## 📄 Paper {i}: {result.title}")
            
            # Summary Report
            report_parts.append("\n### 1. 종합 요약 보고서")
            report_parts.append(f"\n{result.summary_report}")
            
            # Deep Analysis
            report_parts.append("\n### 2. 심층 분석")
            
            # Strategy and section selection reasoning
            report_parts.append("\n#### 🤖 Agent의 분석 전략 및 섹션 선택 근거")
            report_parts.append(f"\n{result.selection_reasoning}")
            report_parts.append(f"\n\n**선택된 섹션**: {', '.join(result.selected_sections)}")
            
            # Section analyses
            for section_title, analysis in result.section_analyses.items():
                report_parts.append(f"\n\n#### 📖 {section_title}")
                report_parts.append(f"\n{analysis}")
        
        # Agent Decision Log
        report_parts.append("\n\n---\n")
        report_parts.append("## 🧠 Agent Decision Log")
        report_parts.append("\n이 리포트는 AI Agent가 다음과 같은 판단 과정을 거쳐 생성되었습니다:\n")
        
        report_parts.append("\n| 시간 | 논문 | 결정 | 근거 |")
        report_parts.append("\n|------|------|------|------|")
        
        for entry in state.reasoning_log:
            time_short = entry.timestamp.split("T")[1][:8] if "T" in entry.timestamp else entry.timestamp
            decision_short = entry.decision[:50] + "..." if len(entry.decision) > 50 else entry.decision
            rationale_short = entry.rationale[:80] + "..." if len(entry.rationale) > 80 else entry.rationale
            report_parts.append(f"\n| {time_short} | {entry.paper_id[:15]} | {decision_short} | {rationale_short} |")
        
        # Errors if any
        if state.errors:
            report_parts.append("\n\n---\n")
            report_parts.append("## ⚠️ 처리 중 발생한 오류")
            for err in state.errors:
                report_parts.append(f"\n- {err}")
        
        # Footer
        report_parts.append("\n\n---\n")
        report_parts.append("\n*이 리포트는 LLM-Orchestrated Research Agent에 의해 자동 생성되었습니다.*")
        
        return "".join(report_parts)


# =============================================================================
# Main Research Agent Tool
# =============================================================================

class ResearchAgentTool(MCPTool):
    """
    LLM-Orchestrated Research Agent.
    
    Analyzes papers by:
    1. Generating summary reports (generate_report)
    2. Using LLM to select key sections based on summaries
    3. Performing deep analysis on selected sections (analyze_section)
    4. Compiling everything into a comprehensive report with reasoning
    """
    
    @property
    def name(self) -> str:
        return "run_research_agent"
    
    @property
    def description(self) -> str:
        return (
            "LLM-orchestrated research agent that analyzes papers intelligently. "
            "First generates summary reports, then uses LLM to select key sections, "
            "and performs deep analysis. Includes agent reasoning in the final report."
        )
    
    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter(
                name="paper_ids",
                type="array",
                items_type="string",
                description="List of paper IDs to analyze (max 3)",
                required=True
            ),
            ToolParameter(
                name="goal",
                type="string",
                description="User's analysis goal (e.g., 'understand the methodology', 'implementation details')",
                required=False,
                default="general understanding"
            ),
            ToolParameter(
                name="analysis_mode",
                type="string",
                description="Analysis depth: 'quick' (2 sections), 'standard' (3-4), 'deep' (5+)",
                required=False,
                default="quick"
            ),
            ToolParameter(
                name="discord_webhook_full",
                type="string",
                description="Discord webhook URL for full report channel (optional)",
                required=False,
                default=""
            ),
            ToolParameter(
                name="discord_webhook_summary",
                type="string",
                description="Discord webhook URL for summary notification channel (optional)",
                required=False,
                default=""
            ),
            ToolParameter(
                name="source",
                type="string",
                description="Paper source: 'arxiv', 'neurips', 'local'",
                required=False,
                default="local"
            )
        ]
    
    @property
    def category(self) -> str:
        return "agent"
    
    async def execute(
        self,
        paper_ids: List[str],
        goal: str = "general understanding",
        analysis_mode: str = "quick",
        discord_webhook_full: str = "",
        discord_webhook_summary: str = "",
        source: str = "local",
        job_id: Optional[str] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """Execute the research agent pipeline."""
        
        # Generate job ID if not provided
        if not job_id:
            job_id = f"job_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
        
        # Limit papers to 3
        paper_ids = paper_ids[:3]
        
        # If webhook not provided by UI, fall back to locally stored settings
        discord_webhook_full = (discord_webhook_full or "").strip() or get_discord_webhook_full()
        discord_webhook_summary = (discord_webhook_summary or "").strip() or get_discord_webhook_summary()

        # Initialize state
        state = AgentState(
            job_id=job_id,
            goal=goal,
            papers=paper_ids,
            analysis_mode=analysis_mode
        )
        state.update_progress("Initializing...", 0.0)
        
        logger.info(f"[Research Agent] Starting analysis of {len(paper_ids)} papers (Job ID: {job_id})")
        logger.info(f"[Research Agent] Goal: {goal}, Mode: {analysis_mode}")
        
        # Process each paper
        total_papers = len(paper_ids)
        for idx, paper_id in enumerate(paper_ids):
            state.current_paper_idx = idx
            progress = (idx / total_papers) * 60  # 0-60% for paper processing
            state.update_progress(f"Processing paper {idx + 1}/{total_papers}: {paper_id}", progress)
            logger.info(f"[Research Agent] Processing paper {idx + 1}/{total_papers}: {paper_id}")
            
            try:
                result = await self._process_single_paper(paper_id, state)
                state.paper_results.append(result)
            except Exception as e:
                error_msg = f"Paper {paper_id} 처리 중 오류: {str(e)}"
                state.errors.append(error_msg)
                logger.error(error_msg)
        
        # Generate executive summary
        state.update_progress("Generating executive summary...", 70.0)
        executive_summary = ""
        if state.paper_results:
            executive_summary = await LLMOrchestrator.generate_executive_summary(
                state.paper_results,
                goal
            )
        
        # Generate final report
        state.update_progress("Generating final report...", 80.0)
        final_report = FinalReportGenerator.generate(state, executive_summary)
        
        # Save report
        report_path = OUTPUT_DIR / "agent_reports"
        report_path.mkdir(parents=True, exist_ok=True)
        report_filename = f"research_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
        report_file = report_path / report_filename
        
        with open(report_file, "w", encoding="utf-8") as f:
            f.write(final_report)

        logger.info(f"[Research Agent] Report saved to {report_file}")

        # LLM Logging - Log the artifact generation
        try:
            llm_logger = get_llm_logger()
            llm_logger.log_artifact(
                artifact_type="research_report_md",
                file_path=str(report_file),
                generation_method="llm_orchestrated",
                input_sources=[
                    {"type": "paper_results", "count": len(state.paper_results)},
                    {"type": "executive_summary", "length": len(executive_summary)},
                    {"type": "reasoning_log", "count": len(state.reasoning_log)}
                ],
                paper_id=",".join(paper_ids[:3]),
                metadata={
                    "job_id": job_id,
                    "goal": goal,
                    "analysis_mode": analysis_mode,
                    "paper_count": len(state.paper_results)
                }
            )
        except Exception as log_error:
            logger.warning(f"Failed to log artifact: {log_error}")
        
        # Send notifications to Discord
        state.update_progress("Sending notifications...", 90.0)
        notification_results = {}
        
        # Send full report to Discord (regular message)
        if discord_webhook_full:
            try:
                # Add header to full report
                report_with_header = f"📚 **Research Analysis Report**\n\n"
                report_with_header += f"**Goal:** {goal}\n"
                report_with_header += f"**Papers Analyzed:** {len(state.paper_results)}\n"
                report_with_header += f"**Analysis Mode:** {analysis_mode}\n"
                report_with_header += f"**Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n"
                report_with_header += "---\n\n"
                report_with_header += final_report
                
                # Send full report (Discord supports markdown!)
                discord_full_result = await execute_tool(
                    "send_discord_notification",
                    webhook_url=discord_webhook_full,
                    message=report_with_header
                )
                notification_results["discord_full"] = discord_full_result
            except Exception as e:
                notification_results["discord_full"] = {"success": False, "error": str(e)}
        
        # Send summary to Discord channel (regular message)
        if discord_webhook_summary:
            try:
                discord_summary = f"📚 **Research Report Generated**\n\n"
                discord_summary += f"**Goal:** {goal}\n"
                discord_summary += f"**Papers:** {len(state.paper_results)}\n"
                discord_summary += f"**Analysis Mode:** {analysis_mode}\n"
                discord_summary += f"**Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n"
                discord_summary += f"**Executive Summary:**\n{executive_summary}"
                
                discord_summary_result = await execute_tool(
                    "send_discord_notification",
                    webhook_url=discord_webhook_summary,
                    message=discord_summary
                )
                notification_results["discord_summary"] = discord_summary_result
            except Exception as e:
                notification_results["discord_summary"] = {"success": False, "error": str(e)}
        
        # Mark as completed
        state.mark_completed()
        
        return {
            "success": True,
            "job_id": job_id,
            "papers_analyzed": len(state.paper_results),
            "report_path": str(report_file),
            "executive_summary": executive_summary,
            "reasoning_log_count": len(state.reasoning_log),
            "notifications": notification_results,
            "errors": state.errors if state.errors else None
        }
    
    async def _process_single_paper(
        self,
        paper_id: str,
        state: AgentState
    ) -> PaperAnalysisResult:
        """Process a single paper through the agent pipeline."""
        
        # Clean up paper_id (remove .pdf extension if present)
        clean_paper_id = paper_id.replace(".pdf", "")
        
        # Phase 1: Check if extraction exists, if not extract
        text_path = OUTPUT_DIR / clean_paper_id / "extracted_text.json"
        if not text_path.exists():
            logger.info(f"[Agent] Extracting text from {paper_id}")
            
            # Try to find PDF
            pdf_filename = f"{paper_id}" if paper_id.endswith(".pdf") else f"{paper_id}.pdf"
            
            extract_result = await execute_tool("extract_all", filename=pdf_filename)
            
            if not extract_result.get("success"):
                raise ExecutionError(
                    f"Text extraction failed: {extract_result.get('error')}",
                    tool_name=self.name
                )
            
            state.log_reasoning(
                paper_id=clean_paper_id,
                context="PDF 파일 발견",
                decision="텍스트 추출 실행",
                rationale="분석을 위해 PDF에서 텍스트를 먼저 추출해야 함",
                action_taken="extract_all"
            )
        
        # Phase 2: Generate summary report
        logger.info(f"[Agent] Generating summary report for {clean_paper_id}")
        
        report_result = await execute_tool("generate_report", paper_id=clean_paper_id)
        
        if not report_result.get("success"):
            raise ExecutionError(
                f"Report generation failed: {report_result.get('error')}",
                tool_name=self.name
            )
        
        summary_report = report_result.get("result", {}).get("content", "")
        
        state.log_reasoning(
            paper_id=clean_paper_id,
            context="텍스트 추출 완료",
            decision="종합 요약 보고서 생성",
            rationale="논문의 전체 구조와 핵심 기여를 파악하기 위해 먼저 요약 생성",
            action_taken="generate_report"
        )
        
        # Extract title from summary (first line usually contains title)
        title_match = re.search(r"(?:제목|Title)[:\s]*(.+?)(?:\n|$)", summary_report, re.IGNORECASE)
        paper_title = title_match.group(1).strip() if title_match else clean_paper_id
        
        # Phase 3: Extract sections (table of contents)
        logger.info(f"[Agent] Extracting sections for {clean_paper_id}")
        
        sections_result = await execute_tool("extract_paper_sections", paper_id=clean_paper_id)
        
        sections = []
        if sections_result.get("success"):
            sections = sections_result.get("result", {}).get("sections", [])
        
        if not sections:
            # Fallback: create generic sections
            sections = [
                {"title": "Abstract", "level": 1, "page": 1},
                {"title": "Introduction", "level": 1, "page": 1},
                {"title": "Method", "level": 1, "page": 3},
                {"title": "Experiments", "level": 1, "page": 6},
                {"title": "Conclusion", "level": 1, "page": 10}
            ]
        
        # Phase 4: Determine analysis strategy
        logger.info(f"[Agent] Determining analysis strategy for {clean_paper_id}")
        
        strategy = await LLMOrchestrator.determine_analysis_strategy(
            summary_report=summary_report,
            sections=sections,
            goal=state.goal,
            mode=state.analysis_mode
        )
        
        target_sections = strategy.get("target_sections", [])
        strategy_reasoning = strategy.get("strategy_reasoning", "")
        strategy_type = strategy.get("strategy", "methodology_focused")
        
        state.log_reasoning(
            paper_id=clean_paper_id,
            context=f"요약 + 초록 + 목차({len(sections)}개 섹션) 종합 분석",
            decision=f"분석 전략 결정: {strategy_type}",
            rationale=strategy_reasoning,
            action_taken="determine_analysis_strategy"
        )
        
        # Phase 5: Analyze with strategy
        section_analyses = {}
        focus_areas = strategy.get("focus_areas", {})
        analysis_questions = strategy.get("analysis_questions", [])
        
        for section_title in target_sections:
            logger.info(f"[Agent] Analyzing section '{section_title}' with strategy '{strategy_type}'")
            
            # Find next section for boundary
            next_section = ""
            for i, s in enumerate(sections):
                if s.get("title") == section_title and i + 1 < len(sections):
                    next_section = sections[i + 1].get("title", "")
                    break
            
            # Step 1: Analyze section using analyze_section tool
            analysis_result = await execute_tool(
                "analyze_section",
                paper_id=clean_paper_id,
                section_title=section_title,
                next_section_title=next_section
            )
            
            if not analysis_result.get("success"):
                section_analyses[section_title] = f"분석 실패: {analysis_result.get('error', 'Unknown error')}"
                continue
            
            base_analysis = analysis_result.get("result", {}).get("analysis_text", "")
            
            # Step 2: Add focus areas if specified
            analysis_parts = []
            if section_title in focus_areas and focus_areas[section_title]:
                focus_list = focus_areas[section_title]
                focus_note = "\n\n### 🎯 집중 분석 영역\n"
                focus_note += "\n".join([f"- {area}" for area in focus_list])
                analysis_parts.append(focus_note)
            
            analysis_parts.append(base_analysis)
            
            # Step 3: Answer strategy-based questions if any
            if analysis_questions:
                # Filter questions relevant to this section
                section_keywords = section_title.lower().split()
                relevant_questions = [
                    q for q in analysis_questions 
                    if any(keyword in q.lower() for keyword in section_keywords) or 
                       len(analysis_questions) <= 3  # If few questions, use all
                ]
                
                # If no section-specific questions but we have general questions, use first 2
                if not relevant_questions and analysis_questions:
                    relevant_questions = analysis_questions[:2]
                
                if relevant_questions:
                    qa_answers = []
                    for question in relevant_questions:
                        try:
                            qa_result = await execute_tool(
                                "paper_qa",
                                paper_id=clean_paper_id,
                                question=question,
                                section_context=base_analysis[:2000]  # Provide section context
                            )
                            if qa_result.get("status") == "success":
                                qa_answers.append({
                                    "question": question,
                                    "answer": qa_result.get("answer", "")
                                })
                        except Exception as e:
                            logger.warning(f"QA failed for question '{question}': {e}")
                    
                    # Add Q&A section to analysis
                    if qa_answers:
                        qa_section = "\n\n### 🤔 핵심 질문과 답변\n"
                        for qa in qa_answers:
                            qa_section += f"\n**Q: {qa['question']}**\n\nA: {qa['answer']}\n\n"
                        analysis_parts.append(qa_section)
            
            # Combine all parts
            final_analysis = "\n\n".join(analysis_parts)
            section_analyses[section_title] = final_analysis
            
            state.log_reasoning(
                paper_id=clean_paper_id,
                context=f"섹션 '{section_title}' 전략 기반 분석",
                decision=f"{strategy_type} 전략 적용 완료",
                rationale=f"전략: {strategy_type}, 집중 영역: {', '.join(focus_areas.get(section_title, [])) if focus_areas.get(section_title) else '전체'}",
                action_taken=f"analyze_section_with_strategy({section_title})"
            )
        
        # Build selection reasoning with strategy info
        selection_reasoning = f"**분석 전략**: {strategy_type}\n\n{strategy_reasoning}"
        
        return PaperAnalysisResult(
            paper_id=clean_paper_id,
            title=paper_title,
            summary_report=summary_report,
            selected_sections=target_sections,
            section_analyses=section_analyses,
            selection_reasoning=selection_reasoning
        )


# =============================================================================
# Conference Pipeline Tool
# =============================================================================

class ConferencePipelineTool(MCPTool):
    """
    End-to-end pipeline for arXiv and NeurIPS paper analysis.
    
    Workflow:
    1. Search papers using source-specific search tool
    2. Rank papers using the ranking pipeline  
    3. Download top N PDFs
    4. Extract text from PDFs
    5. Run research agent analysis
    """
    
    @staticmethod
    async def _download_arxiv_paper(paper_id: str, title: str, rank: int) -> Optional[Dict]:
        """Download arXiv paper and return paper info dict."""
        try:
            download_result = await execute_tool("arxiv_download", paper_id=paper_id)
            if download_result.get("success"):
                filename = download_result.get("result", {}).get("filename", f"{paper_id}.pdf")
                return {
                    "paper_id": paper_id,
                    "title": title,
                    "filename": filename,
                    "rank": rank
                }
            logger.warning(f"Failed to download {paper_id}: {download_result.get('error')}")
        except Exception as e:
            logger.error(f"Download error for {paper_id}: {str(e)}")
        return None
    
    @staticmethod
    async def _download_neurips_paper(paper_id: str, title: str, rank: int) -> Optional[Dict]:
        """Download NeurIPS paper and return paper info dict."""
        try:
            download_result = await execute_tool(
                "neurips2025_download_pdf",
                paper_id=paper_id,
                mode="download",
                out_dir=str(PDF_DIR)
            )
            if download_result.get("success"):
                results = download_result.get("result", {}).get("results", [])
                if results and results[0].get("saved_path"):
                    saved_path = results[0].get("saved_path")
                    saved_path_obj = Path(saved_path)
                    try:
                        if saved_path_obj.is_absolute():
                            relative_path = saved_path_obj.relative_to(PDF_DIR.resolve())
                            filename = str(relative_path).replace("\\", "/")
                        else:
                            filename = str(saved_path).replace("\\", "/")
                    except ValueError:
                        filename = saved_path_obj.name
                    
                    return {
                        "paper_id": paper_id,
                        "title": title,
                        "filename": filename,
                        "rank": rank
                    }
                logger.warning(f"NeurIPS download returned no path for {paper_id}")
        except Exception as e:
            logger.error(f"Download error for {paper_id}: {str(e)}")
        return None
    
    @property
    def name(self) -> str:
        return "run_conference_pipeline"
    
    @property
    def description(self) -> str:
        return (
            "End-to-end pipeline for arXiv/NeurIPS paper analysis. "
            "Searches, ranks, downloads, extracts, and analyzes papers automatically."
        )
    
    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter(
                name="source",
                type="string",
                description="Paper source: 'arxiv' or 'neurips'",
                required=True
            ),
            ToolParameter(
                name="query",
                type="string",
                description="Search query string",
                required=True
            ),
            ToolParameter(
                name="top_k",
                type="integer",
                description="Number of papers to analyze (default: 3, max: 5)",
                required=False,
                default=3
            ),
            ToolParameter(
                name="goal",
                type="string",
                description="Analysis goal",
                required=False,
                default="general understanding"
            ),
            ToolParameter(
                name="analysis_mode",
                type="string",
                description="Analysis depth: 'quick', 'standard', 'deep'",
                required=False,
                default="quick"
            ),
            ToolParameter(
                name="discord_webhook_full",
                type="string",
                description="Discord webhook URL for full report",
                required=False,
                default=""
            ),
            ToolParameter(
                name="discord_webhook_summary",
                type="string",
                description="Discord webhook URL for summary",
                required=False,
                default=""
            ),
            ToolParameter(
                name="profile_path",
                type="string",
                description="Path to user profile for ranking",
                required=False,
                default="users/profile.json"
            )
        ]
    
    @property
    def category(self) -> str:
        return "agent"
    
    async def execute(
        self,
        source: str,
        query: str,
        top_k: int = 3,
        goal: str = "general understanding",
        analysis_mode: str = "quick",
        discord_webhook_full: str = "",
        discord_webhook_summary: str = "",
        profile_path: str = "users/profile.json",
        job_id: Optional[str] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """Execute the conference pipeline."""
        
        # Validate source
        if source not in ("arxiv", "neurips"):
            raise ExecutionError(f"Invalid source: {source}. Must be 'arxiv' or 'neurips'", tool_name=self.name)
        
        # Limit top_k
        top_k = min(max(top_k, 1), 5)
        
        # Generate job ID if not provided
        if not job_id:
            job_id = f"conf_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
        
        # Initialize state for progress tracking
        state = AgentState(
            job_id=job_id,
            goal=goal,
            papers=[],
            analysis_mode=analysis_mode
        )
        state.update_progress(f"Starting {source} pipeline...", 0.0)
        
        logger.info(f"[Conference Pipeline] Starting {source} search: '{query}' (top_k={top_k})")
        
        try:
            # ============================================================
            # Phase 1: Search papers
            # ============================================================
            state.update_progress(f"Searching {source} papers...", 5.0)
            
            if source == "arxiv":
                search_result = await execute_tool(
                    "arxiv_search",
                    query=query,
                    max_results=50
                )
            else:  # neurips
                search_result = await execute_tool(
                    "neurips_search",
                    query=query,
                    max_results=100,
                    profile_path=profile_path
                )
            
            if not search_result.get("success"):
                raise ExecutionError(
                    f"Search failed: {search_result.get('error')}",
                    tool_name=self.name
                )
            
            papers = search_result.get("result", {}).get("papers", [])
            if not papers:
                state.mark_completed()
                return {
                    "success": True,
                    "job_id": job_id,
                    "message": "No papers found for query",
                    "papers_found": 0,
                    "papers_analyzed": 0
                }
            
            logger.info(f"[Conference Pipeline] Found {len(papers)} papers")
            
            # Convert arXiv results to standard format
            if source == "arxiv":
                papers = convert_arxiv_to_paper_input(papers)
            
            state.log_reasoning(
                paper_id="pipeline",
                context=f"검색 쿼리: {query}",
                decision=f"{len(papers)}개 논문 발견",
                rationale=f"{source}에서 검색 완료",
                action_taken=f"{source}_search"
            )
            
            # ============================================================
            # Phase 2: Rank and filter papers
            # ============================================================
            state.update_progress("Ranking papers...", 15.0)
            
            # Apply hard filters
            filter_result = await execute_tool(
                "apply_hard_filters",
                papers=papers,
                profile_path=profile_path
            )
            
            if not filter_result.get("success"):
                logger.warning(f"Filter failed: {filter_result.get('error')}, using all papers")
                passed_papers = papers
            else:
                passed_papers = filter_result.get("result", {}).get("passed_papers", papers)
            
            if not passed_papers:
                state.mark_completed()
                return {
                    "success": True,
                    "job_id": job_id,
                    "message": "All papers filtered out",
                    "papers_found": len(papers),
                    "papers_analyzed": 0
                }
            
            # Calculate semantic scores
            state.update_progress("Calculating relevance scores...", 20.0)
            semantic_result = await execute_tool(
                "calculate_semantic_scores",
                papers=passed_papers,
                profile_path=profile_path,
                enable_llm_verification=False  # Faster for pipeline
            )
            
            semantic_scores = {}
            if semantic_result.get("success"):
                semantic_scores = semantic_result.get("result", {}).get("scores", {})
            
            # Evaluate metrics
            state.update_progress("Evaluating paper metrics...", 25.0)
            metrics_result = await execute_tool(
                "evaluate_paper_metrics",
                papers=passed_papers,
                semantic_scores=semantic_scores,
                profile_path=profile_path
            )
            
            metrics_scores = {}
            if metrics_result.get("success"):
                metrics_scores = metrics_result.get("result", {}).get("scores", {})
            
            # Rank and select top K
            state.update_progress("Selecting top papers...", 30.0)
            rank_result = await execute_tool(
                "rank_and_select_top_k",
                papers=passed_papers,
                semantic_scores=semantic_scores,
                metrics_scores=metrics_scores,
                top_k=top_k,
                profile_path=profile_path
            )
            
            if not rank_result.get("success"):
                raise ExecutionError(
                    f"Ranking failed: {rank_result.get('error')}",
                    tool_name=self.name
                )
            
            ranked_papers = rank_result.get("result", {}).get("ranked_papers", [])
            if not ranked_papers:
                state.mark_completed()
                return {
                    "success": True,
                    "job_id": job_id,
                    "message": "No papers selected after ranking",
                    "papers_found": len(papers),
                    "papers_analyzed": 0
                }
            
            logger.info(f"[Conference Pipeline] Selected {len(ranked_papers)} papers for analysis")
            
            state.log_reasoning(
                paper_id="pipeline",
                context=f"{len(passed_papers)}개 논문 필터링 후",
                decision=f"상위 {len(ranked_papers)}개 논문 선택",
                rationale="프로필 기반 점수 및 관련성으로 순위 결정",
                action_taken="rank_and_select_top_k"
            )
            
            # ============================================================
            # Phase 3: Download PDFs
            # ============================================================
            state.update_progress("Downloading papers...", 35.0)
            
            downloaded_papers = []
            for idx, paper_info in enumerate(ranked_papers):
                paper_id = paper_info.get("paper_id", "")
                title = paper_info.get("title", "Unknown")
                
                progress = 35.0 + (idx / len(ranked_papers)) * 15.0
                state.update_progress(f"Downloading {idx + 1}/{len(ranked_papers)}: {title[:50]}...", progress)
                
                try:
                    rank = paper_info.get("rank", idx + 1)
                    if source == "arxiv":
                        paper_info_dict = await ConferencePipelineTool._download_arxiv_paper(paper_id, title, rank)
                    else:  # neurips
                        paper_info_dict = await ConferencePipelineTool._download_neurips_paper(paper_id, title, rank)
                    
                    if paper_info_dict:
                        downloaded_papers.append(paper_info_dict)
                        logger.info(f"[Conference Pipeline] Downloaded: {paper_info_dict['filename']}")
                    else:
                        state.errors.append(f"Download failed for {paper_id}")
                except Exception as e:
                    logger.error(f"Download error for {paper_id}: {str(e)}")
                    state.errors.append(f"Download error for {paper_id}: {str(e)}")
            
            if not downloaded_papers:
                state.mark_failed("No papers could be downloaded")
                return {
                    "success": False,
                    "job_id": job_id,
                    "error": "Failed to download any papers",
                    "papers_found": len(papers),
                    "papers_analyzed": 0
                }
            
            state.log_reasoning(
                paper_id="pipeline",
                context=f"{len(ranked_papers)}개 논문 다운로드 시도",
                decision=f"{len(downloaded_papers)}개 논문 다운로드 완료",
                rationale="PDF 파일 로컬 저장 완료",
                action_taken=f"{source}_download"
            )
            
            # ============================================================
            # Phase 4: Extract text from PDFs
            # ============================================================
            state.update_progress("Extracting text from papers...", 50.0)
            
            extracted_papers = []
            for idx, paper_info in enumerate(downloaded_papers):
                filename = paper_info.get("filename", "")
                paper_id = paper_info.get("paper_id", "")
                
                progress = 50.0 + (idx / len(downloaded_papers)) * 10.0
                state.update_progress(f"Extracting text {idx + 1}/{len(downloaded_papers)}...", progress)
                
                try:
                    extract_result = await execute_tool(
                        "extract_all",
                        filename=filename
                    )
                    
                    if extract_result.get("success"):
                        extracted_papers.append(paper_info)
                        logger.info(f"[Conference Pipeline] Extracted: {filename}")
                    else:
                        logger.warning(f"Extraction failed for {filename}: {extract_result.get('error')}")
                        state.errors.append(f"Extraction failed for {filename}")
                
                except Exception as e:
                    logger.error(f"Extraction error for {filename}: {str(e)}")
                    state.errors.append(f"Extraction error for {filename}: {str(e)}")
            
            if not extracted_papers:
                state.mark_failed("No papers could be extracted")
                return {
                    "success": False,
                    "job_id": job_id,
                    "error": "Failed to extract text from any papers",
                    "papers_found": len(papers),
                    "papers_downloaded": len(downloaded_papers),
                    "papers_analyzed": 0
                }
            
            state.log_reasoning(
                paper_id="pipeline",
                context=f"{len(downloaded_papers)}개 PDF에서 텍스트 추출",
                decision=f"{len(extracted_papers)}개 논문 텍스트 추출 완료",
                rationale="분석을 위한 텍스트 준비 완료",
                action_taken="extract_all"
            )
            
            # ============================================================
            # Phase 5: Run research agent analysis
            # ============================================================
            state.update_progress("Running research agent analysis...", 60.0)
            
            # Get paper IDs (filenames without extension) for analysis
            paper_ids_for_analysis = []
            for p in extracted_papers:
                filename = p.get("filename", "")
                paper_id = filename.replace(".pdf", "") if filename.endswith(".pdf") else filename
                paper_ids_for_analysis.append(paper_id)
            
            # Update state papers
            state.papers = paper_ids_for_analysis
            state._save_state()
            
            # Run the research agent
            agent_tool = ResearchAgentTool()
            agent_result = await agent_tool.execute(
                paper_ids=paper_ids_for_analysis,
                goal=goal,
                analysis_mode=analysis_mode,
                discord_webhook_full=discord_webhook_full or get_discord_webhook_full(),
                discord_webhook_summary=discord_webhook_summary or get_discord_webhook_summary(),
                source=source,
                job_id=job_id
            )
            
            # The agent_tool will handle its own state updates and completion
            return {
                "success": agent_result.get("success", False),
                "job_id": job_id,
                "source": source,
                "query": query,
                "papers_found": len(papers),
                "papers_ranked": len(ranked_papers),
                "papers_downloaded": len(downloaded_papers),
                "papers_extracted": len(extracted_papers),
                "papers_analyzed": agent_result.get("papers_analyzed", 0),
                "report_path": agent_result.get("report_path"),
                "executive_summary": agent_result.get("executive_summary"),
                "reasoning_log_count": agent_result.get("reasoning_log_count", 0),
                "notifications": agent_result.get("notifications", {}),
                "errors": state.errors + (agent_result.get("errors") or [])
            }
        
        except Exception as e:
            logger.error(f"[Conference Pipeline] Failed: {str(e)}")
            state.mark_failed(str(e))
            return {
                "success": False,
                "job_id": job_id,
                "error": str(e),
                "errors": state.errors
            }
