import React, { useState, useEffect } from 'react';
import { getUserProfile, updateUserProfile, UserProfile } from '../lib/mcp';
import './workspaceTheme.css';

interface UserProfileSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave?: () => void;
}

export default function UserProfileSettingsModal({
  isOpen,
  onClose,
  onSave,
}: UserProfileSettingsModalProps) {
  const [profile, setProfile] = useState<Partial<UserProfile>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isOpen) {
      loadProfile();
    }
  }, [isOpen]);

  const parseCommaSeparated = (value: string): string[] => value.split(',').map((part) => part.trim()).filter(Boolean);

  const updateField = (path: string[], value: any) => {
    setProfile((current) => {
      const nextProfile = JSON.parse(JSON.stringify(current));
      let cursor: any = nextProfile;
      for (let i = 0; i < path.length - 1; i += 1) {
        if (!cursor[path[i]]) {
          cursor[path[i]] = {};
        }
        cursor = cursor[path[i]];
      }
      cursor[path[path.length - 1]] = value;
      return nextProfile;
    });
  };

  const handleInputChange = (key: string, value: string) => {
    setInputValues((current) => ({ ...current, [key]: value }));
    const parsed = parseCommaSeparated(value);

    if (key.startsWith('interests.')) {
      updateField(['interests', key.split('.')[1]], parsed);
    } else if (key === 'keywords.must_include') {
      updateField(['keywords', 'must_include'], parsed);
    } else if (key === 'keywords.exclude.hard') {
      updateField(['keywords', 'exclude', 'hard'], parsed);
    } else if (key === 'keywords.exclude.soft') {
      updateField(['keywords', 'exclude', 'soft'], parsed);
    } else if (key === 'preferred_authors') {
      updateField(['preferred_authors'], parsed.length > 0 ? parsed : []);
    } else if (key === 'preferred_institutions') {
      updateField(['preferred_institutions'], parsed.length > 0 ? parsed : []);
    }
  };

  const loadProfile = async () => {
    setLoading(true);
    setError(null);
    try {
      const loadedProfile = await getUserProfile();
      const cleanedProfile = { ...loadedProfile };
      if (Array.isArray(cleanedProfile.preferred_authors) && cleanedProfile.preferred_authors.length === 0) {
        cleanedProfile.preferred_authors = undefined;
      }
      if (Array.isArray(cleanedProfile.preferred_institutions) && cleanedProfile.preferred_institutions.length === 0) {
        cleanedProfile.preferred_institutions = undefined;
      }

      setProfile(cleanedProfile);
      setInputValues({
        'interests.primary': cleanedProfile.interests?.primary?.join(', ') || '',
        'interests.secondary': cleanedProfile.interests?.secondary?.join(', ') || '',
        'interests.exploratory': cleanedProfile.interests?.exploratory?.join(', ') || '',
        'keywords.must_include': cleanedProfile.keywords?.must_include?.join(', ') || '',
        'keywords.exclude.hard': cleanedProfile.keywords?.exclude?.hard?.join(', ') || '',
        'keywords.exclude.soft': cleanedProfile.keywords?.exclude?.soft?.join(', ') || '',
        preferred_authors: cleanedProfile.preferred_authors?.join(', ') || '',
        preferred_institutions: cleanedProfile.preferred_institutions?.join(', ') || '',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profile');
      setProfile({
        purpose: 'general',
        ranking_mode: 'balanced',
        top_k: 5,
        include_contrastive: false,
        contrastive_type: 'method',
        exclude_local_papers: false,
        interests: { primary: [], secondary: [], exploratory: [] },
        keywords: { must_include: [], exclude: { hard: [], soft: [] } },
        preferred_authors: undefined,
        preferred_institutions: undefined,
        constraints: { min_year: 2000, require_code: false, exclude_local_papers: false },
      });
      setInputValues({
        'interests.primary': '',
        'interests.secondary': '',
        'interests.exploratory': '',
        'keywords.must_include': '',
        'keywords.exclude.hard': '',
        'keywords.exclude.soft': '',
        preferred_authors: '',
        preferred_institutions: '',
      });
    } finally {
      setLoading(false);
    }
  };

  const removeUndefined = (value: any): any => {
    if (value === null || value === undefined) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(removeUndefined);
    }
    if (typeof value === 'object') {
      const nextObject: any = {};
      Object.entries(value).forEach(([key, innerValue]) => {
        if (innerValue !== undefined) {
          nextObject[key] = removeUndefined(innerValue);
        }
      });
      return nextObject;
    }
    return value;
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const cleanedProfile = JSON.parse(JSON.stringify(profile));
      if (cleanedProfile.constraints?.exclude_local_papers !== undefined) {
        cleanedProfile.exclude_local_papers = cleanedProfile.constraints.exclude_local_papers;
      }
      if (!Array.isArray(cleanedProfile.preferred_authors)) {
        cleanedProfile.preferred_authors = [];
      }
      if (!Array.isArray(cleanedProfile.preferred_institutions)) {
        cleanedProfile.preferred_institutions = [];
      }

      await updateUserProfile(removeUndefined(cleanedProfile));
      onSave?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) {
    return null;
  }

  const fieldLabelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: '6px',
    fontSize: '12px',
    color: 'rgba(22, 22, 22, 0.64)',
    fontFamily: 'JetBrains Mono, monospace',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  };

  const sectionStyle: React.CSSProperties = {
    marginBottom: '22px',
    padding: '18px',
  };

  const checkboxRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    marginTop: '12px',
    color: 'rgba(22, 22, 22, 0.72)',
    fontSize: '13px',
  };

  return (
    <div className="workspace-modal-wrap">
      <div className="workspace-overlay" onClick={onClose} />
      <div
        className="workspace-modal-card"
        style={{
          position: 'relative',
          width: '760px',
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: '88vh',
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
            <div className="workspace-kicker">User Profile Settings Modal</div>
            <div className="workspace-title" style={{ fontSize: '28px', marginTop: '4px' }}>Reader profile</div>
            <div className="workspace-subtle" style={{ marginTop: '4px', fontSize: '13px' }}>
              Adjust ranking intent, constraints, and preference signals for conference searches.
            </div>
          </div>
          <button
            onClick={onClose}
            className="workspace-ghost-btn workspace-dismiss-btn"
            aria-label="Close settings"
          >
            X
          </button>
        </div>

        <div className="workspace-scroll" style={{ flex: 1, padding: '18px 20px' }}>
          {loading ? (
            <div className="workspace-empty-card workspace-list-card" style={{ margin: '18px auto', maxWidth: '420px' }}>
              <h3 className="workspace-title" style={{ fontSize: '24px' }}>Loading profile</h3>
              <p>Fetching saved ranking preferences and constraints.</p>
            </div>
          ) : (
            <>
              {error && (
                <div
                  className="workspace-list-card"
                  style={{
                    marginBottom: '18px',
                    padding: '14px 16px',
                    background: 'rgba(204, 88, 51, 0.12)',
                    borderColor: 'rgba(204, 88, 51, 0.2)',
                    color: '#9b3c1f',
                    fontSize: '13px',
                  }}
                >
                  {error}
                </div>
              )}

              <div className="workspace-list-card" style={sectionStyle}>
                <div className="workspace-section-label">Basic Settings</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px' }}>
                  <div>
                    <label style={fieldLabelStyle}>Purpose</label>
                    <select
                      className="workspace-select"
                      value={profile.purpose || 'general'}
                      onChange={(event) => updateField(['purpose'], event.target.value)}
                      style={{ padding: '12px 14px', fontSize: '14px' }}
                    >
                      <option value="general">General</option>
                      <option value="literature_review">Literature Review</option>
                      <option value="implementation">Implementation</option>
                      <option value="idea_generation">Idea Generation</option>
                    </select>
                  </div>
                  <div>
                    <label style={fieldLabelStyle}>Ranking Mode</label>
                    <select
                      className="workspace-select"
                      value={profile.ranking_mode || 'balanced'}
                      onChange={(event) => updateField(['ranking_mode'], event.target.value)}
                      style={{ padding: '12px 14px', fontSize: '14px' }}
                    >
                      <option value="balanced">Balanced</option>
                      <option value="novelty">Novelty</option>
                      <option value="practicality">Practicality</option>
                      <option value="diversity">Diversity</option>
                    </select>
                  </div>
                  <div>
                    <label style={fieldLabelStyle}>Top K</label>
                    <input
                      className="workspace-number"
                      type="number"
                      min="1"
                      max="50"
                      value={profile.top_k || 5}
                      onChange={(event) => updateField(['top_k'], parseInt(event.target.value, 10))}
                      style={{ padding: '12px 14px', fontSize: '14px' }}
                    />
                  </div>
                  <div>
                    <label style={fieldLabelStyle}>Minimum Year</label>
                    <input
                      className="workspace-number"
                      type="number"
                      min="1900"
                      max={new Date().getFullYear()}
                      value={profile.constraints?.min_year || 2000}
                      onChange={(event) => updateField(['constraints', 'min_year'], parseInt(event.target.value, 10))}
                      style={{ padding: '12px 14px', fontSize: '14px' }}
                    />
                  </div>
                </div>

                <label style={checkboxRowStyle}>
                  <input
                    type="checkbox"
                    checked={profile.constraints?.exclude_local_papers || false}
                    onChange={(event) => updateField(['constraints', 'exclude_local_papers'], event.target.checked)}
                  />
                  Exclude local papers already downloaded to the workspace
                </label>

                <label style={checkboxRowStyle}>
                  <input
                    type="checkbox"
                    checked={profile.include_contrastive || false}
                    onChange={(event) => updateField(['include_contrastive'], event.target.checked)}
                  />
                  Include a contrastive paper in ranked results
                </label>

                {profile.include_contrastive && (
                  <div style={{ marginTop: '14px', maxWidth: '280px' }}>
                    <label style={fieldLabelStyle}>Contrastive Type</label>
                    <select
                      className="workspace-select"
                      value={profile.contrastive_type || 'method'}
                      onChange={(event) => updateField(['contrastive_type'], event.target.value)}
                      style={{ padding: '12px 14px', fontSize: '14px' }}
                    >
                      <option value="method">Method</option>
                      <option value="assumption">Assumption</option>
                      <option value="domain">Domain</option>
                    </select>
                  </div>
                )}
              </div>

              <div className="workspace-list-card" style={sectionStyle}>
                <div className="workspace-section-label">Interests</div>
                <div
                  className="workspace-list-card"
                  style={{
                    padding: '14px 16px',
                    background: 'rgba(46, 64, 54, 0.06)',
                    borderColor: 'rgba(46, 64, 54, 0.12)',
                    marginBottom: '14px',
                  }}
                >
                  <div className="workspace-kicker">Semantic weighting</div>
                  <div style={{ marginTop: '6px', fontSize: '13px', color: 'rgba(22, 22, 22, 0.66)', lineHeight: 1.65 }}>
                    Primary interests define the main research lane, secondary interests widen the neighborhood,
                    and exploratory interests let the ranker surface promising adjacent work.
                  </div>
                </div>

                {['primary', 'secondary', 'exploratory'].map((level) => (
                  <div key={level} style={{ marginBottom: '14px' }}>
                    <label style={fieldLabelStyle}>{level}</label>
                    <input
                      className="workspace-input"
                      type="text"
                      value={inputValues[`interests.${level}`] || ''}
                      onChange={(event) => handleInputChange(`interests.${level}`, event.target.value)}
                      onBlur={(event) => {
                        const parsed = parseCommaSeparated(event.target.value);
                        setInputValues((current) => ({ ...current, [`interests.${level}`]: parsed.join(', ') }));
                      }}
                      placeholder={`Enter ${level} interests`}
                      style={{ padding: '12px 14px', fontSize: '14px' }}
                    />
                  </div>
                ))}
              </div>

              <div className="workspace-list-card" style={sectionStyle}>
                <div className="workspace-section-label">Keywords</div>
                {[
                  ['keywords.must_include', 'Must Include'],
                  ['keywords.exclude.hard', 'Hard Exclude'],
                  ['keywords.exclude.soft', 'Soft Exclude'],
                ].map(([key, label]) => (
                  <div key={key} style={{ marginBottom: '14px' }}>
                    <label style={fieldLabelStyle}>{label}</label>
                    <input
                      className="workspace-input"
                      type="text"
                      value={inputValues[key] || ''}
                      onChange={(event) => handleInputChange(key, event.target.value)}
                      onBlur={(event) => {
                        const parsed = parseCommaSeparated(event.target.value);
                        setInputValues((current) => ({ ...current, [key]: parsed.join(', ') }));
                      }}
                      placeholder={`Enter ${label.toLowerCase()} keywords`}
                      style={{ padding: '12px 14px', fontSize: '14px' }}
                    />
                  </div>
                ))}
              </div>

              <div className="workspace-list-card" style={sectionStyle}>
                <div className="workspace-section-label">Preferences</div>
                {[
                  ['preferred_authors', 'Preferred Authors'],
                  ['preferred_institutions', 'Preferred Institutions'],
                ].map(([key, label]) => (
                  <div key={key} style={{ marginBottom: '14px' }}>
                    <label style={fieldLabelStyle}>{label}</label>
                    <input
                      className="workspace-input"
                      type="text"
                      value={inputValues[key] || ''}
                      onChange={(event) => handleInputChange(key, event.target.value)}
                      onBlur={(event) => {
                        const parsed = parseCommaSeparated(event.target.value);
                        setInputValues((current) => ({ ...current, [key]: parsed.join(', ') }));
                      }}
                      placeholder={`Enter ${label.toLowerCase()}`}
                      style={{ padding: '12px 14px', fontSize: '14px' }}
                    />
                  </div>
                ))}
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
          }}
        >
          <button
            onClick={onClose}
            disabled={saving}
            className="workspace-btn-secondary"
            style={{ border: 'none', padding: '12px 16px', cursor: saving ? 'not-allowed' : 'pointer', fontSize: '11px' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className="workspace-btn"
            style={{ border: 'none', padding: '12px 16px', cursor: saving || loading ? 'not-allowed' : 'pointer', fontSize: '11px' }}
          >
            {saving ? 'Saving...' : 'Save Profile'}
          </button>
        </div>
      </div>
    </div>
  );
}
