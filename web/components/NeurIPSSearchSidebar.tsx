import React, { useState } from 'react';
import UserProfileSettingsModal from './UserProfileSettingsModal';
import './workspaceTheme.css';

interface NeurIPSSearchSidebarProps {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onSearch: () => void;
  isSearching: boolean;
  onProfileSave?: () => void;
}

export default function NeurIPSSearchSidebar({
  searchQuery,
  onSearchQueryChange,
  onSearch,
  isSearching,
  onProfileSave,
}: NeurIPSSearchSidebarProps) {
  const [showProfileModal, setShowProfileModal] = useState(false);

  return (
    <>
      <div
        className="workspace-floating-panel"
        style={{
          position: 'absolute',
          top: '64px',
          right: '16px',
          zIndex: 5,
          width: '360px',
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'calc(100vh - 148px)',
          overflowY: 'auto',
          padding: '18px',
        }}
      >
        <div className="workspace-kicker">Search Query Sidebar</div>
        <div className="workspace-title" style={{ fontSize: '24px', marginTop: '6px' }}>Profile-guided ranking</div>
        <div className="workspace-subtle" style={{ marginTop: '6px', fontSize: '13px', lineHeight: 1.55 }}>
          Use your reading profile to rank NeurIPS results against the live conference graph.
        </div>

        <button
          onClick={() => setShowProfileModal(true)}
          className="workspace-btn-secondary"
          style={{
            width: '100%',
            marginTop: '16px',
            padding: '12px 14px',
            border: 'none',
            cursor: 'pointer',
            fontSize: '11px',
          }}
        >
          Open Profile Settings
        </button>

        <div style={{ marginTop: '18px' }}>
          <label className="workspace-section-label">Research prompt</label>
          <input
            className="workspace-input"
            type="text"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !isSearching) {
                event.preventDefault();
                onSearch();
              }
            }}
            placeholder="Ask for a method, benchmark, or theme"
            disabled={isSearching}
            style={{ padding: '14px 16px', fontSize: '14px' }}
          />
        </div>

        <div className="workspace-mobile-stack" style={{ marginTop: '14px' }}>
          <span className="workspace-pill" data-tone="accent">NeurIPS 2025</span>
          <span className="workspace-pill">Top 10 ranked</span>
          <span className="workspace-pill" data-tone="moss">Profile aware</span>
        </div>

        <button
          onClick={onSearch}
          disabled={isSearching || !searchQuery.trim()}
          className="workspace-btn"
          style={{
            width: '100%',
            marginTop: '18px',
            padding: '14px 16px',
            border: 'none',
            cursor: isSearching || !searchQuery.trim() ? 'not-allowed' : 'pointer',
            fontSize: '11px',
          }}
        >
          {isSearching ? 'Analyzing...' : 'Rank NeurIPS Papers'}
        </button>

        {isSearching && (
          <div
            className="workspace-list-card"
            style={{ marginTop: '14px', padding: '12px 14px', fontSize: '12px', color: 'rgba(22, 22, 22, 0.6)' }}
          >
            Comparing semantic relevance, trust signals, and practical fit.
          </div>
        )}
      </div>

      <UserProfileSettingsModal
        isOpen={showProfileModal}
        onClose={() => setShowProfileModal(false)}
        onSave={() => {
          setShowProfileModal(false);
          onProfileSave?.();
        }}
      />
    </>
  );
}
