import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { getReport, generateReport, executeTool } from '../lib/mcp';
import MarkdownWithLatex, { defaultMarkdownComponents } from './MarkdownWithLatex';
import { LatexDiv } from './LatexText';
import './workspaceTheme.css';

type AnyEdge = { source: string; target: string; weight?: number; type?: string };
type AnyNode = {
  id: string;
  title?: string;
  label?: string;
  cluster?: number | string;
  abstract?: string;
  authors?: string[];
  [key: string]: any;
};
type ReportState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'found'; content: string }
  | { status: 'error'; message: string };

const INITIAL_VISIBLE_COUNT = 20;
const LOAD_MORE_STEP = 50;

function truncateText(value: string, limit: number) {
  if (!value) {
    return '';
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function buildAdjacency(nodes: AnyNode[], edges: AnyEdge[]) {
  const nodeSet = new Set(nodes.map((node) => node.id));
  const adjacency = new Map<string, Set<string>>();
  const degree = new Map<string, number>();

  nodes.forEach((node) => {
    adjacency.set(node.id, new Set());
    degree.set(node.id, 0);
  });

  (edges || []).forEach((edge) => {
    const { source, target } = edge;
    if (!nodeSet.has(source) || !nodeSet.has(target)) {
      return;
    }

    const isSimilarity = edge.type === 'similarity' || (edge.type == null && typeof edge.weight === 'number');
    if (!isSimilarity) {
      return;
    }

    adjacency.get(source)?.add(target);
    adjacency.get(target)?.add(source);
    degree.set(source, (degree.get(source) || 0) + 1);
    degree.set(target, (degree.get(target) || 0) + 1);
  });

  return { adjacency, degree };
}

function orderByConnectivity(groupNodes: AnyNode[], adjacency: Map<string, Set<string>>, degree: Map<string, number>) {
  void adjacency;
  return [...groupNodes].sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0));
}

async function generateSurvey(topicName: string, papers: AnyNode[]) {
  const topPapers = papers.slice(0, 20);
  const context = topPapers.map((paper, index) => `
[Paper ${index + 1}]
Title: ${paper.title || paper.id}
Authors: ${paper.authors ? paper.authors.slice(0, 2).join(', ') : 'N/A'}
Abstract: ${paper.abstract ? truncateText(paper.abstract, 500) : 'No abstract available'}
`).join('\n');

  try {
    const result = await executeTool('generate_cluster_survey', {
      topic: topicName,
      papers_context: context,
      language: 'Korean',
    });

    if (result.success && result.result?.survey_content) {
      return result.result.survey_content;
    }

    return 'Error: failed to generate the survey summary.';
  } catch {
    return 'Error: failed to reach the survey generation service.';
  }
}

export default function PaperListView(props: {
  nodes: AnyNode[];
  edges: AnyEdge[];
  groupBy?: (n: AnyNode) => string | number;
  groupTitle?: (groupKey: string) => string;
  onOpenPaper?: (paperId: string) => void;
  initialPrefetchCount?: number;
  conferenceType?: string;
}) {
  const {
    nodes,
    edges,
    groupBy,
    groupTitle,
    onOpenPaper,
    initialPrefetchCount = 60,
    conferenceType,
  } = props;
  const { adjacency, degree } = useMemo(() => buildAdjacency(nodes, edges), [nodes, edges]);

  const groups = useMemo(() => {
    const grouped = new Map<string, AnyNode[]>();
    nodes.forEach((node) => {
      const keyRaw = groupBy ? groupBy(node) : node.cluster ?? '0';
      const key = String(keyRaw ?? '0');
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)?.push(node);
    });
    return grouped;
  }, [groupBy, nodes]);

  const sortedGroupKeys = useMemo(() => {
    const keys = Array.from(groups.keys());
    const allNumeric = keys.every((key) => /^-?\d+(\.\d+)?$/.test(key));
    return keys.sort((a, b) => (allNumeric ? Number(a) - Number(b) : a.localeCompare(b)));
  }, [groups]);

  const [reportMap, setReportMap] = useState<Record<string, ReportState>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pipelineState, setPipelineState] = useState<Record<string, 'idle' | 'loading' | 'done' | 'error'>>({});
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const [surveyData, setSurveyData] = useState<Record<string, string>>({});
  const [surveyVisible, setSurveyVisible] = useState<Record<string, boolean>>({});
  const [surveyLoading, setSurveyLoading] = useState<Record<string, boolean>>({});
  const inflightRef = useRef<Set<string>>(new Set());
  const generatingRef = useRef<Set<string>>(new Set());

  const setReportState = useCallback((paperId: string, nextState: ReportState) => {
    setReportMap((current) => ({ ...current, [paperId]: nextState }));
  }, []);

  const ensureReport = useCallback(async (paperId: string) => {
    const current = reportMap[paperId];
    if ((current && current.status !== 'idle') || inflightRef.current.has(paperId)) {
      return;
    }

    inflightRef.current.add(paperId);
    setReportState(paperId, { status: 'loading' });
    try {
      const report = await getReport(paperId);
      if (report.found) {
        setReportState(paperId, { status: 'found', content: report.content || '' });
      } else {
        setReportState(paperId, { status: 'missing' });
      }
    } catch (err) {
      setReportState(paperId, { status: 'error', message: err instanceof Error ? err.message : 'Error' });
    } finally {
      inflightRef.current.delete(paperId);
    }
  }, [reportMap, setReportState]);

  const handleGenerate = useCallback(async (paperId: string) => {
    if (generatingRef.current.has(paperId)) {
      return;
    }

    generatingRef.current.add(paperId);
    setReportState(paperId, { status: 'loading' });
    try {
      const generated = await generateReport(paperId);
      if (!generated?.status && generated?.success === false) {
        throw new Error('Failed');
      }
      const report = await getReport(paperId);
      if (report.found) {
        setReportState(paperId, { status: 'found', content: report.content || '' });
      } else {
        setReportState(paperId, { status: 'missing' });
      }
    } catch (err) {
      setReportState(paperId, { status: 'error', message: String(err) });
    } finally {
      generatingRef.current.delete(paperId);
    }
  }, [setReportState]);

  const handleDownloadAndProcess = async (paperId: string) => {
    if (pipelineState[paperId] === 'loading') {
      return;
    }

    setPipelineState((current) => ({ ...current, [paperId]: 'loading' }));
    try {
      const toolName = conferenceType === 'iclr' ? 'process_iclr_paper' : 'process_neurips_paper';
      const outDir = conferenceType === 'iclr' ? '/data/pdf/iclr2025' : '/data/pdf/neurips2025';
      const result = await executeTool(toolName, { paper_id: paperId, out_dir: outDir });
      setPipelineState((current) => ({ ...current, [paperId]: 'done' }));
      alert(result.result?.pipeline_results ? 'PDF Saved!' : 'Process Complete!');
      ensureReport(paperId);
    } catch (err) {
      setPipelineState((current) => ({ ...current, [paperId]: 'error' }));
      alert(`Error: ${String(err)}`);
    }
  };

  const handleWriteSurveyButton = async (groupKey: string, papersInGroup: AnyNode[]) => {
    if (surveyLoading[groupKey]) {
      return;
    }

    if (surveyData[groupKey]) {
      setSurveyVisible((current) => ({ ...current, [groupKey]: !current[groupKey] }));
      return;
    }

    setSurveyLoading((current) => ({ ...current, [groupKey]: true }));
    try {
      const title = groupTitle ? groupTitle(groupKey) : `Cluster ${groupKey}`;
      const ordered = orderByConnectivity(papersInGroup, adjacency, degree);
      const result = await generateSurvey(title, ordered);
      setSurveyData((current) => ({ ...current, [groupKey]: result }));
      setSurveyVisible((current) => ({ ...current, [groupKey]: true }));
    } finally {
      setSurveyLoading((current) => ({ ...current, [groupKey]: false }));
    }
  };

  const handleRegenerate = async (groupKey: string, papersInGroup: AnyNode[]) => {
    if (!confirm('Regenerate the survey summary for this cluster?')) {
      return;
    }

    setSurveyData((current) => {
      const next = { ...current };
      delete next[groupKey];
      return next;
    });
    handleWriteSurveyButton(groupKey, papersInGroup);
  };

  useEffect(() => {
    const prefetchNodes = nodes.slice(0, Math.min(nodes.length, initialPrefetchCount));
    prefetchNodes.forEach((node) => {
      if (!reportMap[node.id]) {
        setReportState(node.id, { status: 'idle' });
      }
    });
  }, [initialPrefetchCount, nodes, reportMap, setReportState]);

  useEffect(() => {
    const prefetchNodes = nodes.slice(0, Math.min(nodes.length, initialPrefetchCount));
    (async () => {
      for (const node of prefetchNodes) {
        if (reportMap[node.id]?.status === 'idle') {
          await ensureReport(node.id);
        }
      }
    })();
  }, [ensureReport, initialPrefetchCount, nodes, reportMap]);

  if (sortedGroupKeys.length === 0) {
    return (
      <div className="workspace-list-shell">
        <div className="workspace-empty-state">
          <div className="workspace-empty-card workspace-list-card">
            <h3 className="workspace-title" style={{ fontSize: '24px' }}>No papers in view</h3>
            <p>Adjust the cluster or similarity controls to populate this list.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-list-shell">
      {sortedGroupKeys.map((groupKey) => {
        const rawNodes = groups.get(groupKey) || [];
        const orderedNodes = orderByConnectivity(rawNodes, adjacency, degree);
        const visibleCount = visibleCounts[groupKey] || INITIAL_VISIBLE_COUNT;
        const visibleNodes = orderedNodes.slice(0, visibleCount);
        const remainingCount = orderedNodes.length - visibleNodes.length;
        const isLoadingSurvey = surveyLoading[groupKey];
        const hasSurvey = Boolean(surveyData[groupKey]);
        const surveyIsVisible = surveyVisible[groupKey];

        return (
          <div key={groupKey}>
            <div className="workspace-list-group-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                <div>
                  <div className="workspace-kicker">Cluster review</div>
                  <div className="workspace-title" style={{ fontSize: '22px', marginTop: '4px' }}>
                    {groupTitle ? groupTitle(groupKey) : `Group ${groupKey}`}
                  </div>
                </div>
                <button
                  onClick={() => handleWriteSurveyButton(groupKey, rawNodes)}
                  disabled={isLoadingSurvey}
                  className={surveyIsVisible ? 'workspace-btn' : 'workspace-btn-secondary'}
                  style={{ border: 'none', padding: '11px 14px', cursor: isLoadingSurvey ? 'not-allowed' : 'pointer', fontSize: '11px' }}
                >
                  {isLoadingSurvey ? 'Writing...' : hasSurvey ? (surveyIsVisible ? 'Hide Survey' : 'Show Survey') : 'Write Survey'}
                </button>
              </div>
              <span className="workspace-pill">{rawNodes.length} papers</span>
            </div>

            {hasSurvey && surveyIsVisible && (
              <div className="workspace-survey-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                  <div>
                    <div className="workspace-kicker">Cluster summary</div>
                    <div className="workspace-title" style={{ fontSize: '24px', marginTop: '4px' }}>AI research report</div>
                  </div>
                  <div className="workspace-mobile-stack">
                    <button
                      onClick={() => handleRegenerate(groupKey, rawNodes)}
                      className="workspace-btn-secondary"
                      style={{ border: 'none', padding: '10px 14px', cursor: 'pointer', fontSize: '11px' }}
                    >
                      Regenerate
                    </button>
                    <button
                      onClick={() => setSurveyVisible((current) => ({ ...current, [groupKey]: false }))}
                      className="workspace-ghost-btn"
                      style={{ border: 'none', padding: '10px 14px', cursor: 'pointer', fontSize: '11px' }}
                    >
                      Close
                    </button>
                  </div>
                </div>
                <div style={{ marginTop: '16px' }}>
                  <MarkdownWithLatex components={defaultMarkdownComponents}>
                    {surveyData[groupKey]}
                  </MarkdownWithLatex>
                </div>
              </div>
            )}

            {visibleNodes.map((node) => {
              const title = node.title || node.label || node.id;
              const reportState = reportMap[node.id] ?? { status: 'idle' as const };
              const isExpanded = Boolean(expanded[node.id]);
              const processState = pipelineState[node.id] || 'idle';
              const abstractText = node.abstract || node.summary || '';
              const connectionCount = degree.get(node.id) || 0;
              const hasLinks = connectionCount > 0;

              let rightContent: React.ReactNode;
              if (reportState.status === 'loading') {
                rightContent = <span className="workspace-subtle">Loading report...</span>;
              } else if (reportState.status === 'found') {
                const text = isExpanded ? reportState.content : truncateText(reportState.content, 420);
                rightContent = (
                  <div className="workspace-list-card" style={{ padding: '14px' }}>
                    <div className="workspace-section-label">Report preview</div>
                    <LatexDiv style={{ lineHeight: 1.6, fontSize: '13px', color: 'rgba(22, 22, 22, 0.74)' }}>
                      {text || '(empty)'}
                    </LatexDiv>
                    {!!reportState.content && reportState.content.length > 450 && (
                      <button
                        onClick={() => setExpanded((current) => ({ ...current, [node.id]: !current[node.id] }))}
                        className="workspace-btn-secondary"
                        style={{ marginTop: '12px', border: 'none', padding: '10px 14px', cursor: 'pointer', fontSize: '11px' }}
                      >
                        {isExpanded ? 'Show less' : 'Show more'}
                      </button>
                    )}
                  </div>
                );
              } else {
                rightContent = (
                  <div style={{ display: 'grid', gap: '12px' }}>
                    <div className="workspace-mobile-stack">
                      {reportState.status === 'idle' ? (
                        <button
                          onClick={() => ensureReport(node.id)}
                          className="workspace-btn-secondary"
                          style={{ border: 'none', padding: '10px 14px', cursor: 'pointer', fontSize: '11px' }}
                        >
                          Load Report
                        </button>
                      ) : (
                        <button
                          onClick={() => handleGenerate(node.id)}
                          className="workspace-btn"
                          style={{ border: 'none', padding: '10px 14px', cursor: 'pointer', fontSize: '11px' }}
                        >
                          {reportState.status === 'error' ? 'Retry Report' : 'Generate Report'}
                        </button>
                      )}

                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          handleDownloadAndProcess(node.id);
                        }}
                        disabled={processState === 'loading' || processState === 'done'}
                        className={processState === 'error' ? 'workspace-btn-secondary' : 'workspace-btn'}
                        style={{ border: 'none', padding: '10px 14px', cursor: processState === 'loading' || processState === 'done' ? 'default' : 'pointer', fontSize: '11px' }}
                      >
                        {processState === 'loading' ? 'Downloading...' : processState === 'done' ? 'PDF Saved' : processState === 'error' ? 'Retry Download' : 'Download PDF'}
                      </button>
                    </div>

                    {abstractText ? (
                      <div className="workspace-list-card" style={{ padding: '14px' }}>
                        <div className="workspace-section-label">Abstract Preview</div>
                        <LatexDiv style={{ fontSize: '13px', color: 'rgba(22, 22, 22, 0.7)', lineHeight: 1.6 }}>
                          {isExpanded ? abstractText : truncateText(abstractText, 350)}
                        </LatexDiv>
                        {abstractText.length > 350 && (
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              setExpanded((current) => ({ ...current, [node.id]: !current[node.id] }));
                            }}
                            className="workspace-btn-secondary"
                            style={{ marginTop: '12px', border: 'none', padding: '10px 14px', cursor: 'pointer', fontSize: '11px' }}
                          >
                            {isExpanded ? 'Show less' : 'Show more'}
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="workspace-list-card" style={{ padding: '14px', color: 'rgba(22, 22, 22, 0.54)', fontStyle: 'italic' }}>
                        No abstract preview available.
                      </div>
                    )}
                  </div>
                );
              }

              return (
                <div key={node.id} className="workspace-list-row">
                  <div className="workspace-list-card" style={{ padding: '16px' }}>
                    <div className="workspace-mobile-stack" style={{ alignItems: 'center', marginBottom: '12px' }}>
                      <span className="workspace-pill" data-tone={hasLinks ? 'moss' : undefined}>
                        {hasLinks ? `${connectionCount} links` : 'Isolated'}
                      </span>
                      <span className="workspace-pill">{node.id}</span>
                    </div>

                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenPaper?.(node.id);
                      }}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        padding: 0,
                        textAlign: 'left',
                        color: 'var(--charcoal)',
                        fontSize: '16px',
                        fontWeight: 700,
                        lineHeight: 1.5,
                        cursor: onOpenPaper ? 'pointer' : 'default',
                      }}
                      title={title}
                    >
                      {title}
                    </button>
                  </div>

                  <div>{rightContent}</div>
                </div>
              );
            })}

            {remainingCount > 0 && (
              <div style={{ padding: '16px 18px', textAlign: 'center' }}>
                <button
                  onClick={() => setVisibleCounts((current) => ({ ...current, [groupKey]: (current[groupKey] || INITIAL_VISIBLE_COUNT) + LOAD_MORE_STEP }))}
                  className="workspace-btn-secondary"
                  style={{ border: 'none', padding: '12px 16px', cursor: 'pointer', fontSize: '11px' }}
                >
                  Show {Math.min(remainingCount, LOAD_MORE_STEP)} more ({remainingCount} remaining)
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
