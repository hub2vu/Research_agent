import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, KeyRound, Link2, Unplug } from 'lucide-react';
import {
  buildNotionOAuthUrl,
  disconnectNotion,
  getNotionStatus,
  getServiceCredentials,
  type NotionConnectionStatus,
  updateServiceCredentials,
} from '../lib/mcp';
import './workspaceTheme.css';

interface AccountSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave?: () => void;
}

type FieldName = 'openai_api_key' | 'tavily_api_key';

const fieldMeta: Array<{
  name: FieldName;
  label: string;
  placeholder: string;
  description: string;
  secret: boolean;
}> = [
  {
    name: 'openai_api_key',
    label: 'OpenAI API Key',
    placeholder: 'sk-...',
    description: 'Required for agent reasoning, translation, reporting, and chat.',
    secret: true,
  },
  {
    name: 'tavily_api_key',
    label: 'Tavily API Key',
    placeholder: 'tvly-...',
    description: 'Optional. Used when web search tools need live search results.',
    secret: true,
  },
];

const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: '6px',
  fontSize: '12px',
  color: 'rgba(22, 22, 22, 0.64)',
  fontFamily: 'JetBrains Mono, monospace',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};

const helperTextStyle: React.CSSProperties = {
  marginTop: '8px',
  color: 'rgba(22, 22, 22, 0.58)',
  fontSize: '12px',
  lineHeight: 1.6,
};

const sectionCardStyle: React.CSSProperties = {
  marginBottom: '18px',
  padding: '18px',
};

const messageCardStyle: React.CSSProperties = {
  marginBottom: '14px',
  padding: '12px 14px',
  fontSize: '13px',
  lineHeight: 1.6,
};

export default function AccountSettingsModal({
  isOpen,
  onClose,
  onSave,
}: AccountSettingsModalProps) {
  const [form, setForm] = useState<Record<FieldName, string>>({
    openai_api_key: '',
    tavily_api_key: '',
  });
  const [visible, setVisible] = useState<Record<FieldName, boolean>>({
    openai_api_key: false,
    tavily_api_key: false,
  });
  const [notionStatus, setNotionStatus] = useState<NotionConnectionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [connectingNotion, setConnectingNotion] = useState(false);
  const [disconnectingNotion, setDisconnectingNotion] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [settingsPath, setSettingsPath] = useState<string>('');

  const notionStatusLabel = useMemo(() => {
    if (!notionStatus?.connected) {
      return 'Disconnected';
    }
    return notionStatus.workspace_name ? `Connected to ${notionStatus.workspace_name}` : 'Connected';
  }, [notionStatus]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [credentials, notion] = await Promise.all([
        getServiceCredentials(),
        getNotionStatus(),
      ]);
      setForm({
        openai_api_key: credentials.openai_api_key,
        tavily_api_key: credentials.tavily_api_key,
      });
      setNotionStatus(notion);
      setSettingsPath(credentials.settings_path || notion.settings_path || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load account settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    void loadSettings();
  }, [isOpen, loadSettings]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }
      const data = event.data;
      if (!data || data.type !== 'notion-oauth-complete') {
        return;
      }
      setConnectingNotion(false);
      if (data.success) {
        setSavedMessage(data.message || 'Notion connected.');
        setError(null);
        void loadSettings();
        onSave?.();
        return;
      }
      setError(data.message || 'Failed to connect Notion.');
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [isOpen, loadSettings, onSave]);

  const handleChange = (field: FieldName, value: string) => {
    setSavedMessage(null);
    setForm(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSavedMessage(null);
    try {
      const result = await updateServiceCredentials(form);
      setForm({
        openai_api_key: result.openai_api_key,
        tavily_api_key: result.tavily_api_key,
      });
      setSettingsPath(result.settings_path || '');
      setSavedMessage('Saved to local runtime settings.');
      onSave?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save service credentials');
    } finally {
      setSaving(false);
    }
  };

  const handleConnectNotion = () => {
    setError(null);
    setSavedMessage(null);
    setConnectingNotion(true);
    const popup = window.open(
      buildNotionOAuthUrl(`${window.location.origin}/api`, window.location.origin),
      'notion-oauth',
      'width=560,height=760,resizable=yes,scrollbars=yes'
    );

    if (!popup) {
      setConnectingNotion(false);
      setError('Popup was blocked. Allow popups for this site and try again.');
      return;
    }

    popup.focus();
    const pollTimer = window.setInterval(() => {
      if (!popup.closed) {
        return;
      }
      window.clearInterval(pollTimer);
      setConnectingNotion(false);
    }, 500);
  };

  const handleDisconnectNotion = async () => {
    setDisconnectingNotion(true);
    setError(null);
    setSavedMessage(null);
    try {
      await disconnectNotion();
      await loadSettings();
      setSavedMessage('Notion connection removed from local runtime settings.');
      onSave?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect Notion');
    } finally {
      setDisconnectingNotion(false);
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="workspace-modal-wrap" style={{ zIndex: 1100 }}>
      <div className="workspace-overlay" />
      <div
        className="workspace-modal-card"
        style={{
          position: 'relative',
          width: '720px',
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 1,
          background:
            'linear-gradient(180deg, rgba(255, 255, 255, 0.88), rgba(242, 240, 233, 0.82))',
        }}
      >
        <div
          style={{
            padding: '18px 20px',
            borderBottom: '1px solid rgba(46, 64, 54, 0.08)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '16px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
            <div
              style={{
                width: '42px',
                height: '42px',
                borderRadius: '50%',
                background: 'rgba(204, 88, 51, 0.12)',
                border: '1px solid rgba(204, 88, 51, 0.16)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#9b3c1f',
                flexShrink: 0,
              }}
            >
              <KeyRound size={18} />
            </div>
            <div>
              <div className="workspace-kicker">Local runtime settings</div>
              <div className="workspace-title" style={{ marginTop: '4px', fontSize: '28px' }}>
                Account
              </div>
              <div
                className="workspace-subtle"
                style={{ marginTop: '4px', fontSize: '13px', lineHeight: 1.6 }}
              >
                Manage API credentials and the Notion OAuth connection used by the local MCP
                runtime.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="workspace-ghost-btn workspace-dismiss-btn"
            aria-label="Close account settings"
          >
            X
          </button>
        </div>

        <div className="workspace-scroll" style={{ flex: 1, padding: '18px 20px' }}>
          <div
            className="workspace-list-card"
            style={{
              ...sectionCardStyle,
              background:
                'linear-gradient(180deg, rgba(255, 255, 255, 0.7), rgba(242, 240, 233, 0.84))',
            }}
          >
            <div className="workspace-kicker">Storage</div>
            <div
              style={{ marginTop: '6px', color: 'rgba(22, 22, 22, 0.72)', fontSize: '13px', lineHeight: 1.7 }}
            >
              Keys and Notion OAuth state are stored locally and read at runtime by the MCP server
              and agent. Restart is not required after saving.
            </div>
            {settingsPath ? (
              <div
                style={{
                  marginTop: '10px',
                  padding: '10px 12px',
                  borderRadius: '16px',
                  border: '1px solid rgba(46, 64, 54, 0.12)',
                  background: 'rgba(255, 255, 255, 0.58)',
                  color: 'rgba(46, 64, 54, 0.82)',
                  fontSize: '12px',
                  fontFamily: 'JetBrains Mono, monospace',
                  wordBreak: 'break-all',
                }}
              >
                {settingsPath}
              </div>
            ) : null}
          </div>

          {loading ? (
            <div
              className="workspace-empty-card workspace-list-card"
              style={{ margin: '18px auto', maxWidth: '420px' }}
            >
              <h3 className="workspace-title" style={{ fontSize: '24px' }}>Loading account</h3>
              <p>Fetching local credentials and Notion connection state.</p>
            </div>
          ) : (
            <>
              {error ? (
                <div
                  className="workspace-list-card"
                  style={{
                    ...messageCardStyle,
                    background: 'rgba(204, 88, 51, 0.12)',
                    borderColor: 'rgba(204, 88, 51, 0.2)',
                    color: '#9b3c1f',
                  }}
                >
                  {error}
                </div>
              ) : null}

              {savedMessage ? (
                <div
                  className="workspace-list-card"
                  style={{
                    ...messageCardStyle,
                    background: 'rgba(46, 64, 54, 0.11)',
                    borderColor: 'rgba(46, 64, 54, 0.18)',
                    color: '#2e4036',
                  }}
                >
                  {savedMessage}
                </div>
              ) : null}

              <div className="workspace-list-card" style={sectionCardStyle}>
                <div className="workspace-section-label">Credentials</div>
                <div style={{ display: 'grid', gap: '14px' }}>
                  {fieldMeta.map(field => {
                    const isVisible = visible[field.name];
                    return (
                      <div
                        key={field.name}
                        style={{
                          padding: '16px',
                          borderRadius: '22px',
                          border: '1px solid rgba(46, 64, 54, 0.1)',
                          background: 'rgba(255, 255, 255, 0.56)',
                        }}
                      >
                        <label htmlFor={field.name} style={fieldLabelStyle}>
                          {field.label}
                        </label>
                        <div style={{ position: 'relative' }}>
                          <input
                            id={field.name}
                            className="workspace-input"
                            type={!isVisible ? 'password' : 'text'}
                            value={form[field.name]}
                            onChange={(event) => handleChange(field.name, event.target.value)}
                            placeholder={field.placeholder}
                            autoComplete="off"
                            spellCheck={false}
                            style={{
                              padding: '13px 50px 13px 14px',
                              fontSize: '14px',
                              boxSizing: 'border-box',
                            }}
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setVisible(prev => ({ ...prev, [field.name]: !prev[field.name] }))
                            }
                            aria-label={isVisible ? `Hide ${field.label}` : `Show ${field.label}`}
                            className="workspace-ghost-btn"
                            style={{
                              position: 'absolute',
                              top: '50%',
                              right: '8px',
                              transform: 'translateY(-50%)',
                              width: '36px',
                              height: '36px',
                              borderRadius: '50%',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              padding: 0,
                              borderColor: 'transparent',
                            }}
                          >
                            {isVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                          </button>
                        </div>
                        <div style={helperTextStyle}>{field.description}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="workspace-list-card" style={sectionCardStyle}>
                <div className="workspace-section-label">Notion</div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: '12px',
                    flexWrap: 'wrap',
                    marginBottom: '14px',
                  }}
                >
                  <div style={{ flex: '1 1 260px' }}>
                    <div className="workspace-title" style={{ fontSize: '22px' }}>
                      Workspace connection
                    </div>
                    <div
                      className="workspace-subtle"
                      style={{ marginTop: '6px', fontSize: '13px', lineHeight: 1.65 }}
                    >
                      Connect through the hosted Notion MCP OAuth flow. Tokens remain in local
                      runtime settings and refresh server-side.
                    </div>
                  </div>
                  <div
                    className="workspace-pill"
                    data-tone={notionStatus?.connected ? 'moss' : 'accent'}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    {notionStatusLabel}
                  </div>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                    gap: '12px',
                    marginBottom: '16px',
                  }}
                >
                  <div
                    style={{
                      padding: '14px 16px',
                      borderRadius: '18px',
                      background: 'rgba(255, 255, 255, 0.58)',
                      border: '1px solid rgba(46, 64, 54, 0.1)',
                    }}
                  >
                    <div style={fieldLabelStyle}>Workspace</div>
                    <div style={{ color: 'rgba(22, 22, 22, 0.76)', fontSize: '14px', lineHeight: 1.5 }}>
                      {notionStatus?.workspace_name || 'Not connected'}
                    </div>
                  </div>
                  <div
                    style={{
                      padding: '14px 16px',
                      borderRadius: '18px',
                      background: 'rgba(255, 255, 255, 0.58)',
                      border: '1px solid rgba(46, 64, 54, 0.1)',
                    }}
                  >
                    <div style={fieldLabelStyle}>Connected at</div>
                    <div style={{ color: 'rgba(22, 22, 22, 0.76)', fontSize: '14px', lineHeight: 1.5 }}>
                      {notionStatus?.connected_at || '-'}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={handleConnectNotion}
                    disabled={connectingNotion}
                    className="workspace-btn"
                    style={{
                      border: 'none',
                      padding: '12px 16px',
                      fontSize: '11px',
                      cursor: connectingNotion ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      justifyContent: 'center',
                      flex: '1 1 220px',
                    }}
                  >
                    <Link2 size={16} />
                    {connectingNotion
                      ? 'Connecting...'
                      : notionStatus?.connected
                        ? 'Reconnect Notion'
                        : 'Connect Notion'}
                  </button>
                  <button
                    type="button"
                    onClick={handleDisconnectNotion}
                    disabled={!notionStatus?.connected || disconnectingNotion}
                    className="workspace-btn-secondary"
                    style={{
                      border: '1px solid rgba(46, 64, 54, 0.15)',
                      padding: '12px 16px',
                      color: notionStatus?.connected ? '#2e4036' : 'rgba(22, 22, 22, 0.38)',
                      fontSize: '11px',
                      cursor:
                        !notionStatus?.connected || disconnectingNotion
                          ? 'not-allowed'
                          : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      justifyContent: 'center',
                      flex: '1 1 220px',
                    }}
                  >
                    <Unplug size={16} />
                    {disconnectingNotion ? 'Disconnecting...' : 'Disconnect'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        <div
          style={{
            padding: '18px 20px',
            borderTop: '1px solid rgba(46, 64, 54, 0.08)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '10px',
            flexWrap: 'wrap-reverse',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="workspace-btn-secondary"
            style={{
              border: 'none',
              padding: '12px 16px',
              cursor: saving ? 'not-allowed' : 'pointer',
              fontSize: '11px',
              flex: '1 1 160px',
            }}
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loading}
            className="workspace-btn"
            style={{
              border: 'none',
              padding: '12px 16px',
              cursor: saving || loading ? 'not-allowed' : 'pointer',
              fontSize: '11px',
              flex: '1 1 200px',
            }}
          >
            {saving ? 'Saving...' : 'Save Keys'}
          </button>
        </div>
      </div>
    </div>
  );
}
