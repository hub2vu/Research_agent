"""
Notification Tools

Slack (Webhook) and Discord (Webhook) notification tools for sending reports.
"""

import logging
import os
from typing import Any, Dict, List, Optional

import httpx

from ..base import MCPTool, ToolParameter, ExecutionError
from runtime.service_config import (
    get_discord_webhook_full,
    get_discord_webhook_summary,
)

logger = logging.getLogger("mcp.tools.notification")
logger.setLevel(logging.INFO)


class SendSlackNotificationTool(MCPTool):
    """
    Send notifications to Slack via Incoming Webhook.
    
    To set up:
    1. Go to your Slack workspace's App settings
    2. Create a new app or use existing one
    3. Enable "Incoming Webhooks"
    4. Create a webhook URL for your channel
    5. Set SLACK_WEBHOOK_URL environment variable (or pass directly)
    """
    
    @property
    def name(self) -> str:
        return "send_slack_notification"
    
    @property
    def description(self) -> str:
        return (
            "Send a notification to Slack via Incoming Webhook. "
            "Supports basic Slack message formatting (mrkdwn)."
        )
    
    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter(
                name="message",
                type="string",
                description="Message to send (supports Slack mrkdwn formatting)",
                required=True
            ),
            ToolParameter(
                name="webhook_url",
                type="string",
                description="Slack Incoming Webhook URL. If not provided, uses SLACK_WEBHOOK_URL env var.",
                required=False,
                default=""
            ),
            ToolParameter(
                name="channel",
                type="string",
                description="Override channel (optional, webhook default is used if not specified)",
                required=False,
                default=""
            ),
            ToolParameter(
                name="username",
                type="string",
                description="Bot username to display",
                required=False,
                default="Research Agent"
            ),
            ToolParameter(
                name="icon_emoji",
                type="string",
                description="Emoji icon for the bot (e.g., ':robot_face:')",
                required=False,
                default=":books:"
            )
        ]
    
    @property
    def category(self) -> str:
        return "notification"
    
    async def execute(
        self,
        message: str,
        webhook_url: str = "",
        channel: str = "",
        username: str = "Research Agent",
        icon_emoji: str = ":books:",
        **kwargs
    ) -> Dict[str, Any]:
        """Send message to Slack via webhook."""
        
        # Get webhook URL
        url = webhook_url or os.environ.get("SLACK_WEBHOOK_URL", "")
        
        if not url:
            raise ExecutionError(
                "Slack webhook URL not configured. "
                "Provide webhook_url parameter or set SLACK_WEBHOOK_URL environment variable.",
                tool_name=self.name
            )
        
        # Validate URL format
        if not url.startswith("https://hooks.slack.com/"):
            raise ExecutionError(
                "Invalid Slack webhook URL. Must start with 'https://hooks.slack.com/'",
                tool_name=self.name
            )
        
        # Slack has a message length limit (4000 characters for text field)
        # Split long messages into chunks if needed
        max_length = 3500  # Leave some buffer
        if len(message) > max_length:
            # Split by newlines and try to keep chunks under limit
            chunks = []
            current_chunk = ""
            
            for line in message.split('\n'):
                if len(current_chunk) + len(line) + 1 > max_length:
                    if current_chunk:
                        chunks.append(current_chunk)
                    current_chunk = line
                else:
                    current_chunk += '\n' + line if current_chunk else line
            
            if current_chunk:
                chunks.append(current_chunk)
        else:
            chunks = [message]
        
        # Send all chunks
        results = []
        for i, chunk in enumerate(chunks):
            payload = {
                "text": chunk,
                "username": username,
                "icon_emoji": icon_emoji,
                "mrkdwn": True
            }
            
            if channel:
                payload["channel"] = channel
            
            # Add chunk indicator if multiple chunks
            if len(chunks) > 1:
                payload["text"] = f"*[Part {i + 1}/{len(chunks)}]*\n\n{chunk}"
            
            try:
                async with httpx.AsyncClient() as client:
                    response = await client.post(
                        url,
                        json=payload,
                        headers={"Content-Type": "application/json"},
                        timeout=30.0
                    )
                    
                    if response.status_code == 200 and response.text == "ok":
                        logger.info(f"Slack notification chunk {i + 1}/{len(chunks)} sent successfully")
                        results.append({"success": True, "chunk": i + 1})
                    else:
                        raise ExecutionError(
                            f"Slack API error: {response.status_code} - {response.text}",
                            tool_name=self.name
                        )
                        
            except httpx.TimeoutException:
                raise ExecutionError(
                    "Slack webhook request timed out",
                    tool_name=self.name
                )
            except httpx.RequestError as e:
                raise ExecutionError(
                    f"Failed to send Slack notification: {str(e)}",
                    tool_name=self.name
                )
        
        return {
            "success": True,
            "message": f"Notification sent to Slack ({len(chunks)} chunk(s))",
            "channel": channel or "(webhook default)",
            "chunks_sent": len(chunks)
        }


# =============================================================================
# Discord Notification Tool
# =============================================================================

class SendDiscordNotificationTool(MCPTool):
    """
    Send notifications to Discord via Webhook.
    
    To set up:
    1. Go to your Discord server settings
    2. Integrations → Webhooks → New Webhook
    3. Copy the webhook URL
    4. Save a Discord webhook in the local settings UI or pass one directly
    
    Discord supports full markdown formatting and threads.
    """
    
    @property
    def name(self) -> str:
        return "send_discord_notification"
    
    @property
    def description(self) -> str:
        return (
            "Send a notification to Discord via Webhook. "
            "Supports full markdown formatting and thread creation."
        )
    
    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter(
                name="message",
                type="string",
                description="Message to send (supports Discord markdown formatting)",
                required=True
            ),
            ToolParameter(
                name="webhook_url",
                type="string",
                description="Discord Webhook URL. If not provided, uses the locally saved Discord webhook setting.",
                required=False,
                default=""
            ),
            ToolParameter(
                name="username",
                type="string",
                description="Bot username to display",
                required=False,
                default="Research Agent"
            ),
            ToolParameter(
                name="thread_name",
                type="string",
                description="Create a thread with this name (optional). If provided, message will be sent in a thread.",
                required=False,
                default=""
            ),
            ToolParameter(
                name="thread_id",
                type="string",
                description="Send message to existing thread (optional). If provided, message will be sent to this thread.",
                required=False,
                default=""
            )
        ]
    
    @property
    def category(self) -> str:
        return "notification"
    
    async def execute(
        self,
        message: str,
        webhook_url: str = "",
        username: str = "Research Agent",
        thread_name: str = "",
        thread_id: str = "",
        **kwargs
    ) -> Dict[str, Any]:
        """Send message to Discord via webhook."""
        
        # Get webhook URL
        url = webhook_url or get_discord_webhook_full() or get_discord_webhook_summary()
        
        if not url:
            raise ExecutionError(
                "Discord webhook URL not configured. "
                "Provide webhook_url parameter or save a Discord webhook in the local settings UI.",
                tool_name=self.name
            )
        
        # Validate URL format
        if not url.startswith("https://discord.com/api/webhooks/") and not url.startswith("https://discordapp.com/api/webhooks/"):
            raise ExecutionError(
                "Invalid Discord webhook URL. Must start with 'https://discord.com/api/webhooks/'",
                tool_name=self.name
            )
        
        # Discord has a message length limit (2000 characters per message)
        # Split long messages into chunks if needed
        max_length = 1900  # Leave some buffer
        chunks = []
        
        if len(message) > max_length:
            # Split by newlines and try to keep chunks under limit
            current_chunk = ""
            
            for line in message.split('\n'):
                if len(current_chunk) + len(line) + 1 > max_length:
                    if current_chunk:
                        chunks.append(current_chunk)
                    current_chunk = line
                else:
                    current_chunk += '\n' + line if current_chunk else line
            
            if current_chunk:
                chunks.append(current_chunk)
        else:
            chunks = [message]
        
        # Prepare base URL
        base_url = url
        if thread_id:
            # Add thread_id as query parameter for existing thread
            separator = "&" if "?" in base_url else "?"
            base_url = f"{base_url}{separator}thread_id={thread_id}"
        
        # Send all chunks
        results = []
        thread_created = False
        
        for i, chunk in enumerate(chunks):
            payload = {
                "content": chunk,
                "username": username
            }
            
            # Create thread on first message if thread_name is provided
            if i == 0 and thread_name and not thread_id:
                payload["thread_name"] = thread_name
                thread_created = True
            
            # Add chunk indicator if multiple chunks
            if len(chunks) > 1:
                payload["content"] = f"**[Part {i + 1}/{len(chunks)}]**\n\n{chunk}"
            
            try:
                async with httpx.AsyncClient() as client:
                    response = await client.post(
                        base_url,
                        json=payload,
                        headers={"Content-Type": "application/json"},
                        timeout=30.0
                    )
                    
                    if response.status_code == 204:
                        logger.info(f"Discord notification chunk {i + 1}/{len(chunks)} sent successfully")
                        results.append({"success": True, "chunk": i + 1})
                    elif response.status_code == 429:
                        # Rate limited
                        retry_after = float(response.headers.get("Retry-After", 1))
                        raise ExecutionError(
                            f"Discord rate limited. Retry after {retry_after} seconds",
                            tool_name=self.name
                        )
                    else:
                        error_text = response.text[:500] if response.text else "Unknown error"
                        raise ExecutionError(
                            f"Discord API error: {response.status_code} - {error_text}",
                            tool_name=self.name
                        )
                        
            except httpx.TimeoutException:
                raise ExecutionError(
                    "Discord webhook request timed out",
                    tool_name=self.name
                )
            except httpx.RequestError as e:
                raise ExecutionError(
                    f"Failed to send Discord notification: {str(e)}",
                    tool_name=self.name
                )
        
        return {
            "success": True,
            "message": f"Notification sent to Discord ({len(chunks)} chunk(s))",
            "chunks_sent": len(chunks),
            "thread_created": thread_created
        }


# =============================================================================
# Test Notification Tool (for verifying setup)
# =============================================================================

class TestNotificationsTool(MCPTool):
    """Test Slack and Discord notification setup."""
    
    @property
    def name(self) -> str:
        return "test_notifications"
    
    @property
    def description(self) -> str:
        return "Test Slack and Discord notification configuration by sending test messages."
    
    @property
    def parameters(self) -> List[ToolParameter]:
        return [
            ToolParameter(
                name="slack_webhook_full",
                type="string",
                description="Slack webhook URL for full report channel (optional)",
                required=False,
                default=""
            ),
            ToolParameter(
                name="slack_webhook_summary",
                type="string",
                description="Slack webhook URL for summary channel (optional)",
                required=False,
                default=""
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
                description="Discord webhook URL for summary channel (optional)",
                required=False,
                default=""
            )
        ]
    
    @property
    def category(self) -> str:
        return "notification"
    
    async def execute(
        self,
        slack_webhook_full: str = "",
        slack_webhook_summary: str = "",
        discord_webhook_full: str = "",
        discord_webhook_summary: str = "",
        **kwargs
    ) -> Dict[str, Any]:
        """Test notification channels."""
        
        results = {
            "slack_full": None,
            "slack_summary": None,
            "discord_full": None,
            "discord_summary": None
        }
        
        # Test Slack full report channel
        if slack_webhook_full:
            slack_tool = SendSlackNotificationTool()
            try:
                result = await slack_tool.execute(
                    webhook_url=slack_webhook_full,
                    message="🧪 *Test Notification - Full Report Channel*\n\nThis is a test message from Research Agent.\n\n✅ Full report channel configuration is working correctly!"
                )
                results["slack_full"] = {"success": True, "message": "Test message sent to full report channel"}
            except Exception as e:
                results["slack_full"] = {"success": False, "error": str(e)}
        
        # Test Slack summary channel
        if slack_webhook_summary:
            slack_tool = SendSlackNotificationTool()
            try:
                result = await slack_tool.execute(
                    webhook_url=slack_webhook_summary,
                    message="🧪 *Test Notification - Summary Channel*\n\nThis is a test message from Research Agent.\n\n✅ Summary channel configuration is working correctly!"
                )
                results["slack_summary"] = {"success": True, "message": "Test message sent to summary channel"}
            except Exception as e:
                results["slack_summary"] = {"success": False, "error": str(e)}
        
        # Test Discord full report channel
        if discord_webhook_full:
            discord_tool = SendDiscordNotificationTool()
            try:
                result = await discord_tool.execute(
                    webhook_url=discord_webhook_full,
                    message="🧪 **Test Notification - Full Report Channel**\n\nThis is a test message from Research Agent.\n\n✅ Full report channel configuration is working correctly!",
                    thread_name="Test Report"
                )
                results["discord_full"] = {"success": True, "message": "Test message sent to full report channel (as thread)"}
            except Exception as e:
                results["discord_full"] = {"success": False, "error": str(e)}
        
        # Test Discord summary channel
        if discord_webhook_summary:
            discord_tool = SendDiscordNotificationTool()
            try:
                result = await discord_tool.execute(
                    webhook_url=discord_webhook_summary,
                    message="🧪 **Test Notification - Summary Channel**\n\nThis is a test message from Research Agent.\n\n✅ Summary channel configuration is working correctly!"
                )
                results["discord_summary"] = {"success": True, "message": "Test message sent to summary channel"}
            except Exception as e:
                results["discord_summary"] = {"success": False, "error": str(e)}
        
        # Check environment variables
        env_status = {
            "SLACK_WEBHOOK_URL": "✅ Set" if os.environ.get("SLACK_WEBHOOK_URL") else "❌ Not set",
            "DISCORD_WEBHOOK_FULL": "✅ Set" if get_discord_webhook_full() else "❌ Not set",
            "DISCORD_WEBHOOK_SUMMARY": "✅ Set" if get_discord_webhook_summary() else "❌ Not set"
        }
        
        return {
            "test_results": results,
            "environment_status": env_status
        }
