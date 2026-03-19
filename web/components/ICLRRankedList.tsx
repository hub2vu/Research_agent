import React, { useState, useRef, useEffect } from 'react';
import { ScoredPaper } from './PaperResultCard';
import './workspaceTheme.css';

interface ICLRRankedListProps {
  papers: ScoredPaper[];
  onPaperClick: (paperId: string) => void;
  clusterMap?: Record<string, number>;
  onClose?: () => void;
}

function getClusterColor(cluster: number): string {
  const colors = ['#7c9885', '#cc5833', '#c88a4d', '#7287a6', '#8f584a', '#547a74', '#a06c5d', '#44636c'];
  return colors[cluster % colors.length];
}

function getTagColor(tag: string) {
  if (tag.includes('HIGH_MATCH') || tag.includes('PREFERRED') || tag.includes('CODE_AVAILABLE') || tag.includes('SEMANTIC_HIGH')) {
    return { background: 'rgba(46, 64, 54, 0.12)', color: '#2e4036', border: 'rgba(46, 64, 54, 0.16)' };
  }
  if (tag.includes('PENALTY') || tag.includes('NO_CODE') || tag.includes('OLDER')) {
    return { background: 'rgba(204, 88, 51, 0.12)', color: '#9b3c1f', border: 'rgba(204, 88, 51, 0.16)' };
  }
  if (tag.includes('CONTRASTIVE')) {
    return { background: 'rgba(200, 138, 77, 0.16)', color: '#8a5a23', border: 'rgba(200, 138, 77, 0.24)' };
  }
  return { background: 'rgba(114, 135, 166, 0.14)', color: '#41546f', border: 'rgba(114, 135, 166, 0.22)' };
}

export default function ICLRRankedList({
  papers,
  onPaperClick,
  clusterMap = {},
  onClose,
}: ICLRRankedListProps) {
  const [position, setPosition] = useState({ left: 16, top: null as number | null });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current && position.top === null) {
      const rect = containerRef.current.getBoundingClientRect();
      const initialTop = window.innerHeight - rect.height - 16;
      setPosition({ left: 16, top: initialTop });
    }
  }, [papers.length, position.top]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!isDragging) {
        return;
      }

      const nextLeft = event.clientX - dragOffset.x;
      const nextTop = event.clientY - dragOffset.y;
      const width = containerRef.current?.offsetWidth || 450;
      const height = containerRef.current?.offsetHeight || 200;

      setPosition({
        left: Math.max(0, Math.min(nextLeft, window.innerWidth - width)),
        top: Math.max(0, Math.min(nextTop, window.innerHeight - height)),
      });
    };

    const handleMouseUp = () => setIsDragging(false);

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragOffset, isDragging]);

  if (papers.length === 0) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="workspace-ranked-list"
      style={{
        position: 'absolute',
        left: position.top === null ? '16px' : `${position.left}px`,
        top: position.top === null ? undefined : `${position.top}px`,
        bottom: position.top === null ? '16px' : undefined,
        zIndex: isDragging ? 10 : 5,
        width: '460px',
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'calc(100vh - 200px)',
        display: 'flex',
        flexDirection: 'column',
        cursor: isDragging ? 'grabbing' : 'default',
      }}
    >
      <div
        onMouseDown={(event) => {
          if (!containerRef.current) {
            return;
          }

          const rect = containerRef.current.getBoundingClientRect();
          setDragOffset({ x: event.clientX - rect.left, y: event.clientY - rect.top });
          setIsDragging(true);
        }}
        style={{
          padding: '16px 18px',
          borderBottom: '1px solid rgba(46, 64, 54, 0.08)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: 'grab',
          gap: '16px',
        }}
      >
        <div>
          <div className="workspace-kicker">Ranked Results Overlay</div>
          <div className="workspace-title" style={{ fontSize: '24px', marginTop: '4px' }}>
            Ranked matches ({papers.length})
          </div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            onMouseDown={(event) => event.stopPropagation()}
            className="workspace-ghost-btn workspace-dismiss-btn"
            aria-label="Close"
          >
            X
          </button>
        )}
      </div>

      <div className="workspace-scroll" style={{ padding: '14px' }}>
        {papers.map((paper) => (
          <PaperItem
            key={paper.paper_id}
            paper={paper}
            onPaperClick={onPaperClick}
            clusterId={clusterMap[paper.paper_id] ?? null}
          />
        ))}
      </div>
    </div>
  );
}

function PaperItem({
  paper,
  onPaperClick,
  clusterId,
}: {
  paper: ScoredPaper;
  onPaperClick: (paperId: string) => void;
  clusterId: number | null;
}) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const reasoning = (paper as any).reasoning || null;
  const openReviewUrl = `https://openreview.net/forum?id=${paper.paper_id}`;
  const pdfUrl = `https://openreview.net/pdf?id=${paper.paper_id}`;
  const formatScore = (score: number) => `${(score * 100).toFixed(1)}%`;

  return (
    <div className="workspace-result-card" style={{ padding: '16px', marginBottom: '12px' }}>
      <div className="workspace-mobile-stack" style={{ marginBottom: '10px' }}>
        <span className="workspace-pill" data-tone="accent">#{paper.rank}</span>
        <span className="workspace-pill">Score {formatScore(paper.score.final)}</span>
        {clusterId !== null && (
          <span
            className="workspace-pill"
            style={{ background: `${getClusterColor(clusterId)}1f`, color: getClusterColor(clusterId), borderColor: `${getClusterColor(clusterId)}33` }}
          >
            Cluster {clusterId}
          </span>
        )}
      </div>

      <button
        onClick={() => onPaperClick(paper.paper_id)}
        style={{
          border: 'none',
          background: 'transparent',
          padding: 0,
          textAlign: 'left',
          cursor: 'pointer',
          color: 'var(--charcoal)',
          fontSize: '16px',
          fontWeight: 700,
          lineHeight: 1.45,
        }}
      >
        {paper.title}
      </button>

      <div style={{ marginTop: '8px', color: 'rgba(22, 22, 22, 0.62)', fontSize: '13px', lineHeight: 1.6 }}>
        {paper.authors.join(', ')}
      </div>

      {paper.published && (
        <div className="workspace-kicker" style={{ marginTop: '10px', letterSpacing: '0.12em' }}>
          Published {paper.published}
        </div>
      )}

      {!!paper.tags?.length && (
        <div className="workspace-mobile-stack" style={{ marginTop: '12px' }}>
          {paper.tags.map((tag) => {
            const color = getTagColor(tag);
            return (
              <span
                key={tag}
                className="workspace-pill"
                style={{ background: color.background, color: color.color, borderColor: color.border }}
              >
                {tag.replace(/_/g, ' ')}
              </span>
            );
          })}
        </div>
      )}

      {reasoning && (
        <div
          className="workspace-list-card"
          style={{ marginTop: '14px', padding: '12px 14px', color: 'rgba(22, 22, 22, 0.66)', fontSize: '12px', fontStyle: 'italic' }}
        >
          {reasoning}
        </div>
      )}

      <div style={{ marginTop: '14px' }}>
        <button
          onClick={(event) => {
            event.stopPropagation();
            setShowBreakdown((current) => !current);
          }}
          className="workspace-btn-secondary"
          style={{ border: 'none', padding: '10px 14px', cursor: 'pointer', fontSize: '11px' }}
        >
          {showBreakdown ? 'Hide' : 'Show'} Score Breakdown
        </button>
        {showBreakdown && (
          <div className="workspace-list-card" style={{ marginTop: '12px', padding: '14px' }}>
            <div className="workspace-section-label">Score Breakdown</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '12px', color: 'rgba(22, 22, 22, 0.66)' }}>
              <div>Semantic {formatScore(paper.score.breakdown.semantic_relevance)}</div>
              <div>Keywords {formatScore(paper.score.breakdown.must_keywords)}</div>
              <div>Author Trust {formatScore(paper.score.breakdown.author_trust)}</div>
              <div>Institution {formatScore(paper.score.breakdown.institution_trust)}</div>
              <div>Recency {formatScore(paper.score.breakdown.recency)}</div>
              <div>Practicality {formatScore(paper.score.breakdown.practicality)}</div>
            </div>
            {paper.score.soft_penalty < 0 && (
              <div style={{ marginTop: '10px', color: '#9b3c1f', fontSize: '11px' }}>
                Penalty {formatScore(paper.score.soft_penalty)}
                {!!paper.score.penalty_keywords.length && ` (${paper.score.penalty_keywords.join(', ')})`}
              </div>
            )}
            <div className="workspace-kicker" style={{ marginTop: '10px', letterSpacing: '0.12em' }}>
              Method {paper.score.evaluation_method}
            </div>
          </div>
        )}
      </div>

      <div className="workspace-mobile-stack" style={{ marginTop: '14px' }}>
        <a
          href={pdfUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="workspace-btn"
          style={{ padding: '10px 14px', textDecoration: 'none', fontSize: '11px' }}
        >
          Download PDF
        </a>
        <a
          href={openReviewUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="workspace-btn-secondary"
          style={{ padding: '10px 14px', textDecoration: 'none', fontSize: '11px' }}
        >
          View on OpenReview
        </a>
      </div>
    </div>
  );
}
