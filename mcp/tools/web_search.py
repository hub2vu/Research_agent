"""
Web Search Tools

Provides web search functionality using Tavily API.
"""

from typing import Any, Dict, List, Optional

from ..base import MCPTool, ToolParameter, ExecutionError
from runtime.service_config import require_tavily_api_key

# Try to import tavily
try:
    from tavily import TavilyClient
    HAS_TAVILY = True
except ImportError:
    HAS_TAVILY = False


class WebSearchTool(MCPTool):
    """Search the web using Tavily API."""

    @property
    def name(self) -> str:
        return "web_search"

    @property
    def description(self) -> str:
        return "Search the web for information using Tavily API"

    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter(
                name="query",
                type="string",
                description="Search query",
                required=True
            ),
            ToolParameter(
                name="max_results",
                type="integer",
                description="Maximum number of results to return",
                required=False,
                default=5
            ),
            ToolParameter(
                name="search_depth",
                type="string",
                description="Search depth: 'basic' or 'advanced'",
                required=False,
                default="basic"
            ),
            ToolParameter(
                name="include_domains",
                type="array",
                items_type="string",
                description="List of domains to include in search",
                required=False,
                default=None
            ),
            ToolParameter(
                name="exclude_domains",
                type="array",
                items_type="string",
                description="List of domains to exclude from search",
                required=False,
                default=None
            )
        ]

    @property
    def category(self) -> str:
        return "web"

    async def execute(
        self,
        query: str,
        max_results: int = 5,
        search_depth: str = "basic",
        include_domains: Optional[List[str]] = None,
        exclude_domains: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        if not HAS_TAVILY:
            raise ExecutionError(
                "tavily-python not installed. Run: pip install tavily-python",
                tool_name=self.name
            )

        try:
            api_key = require_tavily_api_key()
        except RuntimeError as exc:
            raise ExecutionError(
                str(exc),
                tool_name=self.name
            )

        try:
            client = TavilyClient(api_key=api_key)

            # Build search parameters
            search_params = {
                "query": query,
                "max_results": max_results,
                "search_depth": search_depth
            }

            if include_domains:
                search_params["include_domains"] = include_domains
            if exclude_domains:
                search_params["exclude_domains"] = exclude_domains

            response = client.search(**search_params)

            # Format results
            results = []
            for result in response.get("results", []):
                results.append({
                    "title": result.get("title"),
                    "url": result.get("url"),
                    "content": result.get("content"),
                    "score": result.get("score")
                })

            return {
                "query": query,
                "total_results": len(results),
                "results": results,
                "answer": response.get("answer")  # Tavily's AI-generated answer
            }

        except Exception as e:
            raise ExecutionError(f"Web search failed: {str(e)}", tool_name=self.name)


class WebGetContentTool(MCPTool):
    """Get content from a specific URL."""

    @property
    def name(self) -> str:
        return "web_get_content"

    @property
    def description(self) -> str:
        return "Fetch and extract content from a specific URL"

    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter(
                name="url",
                type="string",
                description="URL to fetch content from",
                required=True
            )
        ]

    @property
    def category(self) -> str:
        return "web"

    async def execute(self, url: str) -> Dict[str, Any]:
        if not HAS_TAVILY:
            raise ExecutionError(
                "tavily-python not installed. Run: pip install tavily-python",
                tool_name=self.name
            )

        try:
            api_key = require_tavily_api_key()
        except RuntimeError as exc:
            raise ExecutionError(
                str(exc),
                tool_name=self.name
            )

        try:
            client = TavilyClient(api_key=api_key)

            # Use extract endpoint if available
            response = client.extract(urls=[url])

            if response and "results" in response and len(response["results"]) > 0:
                result = response["results"][0]
                return {
                    "url": url,
                    "content": result.get("raw_content", ""),
                    "success": True
                }
            else:
                return {
                    "url": url,
                    "content": "",
                    "success": False,
                    "error": "Could not extract content"
                }

        except Exception as e:
            raise ExecutionError(f"Failed to fetch URL: {str(e)}", tool_name=self.name)


class WebResearchTool(MCPTool):
    """Conduct in-depth research on a topic."""

    @property
    def name(self) -> str:
        return "web_research"

    @property
    def description(self) -> str:
        return "Conduct comprehensive research on a topic with multiple searches"

    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter(
                name="topic",
                type="string",
                description="Research topic or question",
                required=True
            ),
            ToolParameter(
                name="max_results_per_search",
                type="integer",
                description="Maximum results per search query",
                required=False,
                default=5
            )
        ]

    @property
    def category(self) -> str:
        return "web"

    async def execute(
        self,
        topic: str,
        max_results_per_search: int = 5
    ) -> Dict[str, Any]:
        if not HAS_TAVILY:
            raise ExecutionError(
                "tavily-python not installed. Run: pip install tavily-python",
                tool_name=self.name
            )

        try:
            api_key = require_tavily_api_key()
        except RuntimeError as exc:
            raise ExecutionError(
                str(exc),
                tool_name=self.name
            )

        try:
            client = TavilyClient(api_key=api_key)

            # Perform advanced search
            response = client.search(
                query=topic,
                search_depth="advanced",
                max_results=max_results_per_search * 2
            )

            results = []
            for result in response.get("results", []):
                results.append({
                    "title": result.get("title"),
                    "url": result.get("url"),
                    "content": result.get("content"),
                    "score": result.get("score")
                })

            return {
                "topic": topic,
                "total_sources": len(results),
                "sources": results,
                "summary": response.get("answer"),  # AI-generated summary
            }

        except Exception as e:
            raise ExecutionError(f"Research failed: {str(e)}", tool_name=self.name)
