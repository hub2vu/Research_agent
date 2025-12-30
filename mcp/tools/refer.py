from typing import Any, Dict, List

from ..base import MCPTool, ToolParameter, ExecutionError
from .pdf import OUTPUT_DIR, ReferenceExtractor


class ExtractReferenceTitlesTool(MCPTool):
    @property
    def name(self) -> str:
        return "extract_reference_titles"

    @property
    def description(self) -> str:
        return (
            "Robustly extract references and titles from extracted_text.txt, "
            "automatically normalizing arXiv IDs to DOI format for graph compatibility."
        )

    @property
    def category(self) -> str:
        return "pdf"

    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter(
                name="filename",
                type="string",
                description="Name of the PDF file (e.g., 2201.07207.pdf)",
                required=True,
            ),
            ToolParameter(
                name="save_files",
                type="boolean",
                description="Save outputs to output directory",
                required=False,
                default=True,
            ),
            ToolParameter(
                name="include_raw_entries",
                type="boolean",
                description="Include raw reference entry text",
                required=False,
                default=False,
            ),
        ]

    async def execute(
        self,
        filename: str,
        save_files: bool = True,
        include_raw_entries: bool = False,
    ) -> Dict[str, Any]:
        extractor = ReferenceExtractor(OUTPUT_DIR)
        original_id = filename.replace(".pdf", "").strip()
        paper_id = extractor._normalize_paper_id(original_id)

        text_file = OUTPUT_DIR / paper_id / "extracted_text.txt"
        if not text_file.exists():
            text_file = OUTPUT_DIR / original_id / "extracted_text.txt"

        if not text_file.exists():
            raise ExecutionError(
                f"No extracted text found for '{paper_id}' or '{original_id}'. Expected at: {text_file}",
                tool_name=self.name,
            )

        if not save_files:
            # ReferenceExtractor always writes outputs; this flag is retained for interface compatibility.
            pass

        return extractor.extract(
            filename=original_id,
            raw_text=text_file.read_text(encoding="utf-8", errors="ignore"),
            include_raw_entries=include_raw_entries,
        )
