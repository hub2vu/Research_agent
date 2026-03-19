"""
Survey Generation Tools (Pro Version)
Generates high-quality survey papers using a Two-Pass (Plan -> Write) approach.
"""

import os
import logging
import time
from pathlib import Path
from typing import Any, Dict, List
from openai import AsyncOpenAI

from ..base import MCPTool, ToolParameter, ExecutionError

# LLM Logging
import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from logs.llm_logger import get_logger as get_llm_logger, SummaryType
from runtime.service_config import build_async_openai_client

logger = logging.getLogger("mcp.tools.survey")
logger.setLevel(logging.INFO)


class GenerateClusterSurveyTool(MCPTool):
    """

    @staticmethod
    def _get_client() -> AsyncOpenAI:
        return build_async_openai_client()
    Two-Pass Survey Generator:
    1. Plan: Analyze papers to create a Taxonomy.
    2. Write: Generate the full survey based on the Taxonomy.
    """

    @property
    def name(self) -> str:
        return "generate_cluster_survey"

    @property
    def description(self) -> str:
        return "Write a professional survey paper using a Plan-then-Write strategy."

    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter(
                name="topic", type="string", description="Survey topic", required=True
            ),
            ToolParameter(
                name="papers_context",
                type="string",
                description="Paper details",
                required=True,
            ),
            ToolParameter(
                name="language",
                type="string",
                description="Output language",
                required=False,
                default="Korean",
            ),
        ]

    @property
    def category(self) -> str:
        return "analysis"

    async def execute(
        self, topic: str, papers_context: str, language: str = "Korean"
    ) -> Dict[str, Any]:
        logger.info(f"Generating Pro Survey for: {topic}")

        try:
            # ====================================================
            # PHASE 1: The Architect (Taxonomy & Structure Plan)
            # ====================================================
            logger.info("Phase 1: Planning Taxonomy...")

            plan_prompt = f"""
            You are a Senior Editor at a top AI journal.
            Task: Analyze the provided papers and design a **Taxonomy (Classification System)** for a survey paper on "{topic}".

            **Source Papers:**
            {papers_context}

            **Goal:**
            Group these papers into 3-4 distinct, logical categories based on their **Methodology** or **Problem Definition**.
            Do NOT just list them. Find the underlying structure.

            **Output Format:**
            Just return the categories and which papers belong to them.
            1. Category Name A: [Paper IDs...] - Brief rationale
            2. Category Name B: [Paper IDs...] - Brief rationale
            ...
            """

            start_time_plan = time.time()
            plan_response = await self._get_client().chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": plan_prompt}],
                temperature=0.2,  # 기획은 냉철하게
            )
            latency_plan = (time.time() - start_time_plan) * 1000
            taxonomy_plan = plan_response.choices[0].message.content

            # Extract token usage for Phase 1
            token_usage_plan = {}
            if hasattr(plan_response, 'usage') and plan_response.usage:
                token_usage_plan = {
                    "prompt_tokens": plan_response.usage.prompt_tokens,
                    "completion_tokens": plan_response.usage.completion_tokens,
                    "total_tokens": plan_response.usage.total_tokens
                }

            # LLM Logging - Log taxonomy planning
            try:
                llm_logger = get_llm_logger()

                llm_logger.log_llm_call(
                    model="gpt-4o",
                    prompt=plan_prompt[:5000],
                    response=taxonomy_plan[:5000],
                    tool_name="generate_cluster_survey_plan",
                    temperature=0.2,
                    token_usage=token_usage_plan,
                    latency_ms=latency_plan,
                    metadata={"topic": topic, "phase": "taxonomy_planning"}
                )

                # Log the decision about taxonomy structure
                llm_logger.log_decision(
                    decision_id=f"survey_taxonomy_{int(time.time())}",
                    decision="Survey taxonomy categorization",
                    options=["methodology-based", "problem-based", "chronological", "hybrid"],
                    chosen="methodology/problem-based",
                    rationale=f"Grouped papers into logical categories for topic: {topic}",
                    agent_name="SurveyGenerator",
                    context=f"Topic: {topic}, Papers context length: {len(papers_context)}",
                    metadata={"taxonomy_plan_length": len(taxonomy_plan)}
                )
            except Exception as log_error:
                logger.warning(f"Failed to log taxonomy planning: {log_error}")

            # ====================================================
            # PHASE 2: The Writer (Deep Dive & Synthesis)
            # ====================================================
            logger.info("Phase 2: Writing Full Paper...")

            write_prompt = f"""
            You are a Distinguished Researcher writing a Survey Paper.

            **Topic:** {topic}
            **Language:** {language}

            **Instructions:**
            Write a comprehensive survey paper following the **Taxonomy Plan** below.
            Your tone must be highly academic, critical, and insightful.

            **Taxonomy Plan (Use this structure):**
            {taxonomy_plan}

            **Source Papers:**
            {papers_context}

            **Required Structure (Markdown):**

            # {topic}: A Comprehensive Survey

            ## 1. Introduction
            - Define the problem scope.
            - Explain why this classification (Taxonomy) matters.

            ## 2. Taxonomy & Categorization (Main Body)
            - For EACH category in the plan:
              - **Define** the approach conceptually.
              - **Synthesize** the papers (Don't just list summaries. Connect them: "While Paper A proposed X, Paper B improved it by Y").
              - **Cite** specific papers using [Paper X].

            ## 3. Comparative Analysis
            - Create a **Markdown Table** comparing key methods.
            - Columns: [Method/Category, Core Technique, Pros, Cons].

            ## 4. Challenges & Future Directions
            - Identify open problems NOT solved by these papers.
            - Propose specific future research directions.

            **Style Guidelines:**
            - Use **bold** for emphasis.
            - If possible, include a textual representation of a diagram (e.g., Mermaid or ASCII) to explain the taxonomy.
            """

            start_time_write = time.time()
            final_response = await self._get_client().chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": write_prompt}],
                temperature=0.4,  # 글쓰기는 약간 창의적으로
            )
            latency_write = (time.time() - start_time_write) * 1000
            survey_content = final_response.choices[0].message.content

            # Extract token usage for Phase 2
            token_usage_write = {}
            if hasattr(final_response, 'usage') and final_response.usage:
                token_usage_write = {
                    "prompt_tokens": final_response.usage.prompt_tokens,
                    "completion_tokens": final_response.usage.completion_tokens,
                    "total_tokens": final_response.usage.total_tokens
                }

            # LLM Logging - Log survey writing
            try:
                llm_logger = get_llm_logger()

                llm_logger.log_summary(
                    paper_id=f"survey_{topic[:30].replace(' ', '_')}",
                    summary_type="survey",
                    summary_prompt=write_prompt[:5000],
                    summary_response=survey_content,
                    source_text_length=len(papers_context),
                    model="gpt-4o",
                    temperature=0.4,
                    metadata={
                        "topic": topic,
                        "language": language,
                        "taxonomy_used": True,
                        "phase": "survey_writing"
                    }
                )

                llm_logger.log_llm_call(
                    model="gpt-4o",
                    prompt=write_prompt[:5000],
                    response=survey_content[:5000],
                    tool_name="generate_cluster_survey_write",
                    temperature=0.4,
                    token_usage=token_usage_write,
                    latency_ms=latency_write,
                    metadata={"topic": topic, "phase": "survey_writing"}
                )
            except Exception as log_error:
                logger.warning(f"Failed to log survey writing: {log_error}")

            return {
                "topic": topic,
                "status": "success",
                "survey_content": survey_content,
                "taxonomy_debug": taxonomy_plan,  # 디버깅용 (필요시 확인 가능)
            }

        except Exception as e:
            logger.error(f"Error: {str(e)}")
            raise ExecutionError(f"Survey generation failed: {str(e)}", self.name)
