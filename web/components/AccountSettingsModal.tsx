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
    <div style={{
      position: 'fixed',
      inset: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.55)',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 1100,
      padding: '20px',
    }}>
      <div style={{
        width: '680px',
        maxWidth: '95vw',
        maxHeight: '90vh',
        backgroundColor: '#1a202c',
        borderRadius: '16px',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid #2d3748',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '38px',
              height: '38px',
              borderRadius: '50%',
              backgroundColor: '#2d3748',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#f6ad55',
            }}>
              <KeyRound size={18} />
            </div>
            <div>
              <h2 style={{ margin: 0, color: '#fff', fontSize: '18px' }}>Account Settings</h2>
              <div style={{ color: '#a0aec0', fontSize: '12px', marginTop: '2px' }}>
                Manage API credentials and the local Notion connection state.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: '#a0aec0',
              fontSize: '24px',
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            &times;
          </button>
        </div>

        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '20px',
        }}>
          <div style={{
            marginBottom: '18px',
            padding: '12px 14px',
            backgroundColor: '#2d3748',
            border: '1px solid #4a5568',
            borderRadius: '10px',
            color: '#cbd5e0',
            fontSize: '12px',
            lineHeight: 1.6,
          }}>
            Keys and Notion OAuth state are stored locally and read at runtime by the MCP server and agent. Restart is not required after saving.
            {settingsPath ? (
              <div style={{ marginTop: '6px', color: '#90cdf4', wordBreak: 'break-all' }}>
                {settingsPath}
              </div>
            ) : null}
          </div>

          {loading ? (
            <div style={{ color: '#a0aec0', textAlign: 'center', padding: '48px 0' }}>
              Loading account settings...
            </div>
          ) : (
            <>
              {error ? (
                <div style={{
                  marginBottom: '14px',
                  backgroundColor: 'rgba(245,101,101,0.18)',
                  color: '#feb2b2',
                  padding: '12px 14px',
                  borderRadius: '8px',
                  border: '1px solid rgba(245,101,101,0.5)',
                }}>
                  {error}
                </div>
              ) : null}

              {savedMessage ? (
                <div style={{
                  marginBottom: '14px',
                  backgroundColor: 'rgba(72,187,120,0.15)',
                  color: '#9ae6b4',
                  padding: '12px 14px',
                  borderRadius: '8px',
                  border: '1px solid rgba(72,187,120,0.45)',
                }}>
                  {savedMessage}
                </div>
              ) : null}

              {fieldMeta.map(field => {
                const isVisible = visible[field.name];
                return (
                  <div key={field.name} style={{ marginBottom: '18px' }}>
                    <label style={{
                      display: 'block',
                      color: '#e2e8f0',
                      fontSize: '13px',
                      fontWeight: 600,
                      marginBottom: '8px',
                    }}>
                      {field.label}
                    </label>
                    <div style={{ position: 'relative' }}>
                      <input
                        type={!isVisible ? 'password' : 'text'}
                        value={form[field.name]}
                        onChange={(event) => handleChange(field.name, event.target.value)}
                        placeholder={field.placeholder}
                        autoComplete="off"
                        spellCheck={false}
                        style={{
                          width: '100%',
                          padding: '12px 52px 12px 14px',
                          borderRadius: '10px',
                          border: '1px solid #2d3748',
                          backgroundColor: '#2d3748',
                          color: '#fff',
                          fontSize: '14px',
                          outline: 'none',
                          boxSizing: 'border-box',
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setVisible(prev => ({ ...prev, [field.name]: !prev[field.name] }))}
                        style={{
                          position: 'absolute',
                          top: '50%',
                          right: '12px',
                          transform: 'translateY(-50%)',
                          background: 'none',
                          border: 'none',
                          color: '#a0aec0',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: 0,
                        }}
                      >
                        {isVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                    <div style={{
                      marginTop: '6px',
                      color: '#718096',
                      fontSize: '12px',
                      lineHeight: 1.5,
                    }}>
                      {field.description}
                    </div>
                  </div>
                );
              })}

              <div style={{
                marginTop: '12px',
                padding: '16px',
                borderRadius: '12px',
                border: '1px solid #2d3748',
                backgroundColor: '#111827',
              }}>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: '12px',
                  marginBottom: '12px',
                }}>
                  <div>
                    <div style={{ color: '#f7fafc', fontSize: '15px', fontWeight: 600 }}>
                      Notion
                    </div>
                    <div style={{ color: '#94a3b8', fontSize: '12px', marginTop: '4px', lineHeight: 1.6 }}>
                      Connect through the hosted Notion MCP OAuth flow. Tokens stay in the local runtime settings and are refreshed server-side.
                    </div>
                  </div>
                  <div style={{
                    padding: '6px 10px',
                    borderRadius: '999px',
                    fontSize: '12px',
                    fontWeight: 600,
                    backgroundColor: notionStatus?.connected ? 'rgba(72,187,120,0.18)' : 'rgba(160,174,192,0.14)',
                    color: notionStatus?.connected ? '#9ae6b4' : '#cbd5e0',
                    whiteSpace: 'nowrap',
                  }}>
                    {notionStatusLabel}
                  </div>
                </div>

                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: '10px',
                  marginBottom: '14px',
                }}>
                  <div style={{ color: '#cbd5e0', fontSize: '12px', lineHeight: 1.6 }}>
                    <div style={{ color: '#718096' }}>Workspace</div>
                    <div>{notionStatus?.workspace_name || 'Not connected'}</div>
                  </div>
                  <div style={{ color: '#cbd5e0', fontSize: '12px', lineHeight: 1.6 }}>
                    <div style={{ color: '#718096' }}>Connected At</div>
                    <div>{notionStatus?.connected_at || '-'}</div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={handleConnectNotion}
                    disabled={connectingNotion}
                    style={{
                      padding: '10px 16px',
                      borderRadius: '8px',
                      border: 'none',
                      backgroundColor: '#2b6cb0',
                      color: '#fff',
                      fontSize: '14px',
                      cursor: connectingNotion ? 'not-allowed' : 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <Link2 size={16} />
                    {connectingNotion ? 'Connecting...' : notionStatus?.connected ? 'Reconnect Notion' : 'Connect Notion'}
                  </button>
                  <button
                    type="button"
                    onClick={handleDisconnectNotion}
                    disabled={!notionStatus?.connected || disconnectingNotion}
                    style={{
                      padding: '10px 16px',
                      borderRadius: '8px',
                      border: '1px solid #4a5568',
                      backgroundColor: 'transparent',
                      color: notionStatus?.connected ? '#fed7d7' : '#718096',
                      fontSize: '14px',
                      cursor: !notionStatus?.connected || disconnectingNotion ? 'not-allowed' : 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
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

        <div style={{
          padding: '16px 20px',
          borderTop: '1px solid #2d3748',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '10px',
        }}>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              padding: '10px 18px',
              borderRadius: '8px',
              border: '1px solid #4a5568',
              backgroundColor: 'transparent',
              color: '#cbd5e0',
              fontSize: '14px',
              cursor: saving ? 'not-allowed' : 'pointer',
            }}
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loading}
            style={{
              padding: '10px 18px',
              borderRadius: '8px',
              border: 'none',
              backgroundColor: saving ? '#4a5568' : '#f6ad55',
              color: '#1a202c',
              fontSize: '14px',
              fontWeight: 600,
              cursor: saving || loading ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? 'Saving...' : 'Save Keys'}
          </button>
        </div>
      </div>
    </div>
  );
}
