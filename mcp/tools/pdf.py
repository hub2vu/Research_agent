"""
PDF Processing Tools

Provides tools for PDF text and image extraction using PyMuPDF.
Updated to avoid LLM Rate Limits by saving full text to disk and returning previews.
"""

import json
import os
import re
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Tuple

import fitz  # PyMuPDF

from ..base import MCPTool, ToolParameter, ExecutionError

# Configuration from environment
PDF_DIR = Path(os.getenv("PDF_DIR", "/data/pdf"))
OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", "/data/output"))

# Ensure directories exist
PDF_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


class ReferenceExtractor:
    """Reference parsing utilities shared across PDF tools."""

    def __init__(self, output_dir: Path):
        self.output_dir = output_dir

    def extract(self, filename: str, raw_text: str, include_raw_entries: bool = False) -> Dict[str, Any]:
        paper_id = self._normalize_paper_id(filename)
        clean_text = self._global_preprocess(raw_text)
        refs_block = self._isolate_references_block(clean_text)
        ref_items = self._parse_reference_items(refs_block)

        items_out: List[Dict[str, Any]] = []
        titles_found: List[Tuple[int, str]] = []

        for idx, (no, entry) in enumerate(ref_items):
            display_no = no if no > 0 else (idx + 1)
            title = self._extract_title_logic(entry)

            if title:
                titles_found.append((display_no, title))

            items_out.append({
                "ref_no": display_no,
                "title": title,
                "raw_text": entry if include_raw_entries else entry[:100] + "...",
            })

        titles_list = [t for _, t in titles_found]

        result: Dict[str, Any] = {
            "filename": paper_id,
            "original_filename": filename,
            "references_detected": len(ref_items),
            "titles_extracted": len(titles_found),
            "titles": titles_list,
            "diagnostics": {
                "parsed_items_count": len(ref_items),
                "is_numbered": any(n > 0 for n, _ in ref_items),
                "id_normalized": paper_id != filename,
            },
        }

        self._save_outputs(paper_id, result, items_out)
        return result

    def _normalize_paper_id(self, paper_id: str) -> str:
        if paper_id.startswith("10.48550_arxiv."):
            return paper_id

        arxiv_pattern = r'^\d{4}\.\d{4,5}(v\d+)?$'
        if re.match(arxiv_pattern, paper_id):
            return f"10.48550_arxiv.{paper_id}"

        return paper_id

    def _save_outputs(self, paper_id: str, result: Dict[str, Any], items: List[Dict[str, Any]]):
        out_dir = self.output_dir / paper_id
        out_dir.mkdir(parents=True, exist_ok=True)

        (out_dir / "reference_titles.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (out_dir / "reference_titles.txt").write_text(
            "\n".join(result["titles"]), encoding="utf-8"
        )
        (out_dir / "reference_items.json").write_text(
            json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def _global_preprocess(self, text: str) -> str:
        lines = text.splitlines()
        cleaned_lines = []
        line_counts = Counter(L.strip() for L in lines if len(L.strip()) > 5)

        for line in lines:
            s = line.strip()
            line = re.sub(r"\", "", line)
            s = line.strip()
            if not s:
                continue
            if re.match(r"^=== Page \d+ ===$", s):
                continue
            if re.match(r"^\d+$", s):
                continue
            if line_counts[s] > 3 and not re.match(r"^\[?\d+\]?\.?", s):
                continue
            cleaned_lines.append(line)
        return "\n".join(cleaned_lines)

    def _isolate_references_block(self, text: str) -> str:
        headers = ["REFERENCES", "BIBLIOGRAPHY", "References", "Bibliography"]
        start_idx = -1
        for h in headers:
            matches = list(re.finditer(r"\n\s*" + re.escape(h) + r"\s*\n", text, re.IGNORECASE))
            if matches:
                start_idx = matches[-1].end()
                break

        if start_idx == -1:
            start_idx = int(len(text) * 0.8)
        block = text[start_idx:]

        end_markers = [r"\n\s*APPENDIX", r"\n\s*Appendix", r"\n\s*SUPPLEMENTARY", r"\n\s*Supplementary", r"\n\s*[A-Z]\s+ADDITIONAL RESULTS"]
        end_idx = len(block)
        for marker in end_markers:
            m = re.search(marker, block)
            if m and m.start() < end_idx:
                end_idx = m.start()

        return block[:end_idx].strip()

    def _parse_reference_items(self, block: str) -> List[Tuple[int, str]]:
        numbered = self._try_parse_numbered(block)
        if len(numbered) >= 3:
            return numbered
        return self._try_parse_unnumbered(block)

    def _try_parse_numbered(self, text: str) -> List[Tuple[int, str]]:
        items = []
        matches = list(re.finditer(r"(?m)^\s*\[(\d+)\]\s+", text))
        if not matches:
            matches = list(re.finditer(r"(?m)^\s*(\d+)\.\s+", text))

        for i, m in enumerate(matches):
            no = int(m.group(1))
            start = m.end()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            content = re.sub(r"\s+", " ", text[start:end]).strip()
            if len(content) > 10:
                items.append((no, content))
        return items

    def _try_parse_unnumbered(self, text: str) -> List[Tuple[int, str]]:
        lines = [L.strip() for L in text.splitlines() if L.strip()]
        merged_items = []
        current_lines: List[str] = []
        for line in lines:
            is_start = False
            if line and line[0].isupper() and "," in line[:50]:
                is_start = True
            if is_start and current_lines:
                merged_items.append(" ".join(current_lines))
                current_lines = [line]
            else:
                current_lines.append(line)
        if current_lines:
            merged_items.append(" ".join(current_lines))
        return [(0, item) for item in merged_items if len(item) > 20]

    def _extract_title_logic(self, entry: str) -> str:
        clean = re.sub(r"\s+", " ", entry).strip()
        m_quote = re.search(r"[\"“](.+?)[\"”]", clean)
        if m_quote and len(m_quote.group(1)) > 10:
            return m_quote.group(1)

        parts = clean.split(". ")
        if len(parts) >= 2:
            candidate = parts[1]
            idx = 1
            while idx < len(parts) and len(parts[idx]) <= 2 and parts[idx].isupper():
                idx += 1
            if idx < len(parts):
                candidate = parts[idx]
            return self._clean_title_string(candidate)

        m_year = re.search(r"\b(19|20)\d{2}\b", clean)
        if m_year:
            pre_year = clean[:m_year.start()]
            last_dot = pre_year.rfind(".")
            return self._clean_title_string(pre_year[last_dot + 1:] if last_dot != -1 else pre_year)
        return ""

    def _clean_title_string(self, text: str) -> str:
        text = re.sub(r"https?://\S+", "", text)
        text = re.sub(r"arXiv:\S+", "", text, flags=re.IGNORECASE)
        text = text.strip(" .,[]()")
        text = re.sub(r"^In\s+.*", "", text, flags=re.IGNORECASE)
        return text.strip()


class ListPDFsTool(MCPTool):
    """List all PDF files in the configured directory."""

    @property
    def name(self) -> str:
        return "list_pdfs"

    @property
    def description(self) -> str:
        return "List all PDF files in the pdf directory with their sizes"

    @property
    def category(self) -> str:
        return "pdf"

    async def execute(self, **kwargs) -> Dict[str, Any]:
        pdfs = []
        if PDF_DIR.exists():
            for pdf_file in PDF_DIR.glob("*.pdf"):
                stat = pdf_file.stat()
                pdfs.append({
                    "filename": pdf_file.name,
                    "path": str(pdf_file),
                    "size_bytes": stat.st_size,
                    "size_mb": round(stat.st_size / (1024 * 1024), 2)
                })

        return {
            "pdf_directory": str(PDF_DIR),
            "total_files": len(pdfs),
            "files": sorted(pdfs, key=lambda x: x["filename"])
        }


class ExtractTextTool(MCPTool):
    """Extract text from a PDF file."""

    @property
    def name(self) -> str:
        return "extract_text"

    @property
    def description(self) -> str:
        return "Extract text from a PDF. Saves full text to file and returns a preview to avoid Rate Limits."

    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter(
                name="filename",
                type="string",
                description="Name of the PDF file (e.g., 'paper.pdf')",
                required=True
            ),
            ToolParameter(
                name="return_full_text",
                type="boolean",
                description="Internal use only: Return full text object instead of preview",
                required=False,
                default=False
            )
        ]

    @property
    def category(self) -> str:
        return "pdf"

    async def execute(self, filename: str, return_full_text: bool = False) -> Dict[str, Any]:
        pdf_path = PDF_DIR / filename

        if not pdf_path.exists():
            raise ExecutionError(f"File not found: {filename}", tool_name=self.name)

        # Output Setup
        pdf_name = pdf_path.stem
        normalized_name = ReferenceExtractor(OUTPUT_DIR)._normalize_paper_id(pdf_name)
        pdf_output_dir = OUTPUT_DIR / normalized_name
        pdf_output_dir.mkdir(parents=True, exist_ok=True)
        text_output_path = pdf_output_dir / "extracted_text.json"

        # Extraction
        try:
            doc = fitz.open(pdf_path)
            result = {
                "filename": pdf_path.name,
                "total_pages": len(doc),
                "full_text": "",
                "pages": []
            }

            for page_num in range(len(doc)):
                page = doc[page_num]
                text = page.get_text()
                result["full_text"] += text
                result["pages"].append({
                    "page_number": page_num + 1,
                    "text": text
                })

            doc.close()

            # Save to file
            with open(text_output_path, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)

            # Return Logic
            if return_full_text:
                return result
            
            # Default: Return Preview
            preview_length = 500
            preview_text = result["full_text"][:preview_length].replace("\n", " ")
            return {
                "status": "success",
                "filename": filename,
                "saved_to": str(text_output_path),
                "total_pages": result["total_pages"],
                "total_characters": len(result["full_text"]),
                "preview": f"{preview_text}...",
                "note": "Full text saved to file. Use 'read_extracted_text' to read specific parts if needed."
            }

        except Exception as e:
            raise ExecutionError(f"Failed to extract text: {str(e)}", tool_name=self.name)


class ExtractImagesTool(MCPTool):
    """Extract images from a PDF file."""

    @property
    def name(self) -> str:
        return "extract_images"

    @property
    def description(self) -> str:
        return "Extract all images from a PDF file and save them to output directory"

    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter(
                name="filename",
                type="string",
                description="Name of the PDF file (e.g., 'paper.pdf')",
                required=True
            )
        ]

    @property
    def category(self) -> str:
        return "pdf"

    async def execute(self, filename: str) -> Dict[str, Any]:
        pdf_path = PDF_DIR / filename

        if not pdf_path.exists():
            raise ExecutionError(f"File not found: {filename}", tool_name=self.name)

        doc = fitz.open(pdf_path)
        pdf_name = pdf_path.stem
        normalized_name = ReferenceExtractor(OUTPUT_DIR)._normalize_paper_id(pdf_name)
        image_output_dir = OUTPUT_DIR / normalized_name / "images"
        image_output_dir.mkdir(parents=True, exist_ok=True)

        result = {
            "filename": pdf_path.name,
            "total_pages": len(doc),
            "images": []
        }

        image_count = 0
        for page_num in range(len(doc)):
            page = doc[page_num]
            image_list = page.get_images(full=True)

            for img_index, img in enumerate(image_list):
                xref = img[0]
                try:
                    base_image = doc.extract_image(xref)
                    image_bytes = base_image["image"]
                    image_ext = base_image["ext"]

                    image_filename = f"page{page_num + 1}_img{img_index + 1}.{image_ext}"
                    image_path = image_output_dir / image_filename

                    with open(image_path, "wb") as f:
                        f.write(image_bytes)

                    result["images"].append({
                        "page_number": page_num + 1,
                        "image_index": img_index + 1,
                        "filename": image_filename,
                        "path": str(image_path),
                        "format": image_ext,
                        "size_bytes": len(image_bytes)
                    })
                    image_count += 1
                except Exception as e:
                    result["images"].append({
                        "page_number": page_num + 1,
                        "image_index": img_index + 1,
                        "error": str(e)
                    })

        doc.close()
        result["total_images_extracted"] = image_count
        
        # Save metadata
        meta_path = OUTPUT_DIR / normalized_name / "image_metadata.json"
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)

        return result


class ExtractAllTool(MCPTool):
    """Extract both text and images from a PDF file."""

    @property
    def name(self) -> str:
        return "extract_all"

    @property
    def description(self) -> str:
        return "Extract both text and images from a PDF, saving results to output directory"

    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter(
                name="filename",
                type="string",
                description="Name of the PDF file (e.g., 'paper.pdf')",
                required=True
            )
        ]

    @property
    def category(self) -> str:
        return "pdf"

    async def execute(self, filename: str) -> Dict[str, Any]:
        # 1. Extract Text (Get full data internally)
        extract_text_tool = ExtractTextTool()
        text_result = await extract_text_tool.execute(filename=filename, return_full_text=True)

        pdf_path = PDF_DIR / filename
        pdf_name = pdf_path.stem
        reference_extractor = ReferenceExtractor(OUTPUT_DIR)
        normalized_name = reference_extractor._normalize_paper_id(pdf_name)
        pdf_output_dir = OUTPUT_DIR / normalized_name

        # Save readable text file
        plain_text_path = pdf_output_dir / "extracted_text.txt"
        with open(plain_text_path, "w", encoding="utf-8") as f:
            for page in text_result["pages"]:
                f.write(f"=== Page {page['page_number']} ===\n")
                f.write(page["text"])
                f.write("\n\n")

        # 2. Extract Images
        extract_images_tool = ExtractImagesTool()
        image_result = await extract_images_tool.execute(filename=filename)

        # 3. Extract References
        references_result = reference_extractor.extract(
            filename=pdf_name,
            raw_text=plain_text_path.read_text(encoding="utf-8", errors="ignore"),
        )

        return {
            "filename": filename,
            "output_directory": str(pdf_output_dir),
            "text_extraction": {
                "total_pages": text_result["total_pages"],
                "text_file": str(plain_text_path),
                "json_file": str(pdf_output_dir / "extracted_text.json")
            },
            "image_extraction": {
                "total_images": image_result["total_images_extracted"],
                "images_directory": str(pdf_output_dir / "images")
            },
            "reference_extraction": {
                "references_detected": references_result["references_detected"],
                "titles_extracted": references_result["titles_extracted"],
                "titles_file": str((OUTPUT_DIR / references_result["filename"] / "reference_titles.txt")),
                "items_file": str((OUTPUT_DIR / references_result["filename"] / "reference_items.json")),
            },
        }


class ProcessAllPDFsTool(MCPTool):
    """Process all PDF files in the directory."""

    @property
    def name(self) -> str:
        return "process_all_pdfs"

    @property
    def description(self) -> str:
        return "Process all PDF files in the directory, extracting text and images from each"

    @property
    def category(self) -> str:
        return "pdf"

    async def execute(self, **kwargs) -> Dict[str, Any]:
        list_tool = ListPDFsTool()
        pdfs_info = await list_tool.execute()

        extract_tool = ExtractAllTool()
        results = []

        for pdf_info in pdfs_info["files"]:
            try:
                result = await extract_tool.execute(filename=pdf_info["filename"])
                result["status"] = "success"
                results.append(result)
            except Exception as e:
                results.append({
                    "filename": pdf_info["filename"],
                    "status": "error",
                    "error": str(e)
                })

        return {
            "total_processed": len(results),
            "successful": len([r for r in results if r.get("status") == "success"]),
            "failed": len([r for r in results if r.get("status") == "error"]),
            "results": results
        }


class GetPDFInfoTool(MCPTool):
    """Get metadata and information about a PDF file."""

    @property
    def name(self) -> str:
        return "get_pdf_info"

    @property
    def description(self) -> str:
        return "Get metadata and information about a specific PDF file"

    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter(
                name="filename",
                type="string",
                description="Name of the PDF file (e.g., 'paper.pdf')",
                required=True
            )
        ]

    @property
    def category(self) -> str:
        return "pdf"

    async def execute(self, filename: str) -> Dict[str, Any]:
        pdf_path = PDF_DIR / filename

        if not pdf_path.exists():
            raise ExecutionError(f"File not found: {filename}", tool_name=self.name)

        doc = fitz.open(pdf_path)
        metadata = doc.metadata

        info = {
            "filename": pdf_path.name,
            "path": str(pdf_path),
            "total_pages": len(doc),
            "metadata": metadata,
            "file_size_bytes": pdf_path.stat().st_size,
            "file_size_mb": round(pdf_path.stat().st_size / (1024 * 1024), 2)
        }

        image_counts = []
        total_images = 0
        for page_num in range(len(doc)):
            page = doc[page_num]
            images = page.get_images(full=True)
            count = len(images)
            image_counts.append({"page": page_num + 1, "image_count": count})
            total_images += count

        info["images_per_page"] = image_counts
        info["total_images"] = total_images

        doc.close()
        return info


class ReadExtractedTextTool(MCPTool):
    """Read previously extracted text from a PDF."""

    @property
    def name(self) -> str:
        return "read_extracted_text"

    @property
    def description(self) -> str:
        return "Read the extracted text from a previously processed PDF"

    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter(
                name="filename",
                type="string",
                description="Name of the PDF file (with or without .pdf extension)",
                required=True
            )
        ]

    @property
    def category(self) -> str:
        return "pdf"

    async def execute(self, filename: str) -> Dict[str, Any]:
        pdf_name = filename.replace(".pdf", "")
        text_file = OUTPUT_DIR / pdf_name / "extracted_text.txt"

        if not text_file.exists():
            # Try JSON if TXT not found
            json_file = OUTPUT_DIR / pdf_name / "extracted_text.json"
            if json_file.exists():
                with open(json_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    return {
                        "filename": pdf_name,
                        "content": data.get("full_text", "")[:50000] + "\n...[Truncated]",
                        "truncated": True
                    }

            raise ExecutionError(
                f"No extracted text found for '{pdf_name}'. Run extract_all or extract_text first.",
                tool_name=self.name
            )

        with open(text_file, "r", encoding="utf-8") as f:
            content = f.read()

        # Truncate if too long
        max_chars = 50000
        truncated = len(content) > max_chars
        if truncated:
            content = content[:max_chars] + "\n\n... [Truncated]"

        return {
            "filename": pdf_name,
            "text_file": str(text_file),
            "content": content,
            "truncated": truncated
        }