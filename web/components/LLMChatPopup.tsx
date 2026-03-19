import React, { useState, useRef, useEffect } from 'react';
import { LatexDiv } from './LatexText';
import './workspaceTheme.css';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface LLMChatPopupProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function LLMChatPopup({ isOpen, onClose }: LLMChatPopupProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim() || isLoading) {
      return;
    }

    const userMessage: Message = {
      role: 'user',
      content: input.trim(),
      timestamp: Date.now(),
    };

    setMessages((current) => [...current, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage.content,
          history: messages.map((message) => ({ role: message.role, content: message.content })),
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      setMessages((current) => [
        ...current,
        {
          role: 'assistant',
          content: data.response || data.error || 'No response',
          timestamp: Date.now(),
        },
      ]);
    } catch (err) {
      setMessages((current) => [
        ...current,
        {
          role: 'assistant',
          content: `Error: ${err instanceof Error ? err.message : 'Failed to send message'}`,
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="workspace-chat-wrap">
      <div className="workspace-overlay" onClick={onClose} />
      <div
        className="workspace-chat-card"
        style={{
          position: 'relative',
          width: '680px',
          maxWidth: 'calc(100vw - 32px)',
          height: '72vh',
          maxHeight: '820px',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 1,
        }}
      >
        <div
          style={{
            padding: '18px 20px',
            borderBottom: '1px solid rgba(46, 64, 54, 0.08)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: '16px',
          }}
        >
          <div>
            <div className="workspace-kicker">LLM Chat Popup</div>
            <div className="workspace-title" style={{ fontSize: '24px', marginTop: '4px' }}>Research agent</div>
            <div className="workspace-subtle" style={{ marginTop: '4px', fontSize: '13px' }}>
              Ask for synthesis, comparisons, or next reading directions.
            </div>
          </div>
          <button
            onClick={onClose}
            className="workspace-ghost-btn workspace-dismiss-btn"
            aria-label="Close chat"
          >
            X
          </button>
        </div>

        <div className="workspace-scroll" style={{ flex: 1, padding: '18px 20px' }}>
          {messages.length === 0 && (
            <div className="workspace-empty-card workspace-list-card" style={{ margin: '32px auto 0', maxWidth: '420px' }}>
              <h3 className="workspace-title" style={{ fontSize: '24px' }}>Start a thread</h3>
              <p>Use the conference context to ask for recommendations, summaries, or grounded follow-ups.</p>
            </div>
          )}

          {messages.map((message) => (
            <div
              key={message.timestamp}
              style={{
                display: 'flex',
                justifyContent: message.role === 'user' ? 'flex-end' : 'flex-start',
                marginBottom: '12px',
              }}
            >
              <div
                className="workspace-chat-bubble"
                data-role={message.role}
                style={{
                  maxWidth: '82%',
                  padding: '14px 16px',
                  fontSize: '14px',
                  lineHeight: 1.6,
                  wordBreak: 'break-word',
                }}
              >
                <LatexDiv>{message.content}</LatexDiv>
              </div>
            </div>
          ))}

          {isLoading && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '12px' }}>
              <div className="workspace-chat-bubble" data-role="assistant" style={{ padding: '14px 16px', fontSize: '13px' }}>
                Thinking...
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <div
          style={{
            padding: '18px 20px',
            borderTop: '1px solid rgba(46, 64, 54, 0.08)',
            display: 'flex',
            gap: '12px',
          }}
        >
          <input
            ref={inputRef}
            className="workspace-input"
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Type a message..."
            disabled={isLoading}
            style={{ flex: 1, padding: '14px 16px', fontSize: '14px' }}
          />
          <button
            onClick={sendMessage}
            disabled={isLoading || !input.trim()}
            className="workspace-btn"
            style={{ minWidth: '120px', border: 'none', cursor: isLoading || !input.trim() ? 'not-allowed' : 'pointer', fontSize: '11px' }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
