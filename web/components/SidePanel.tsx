import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GraphNode } from '../lib/mcp';
import PaperCard from './PaperCard';
import ReportViewer from './ReportViewer';
import './workspaceTheme.css';

function nodeKeyOf(node: any): string {
  return String(node?.stableKey ?? node?.id ?? '');
}

function stripNotePrefix(id: string): string {
  return String(id ?? '').replace(/^(paper:|ref:)/i, '');
}

function extractArxivId(raw: string): string | null {
  if (!raw) {
    return null;
  }

  let value = String(raw).trim();
  const urlMatch = value.match(/arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?/i);
  if (urlMatch?.[1]) {
    value = urlMatch[1];
  }

  value = value.replace(/^arxiv:\s*/i, '');
  value = value.replace(/^10\.48550[_/]arxiv\./i, '');

  if (/^[a-z\-]+_[A-Z]{2}_\d{7}(v\d+)?$/.test(value)) {
    const parts = value.split('_');
    if (parts.length >= 3) {
      value = `${parts[0]}.${parts[1]}/${parts.slice(2).join('_')}`;
    }
  } else if (/^[a-z\-]+_[A-Z]{2}\/\d{7}(v\d+)?$/.test(value)) {
    const idx = value.indexOf('_');
    value = `${value.slice(0, idx)}.${value.slice(idx + 1)}`;
  }

  const modern = /^\d{4}\.\d{4,5}(v\d+)?$/;
  const old = /^[a-z\-]+\.[A-Z]{2}\/\d{7}(v\d+)?$/;
  return modern.test(value) || old.test(value) ? value : null;
}

function getArxivAbsUrlFromNode(node: any): string | null {
  const byId = extractArxivId(String(node?.id ?? ''));
  if (byId) {
    return `https://arxiv.org/abs/${byId}`;
  }

  const byTitle = extractArxivId(String(node?.title ?? ''));
  return byTitle ? `https://arxiv.org/abs/${byTitle}` : null;
}

const PRESET_COLORS = ['#7c9885', '#cc5833', '#c88a4d', '#7287a6', '#8f584a', '#547a74', '#a06c5d', '#44636c', '#1a1a1a', '#6b7280'];

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

interface SidePanelProps {
  selectedNode: GraphNode | null;
  onClose: () => void;
  onExpand?: (node: GraphNode) => void;
  onNavigate?: (node: GraphNode) => void;
  onAction?: () => void;
  mode?: 'global' | 'paper' | 'neurips';
  isLoading?: boolean;
  nodeColorMap?: Record<string, string>;
  nodeColor?: string;
  onNodeColorChange?: (nodeKey: string, color: string) => void;
  onNodeColorReset?: (nodeKey: string) => void;
  extraContent?: React.ReactNode;
  layoutMode?: 'fixed' | 'docked';
  panelWidth?: number | string;
}

export default function SidePanel({
  selectedNode,
  onClose,
  onExpand,
  onNavigate,
  mode = 'global',
  isLoading = false,
  nodeColorMap,
  nodeColor,
  onNodeColorChange,
  onNodeColorReset,
  extraContent,
  layoutMode = 'fixed',
  panelWidth = 320,
}: SidePanelProps) {
  const navigate = useNavigate();
  const [showNodeColor, setShowNodeColor] = useState(true);

  const selectedKey = useMemo(() => nodeKeyOf(selectedNode), [selectedNode]);
  const noteId = useMemo(() => encodeURIComponent(stripNotePrefix(selectedKey || selectedNode?.id || '')), [selectedKey, selectedNode?.id]);
  const arxivUrl = useMemo(() => (selectedNode ? getArxivAbsUrlFromNode(selectedNode) : null), [selectedNode]);
  const selectedIsCenter = Boolean((selectedNode as any)?.is_center || (selectedNode as any)?.isCenter);
  const currentColor = useMemo(() => {
    if (isHexColor(nodeColor)) {
      return nodeColor;
    }

    const mapped = nodeColorMap?.[selectedKey] || (selectedNode ? nodeColorMap?.[selectedNode.id] : undefined);
    return isHexColor(mapped) ? mapped : '#7c9885';
  }, [nodeColor, nodeColorMap, selectedKey, selectedNode]);

  const dockedFlexBasis = typeof panelWidth === 'number' ? `${panelWidth}px` : panelWidth;
  const panelLayoutStyle =
    layoutMode === 'docked'
      ? {
          position: 'relative' as const,
          flex: `0 0 ${dockedFlexBasis}`,
          width: panelWidth,
          minWidth: panelWidth,
          height: '100%',
          alignSelf: 'stretch' as const,
        }
      : {
          position: 'fixed' as const,
          top: 0,
          right: 0,
          width: panelWidth,
          height: '100vh',
        };

  if (!selectedNode) {
    return null;
  }

  return (
    <div
      className="workspace-side-drawer"
      style={{
        ...panelLayoutStyle,
        display: 'flex',
        flexDirection: 'column',
        zIndex: 999,
      }}
    >
      <div
        style={{
          padding: '18px 20px',
          borderBottom: '1px solid rgba(46, 64, 54, 0.08)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '14px',
        }}
      >
        <div>
          <div className="workspace-kicker">Paper Side Panel</div>
          <div className="workspace-title" style={{ fontSize: '24px', marginTop: '4px' }}>Paper details</div>
        </div>
        <button
          onClick={onClose}
          className="workspace-ghost-btn workspace-dismiss-btn"
          aria-label="Close"
        >
          X
        </button>
      </div>

      <div className="workspace-scroll" style={{ padding: '18px 20px', flex: 1 }}>
        <div className="workspace-list-card" style={{ padding: '14px' }}>
          <PaperCard node={selectedNode} />
        </div>

        <div className="workspace-list-card" style={{ padding: '14px', marginTop: '14px' }}>
          <div className="workspace-section-label">Saved report</div>
          <ReportViewer key={selectedNode.id} paperId={selectedNode.id} />
        </div>

        <div className="workspace-mobile-stack" style={{ marginTop: '16px' }}>
          <button
            onClick={() => navigate(`/note/${noteId}`)}
            className="workspace-btn"
            style={{ border: 'none', padding: '11px 14px', cursor: 'pointer', fontSize: '11px' }}
          >
            Open Note
          </button>

          {mode === 'global' && onNavigate && (
            <button
              onClick={() => onNavigate(selectedNode)}
              disabled={isLoading}
              className="workspace-btn-secondary"
              style={{ border: 'none', padding: '11px 14px', cursor: isLoading ? 'not-allowed' : 'pointer', fontSize: '11px' }}
            >
              View Reference Graph
            </button>
          )}

          {mode === 'paper' && onExpand && !selectedIsCenter && (
            <button
              onClick={() => onExpand(selectedNode)}
              disabled={isLoading}
              className="workspace-btn-secondary"
              style={{ border: 'none', padding: '11px 14px', cursor: isLoading ? 'not-allowed' : 'pointer', fontSize: '11px' }}
            >
              {isLoading ? 'Expanding...' : 'Expand References'}
            </button>
          )}

          {arxivUrl && (
            <a
              href={arxivUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="workspace-btn-secondary"
              style={{ padding: '11px 14px', textDecoration: 'none', fontSize: '11px' }}
            >
              View on arXiv
            </a>
          )}
        </div>

        {extraContent}

        <div className="workspace-panel-rule" style={{ marginTop: '18px', paddingTop: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
            <div>
              <div className="workspace-section-label">Node color</div>
              <div className="workspace-subtle" style={{ fontSize: '12px' }}>Persist the node accent in the graph.</div>
            </div>
            <button
              onClick={() => setShowNodeColor((current) => !current)}
              className="workspace-ghost-btn"
              style={{ border: 'none', padding: '8px 12px', cursor: 'pointer', fontSize: '11px' }}
            >
              {showNodeColor ? 'Collapse' : 'Expand'}
            </button>
          </div>

          {showNodeColor && (
            <>
              <div className="workspace-mobile-stack" style={{ marginTop: '12px', alignItems: 'center' }}>
                <input
                  type="color"
                  value={currentColor}
                  disabled={!onNodeColorChange}
                  onChange={(event) => {
                    if (isHexColor(event.target.value)) {
                      onNodeColorChange?.(selectedKey, event.target.value);
                    }
                  }}
                  className="workspace-color-input"
                  style={{
                    width: '52px',
                    height: '40px',
                    padding: '4px',
                    borderRadius: '14px',
                    cursor: onNodeColorChange ? 'pointer' : 'not-allowed',
                  }}
                />
                <input
                  type="text"
                  value={currentColor}
                  disabled={!onNodeColorChange}
                  onChange={(event) => {
                    const value = event.target.value.trim();
                    if (isHexColor(value)) {
                      onNodeColorChange?.(selectedKey, value);
                    }
                  }}
                  className="workspace-input"
                  placeholder="#RRGGBB"
                  style={{ flex: 1, padding: '12px 14px', fontSize: '13px' }}
                />
                <button
                  onClick={() => onNodeColorReset?.(selectedKey)}
                  disabled={!onNodeColorReset}
                  className="workspace-btn-secondary"
                  style={{ border: 'none', padding: '12px 14px', cursor: onNodeColorReset ? 'pointer' : 'not-allowed', fontSize: '11px' }}
                >
                  Reset
                </button>
              </div>

              <div className="workspace-mobile-stack" style={{ marginTop: '12px' }}>
                {PRESET_COLORS.map((color) => (
                  <button
                    key={color}
                    onClick={() => onNodeColorChange?.(selectedKey, color)}
                    disabled={!onNodeColorChange}
                    style={{
                      width: '24px',
                      height: '24px',
                      borderRadius: '999px',
                      border: color.toLowerCase() === currentColor.toLowerCase() ? '2px solid #1a1a1a' : '1px solid rgba(46, 64, 54, 0.14)',
                      background: color,
                      cursor: onNodeColorChange ? 'pointer' : 'not-allowed',
                    }}
                    aria-label={`Set node color ${color}`}
                  />
                ))}
              </div>

              <div className="workspace-kicker" style={{ marginTop: '12px', letterSpacing: '0.12em' }}>
                Key {selectedKey}
              </div>
            </>
          )}
        </div>
      </div>

      {isLoading && (
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid rgba(46, 64, 54, 0.08)',
            background: 'rgba(204, 88, 51, 0.08)',
            color: '#9b3c1f',
            fontSize: '12px',
            fontFamily: 'JetBrains Mono, monospace',
          }}
        >
          Processing...
        </div>
      )}
    </div>
  );
}
