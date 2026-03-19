"""
Podcast Tools
Generate engaging, conversational audio scripts and audio files from paper content.
"""

import os
import json
from pathlib import Path
from typing import Dict, Any, List
from ..base import MCPTool, ToolParameter, ExecutionError
from runtime.service_config import build_openai_client

OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", "/data/output"))


class PodcastGeneratorTool(MCPTool):
    """
    논문 내용을 바탕으로 자연스러운 팟캐스트 대본을 작성하고,
    이를 오디오 파일로 생성합니다. (단순 낭독 X, 각색 O)
    """

    @property
    def name(self) -> str:
        return "generate_podcast"

    @property
    def description(self) -> str:
        return "Create a natural, engaging podcast-style audio briefing from a paper."

    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter(
                name="paper_id",
                type="string",
                description="Paper ID (folder name)",
                required=True,
            ),
            ToolParameter(
                name="style",
                type="string",
                description="Style of the podcast: 'expert' (deep dive), 'casual' (easy to understand), 'host' (radio style)",
                required=False,
                default="casual",
            ),
            ToolParameter(
                name="voice",
                type="string",
                description="OpenAI Voice: 'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'",
                required=False,
                default="onyx",
            ),
        ]

    def _generate_script(self, client, text_content: str, style: str) -> str:
        """GPT-4o를 사용하여 딱딱한 텍스트를 구어체 대본으로 변환"""

        # 스타일별 프롬프트 설정
        system_prompt = "You are an expert AI researcher."
        if style == "casual":
            system_prompt = (
                "You are a friendly tech podcaster. "
                "Explain this research paper to a general audience. "
                "Use simple analogies, avoid heavy jargon, and keep it engaging. "
                "Do not read the abstract verbatim. Act like you are talking to a friend. "
                "Start with a hook."
            )
        elif style == "host":
            system_prompt = (
                "You are a charismatic radio host. "
                "Give a quick, energetic update on this new paper. "
                "Focus on 'Why this matters' and 'What's new'. "
                "Use phrases like 'Welcome back', 'Today we are looking at', etc."
            )
        elif style == "expert":
            system_prompt = (
                "You are a senior professor. "
                "Summarize this paper for PhD students. "
                "Focus on methodology and technical contribution. "
                "Speak naturally but professionally."
            )

        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": f"Here is the paper content (truncated):\n\n{text_content[:15000]}\n\nCreate a 3-minute podcast script based on this.",
                },
            ],
        )
        return response.choices[0].message.content

    async def execute(
        self, paper_id: str, style: str = "casual", voice: str = "onyx"
    ) -> Dict[str, Any]:

        # 1. 파일 경로 설정
        paper_dir = OUTPUT_DIR / paper_id
        text_file = paper_dir / "extracted_text.txt"
        audio_dir = paper_dir / "audio"
        audio_dir.mkdir(parents=True, exist_ok=True)

        if not text_file.exists():
            return {"error": "Paper text not found. Run extract_text first."}

        try:
            client = build_openai_client()

            # 2. 텍스트 읽기 (너무 길면 앞부분 20,000자만 - 토큰 절약)
            with open(text_file, "r", encoding="utf-8", errors="ignore") as f:
                raw_text = f.read()[:20000]

            # 3. [각색 단계] 대본(Script) 작성
            script = self._generate_script(client, raw_text, style)

            # 대본 저장 (나중에 눈으로 볼 수 있게)
            script_path = audio_dir / "podcast_script.txt"
            with open(script_path, "w", encoding="utf-8") as f:
                f.write(script)

            # 4. [음성 합성 단계] TTS 변환
            audio_path = audio_dir / f"podcast_{style}.mp3"
            response = client.audio.speech.create(
                model="tts-1", voice=voice, input=script
            )
            response.stream_to_file(audio_path)

            return {
                "paper_id": paper_id,
                "status": "success",
                "style": style,
                "script_preview": script[:200] + "...",
                "script_path": str(script_path),
                "audio_path": str(audio_path),
                "message": "Podcast generated successfully. Listen to the audio file!",
            }

        except RuntimeError as e:
            raise ExecutionError(str(e), self.name) from e
        except Exception as e:
            raise ExecutionError(f"Podcast generation failed: {str(e)}", self.name)
