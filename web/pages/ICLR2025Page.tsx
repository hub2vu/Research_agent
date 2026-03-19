import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import GraphCanvas from '../components/GraphCanvas';
import SidePanel from '../components/SidePanel';
import ICLRSearchSidebar from '../components/ICLRSearchSidebar';
import ICLRRankedList from '../components/ICLRRankedList';
import PaperListView from '../components/PaperListView';
import { GraphNode, GraphEdge, executeICLRSearchAndRank, executeTool } from '../lib/mcp';
import { recordRecentPaper } from '../lib/recentPapers';
import { ScoredPaper } from '../components/PaperResultCard';
import { useNodeColors } from '../hooks/useNodeColors';
import '../components/workspaceTheme.css';

interface ICLRPaper {
  paper_id: string;
  title: string;
  abstract: string;
  authors?: string;
  pdf_url?: string;
}

interface SimilarityEdge {
  source: string;
  target: string;
  similarity: number;
}

interface ICLRGraphState {
  nodes: GraphNode[];
}

interface ClusterData {
  paper_id_to_cluster: Record<string, number>;
  cluster_sizes: Record<string, number>;
  k: number;
}

interface ClusterCenters {
  [clusterId: string]: { x: number; y: number };
}

function iclrStableKey(paperId: string): string {
  return `iclr:${paperId}`;
}

function generateClusterCenters(k: number): ClusterCenters {
  const centers: ClusterCenters = {};
  const cols = Math.ceil(Math.sqrt(k));
  const spacing = 600;

  for (let i = 0; i < k; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    centers[String(i)] = {
      x: col * spacing + 400,
      y: row * spacing + 400,
    };
  }
  return centers;
}

const floatingPanelBase: React.CSSProperties = {
  position: 'absolute',
  zIndex: 5,
  padding: '18px',
};

const overlayMessageStyle: React.CSSProperties = {
  position: 'absolute',
  right: '16px',
  bottom: '16px',
  zIndex: 5,
  width: '400px',
  maxWidth: 'calc(100vw - 32px)',
  padding: '18px',
  textAlign: 'center',
};

export default function ICLR2025Page() {
  const location = useLocation();
  const [viewMode, setViewMode] = useState<'graph' | 'list'>('graph');
  const [graphState, setGraphState] = useState<ICLRGraphState>({ nodes: [] });
  const [papers, setPapers] = useState<Map<string, ICLRPaper>>(new Map());
  const [rawSimEdges, setRawSimEdges] = useState<SimilarityEdge[]>([]);
  const [clusterCenters, setClusterCenters] = useState<ClusterCenters>({});
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [showSearchUI, setShowSearchUI] = useState(true);
  const [minSim, setMinSim] = useState<number>(0.75);
  const [numClusters, setNumClusters] = useState<number>(15);
  const [clusterStrength, setClusterStrength] = useState<number>(0.15);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<ScoredPaper[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [highlightedPaperIds, setHighlightedPaperIds] = useState<Set<string>>(new Set());
  const [focusNodeId, setFocusNodeId] = useState<string | undefined>(undefined);
  const [clusterMap, setClusterMap] = useState<Record<string, number>>({});

  const {
    nodeColorMap,
    setNodeColor: handleNodeColorChange,
    resetNodeColor: handleNodeColorReset,
  } = useNodeColors();

  const loadData = useCallback(async (k: number = 15) => {
    setIsLoading(true);
    setLoadError(null);

    try {
      const [papersRes, clustersRes] = await Promise.all([
        fetch('/api/iclr/papers'),
        fetch(`/api/iclr/clusters?k=${k}`),
      ]);

      if (!papersRes.ok) {
        throw new Error(`Failed to load papers: ${papersRes.status}`);
      }

      const papersData = await papersRes.json();
      let localClusterMap: Record<string, number> = {};
      let actualK = k;

      if (clustersRes.ok) {
        const clusterData: ClusterData = await clustersRes.json();
        localClusterMap = clusterData.paper_id_to_cluster || {};
        actualK = clusterData.k || k;
        setClusterMap(localClusterMap);
      }

      const centers = generateClusterCenters(actualK);
      setClusterCenters(centers);

      const paperList: ICLRPaper[] = papersData.papers || [];
      const paperMap = new Map<string, ICLRPaper>();
      paperList.forEach((paper) => paperMap.set(paper.paper_id, paper));
      setPapers(paperMap);

      const nodes: GraphNode[] = paperList.map((paper, idx) => {
        const clusterId = localClusterMap[paper.paper_id] ?? 0;
        const center = centers[String(clusterId)];

        return {
          id: paper.paper_id,
          label: paper.title.length > 40 ? `${paper.title.substring(0, 37)}...` : paper.title,
          title: paper.title,
          stableKey: iclrStableKey(paper.paper_id),
          type: 'iclr_paper',
          cluster: clusterId,
          abstract: paper.abstract,
          authors: paper.authors ? paper.authors.split(',').map((author) => author.trim()) : [],
          x: center ? center.x + (Math.random() - 0.5) * 200 : (idx % 50) * 30,
          y: center ? center.y + (Math.random() - 0.5) * 200 : Math.floor(idx / 50) * 30,
        };
      });

      let simEdges: SimilarityEdge[] = [];
      try {
        const simRes = await fetch('/api/iclr/similarities');
        if (simRes.ok) {
          const simData = await simRes.json();
          simEdges = simData.edges || [];
        }
      } catch (loadError) {
        console.warn('Could not load similarities:', loadError);
      }

      setRawSimEdges(simEdges);
      setGraphState({ nodes });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData(numClusters);
  }, [loadData, numClusters]);

  const requestedPaperId = useMemo(
    () => new URLSearchParams(location.search).get('paper')?.trim() ?? '',
    [location.search]
  );

  useEffect(() => {
    if (!requestedPaperId || graphState.nodes.length === 0) {
      return;
    }

    const requestedNode = graphState.nodes.find((node) => node.id === requestedPaperId);
    if (!requestedNode) {
      return;
    }

    setSelectedNode((current) => (current?.id === requestedNode.id ? current : requestedNode));
    setFocusNodeId(requestedNode.id);

    const resetFocus = window.setTimeout(() => {
      setFocusNodeId((current) => (current === requestedNode.id ? undefined : current));
    }, 700);

    return () => window.clearTimeout(resetFocus);
  }, [graphState.nodes, requestedPaperId]);

  const filteredEdges: GraphEdge[] = useMemo(() => {
    if (rawSimEdges.length === 0 || papers.size === 0) {
      return [];
    }

    return rawSimEdges
      .filter((edge) => edge.similarity >= minSim)
      .filter((edge) => papers.has(edge.source) && papers.has(edge.target))
      .map((edge) => ({
        source: edge.source,
        target: edge.target,
        weight: edge.similarity,
      }));
  }, [rawSimEdges, papers, minSim]);

  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNode(node);
  }, []);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      return;
    }

    setIsSearching(true);
    setSearchError(null);
    setSearchResults([]);
    setHighlightedPaperIds(new Set());

    try {
      const result = await executeICLRSearchAndRank(searchQuery.trim(), 'users/profile.json', 10, numClusters);

      if (result.success && result.ranked_papers) {
        setSearchResults(result.ranked_papers);
        setHighlightedPaperIds(new Set(result.ranked_papers.map((paper) => paper.paper_id)));
      } else {
        throw new Error(result.error || 'Search failed');
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Failed to search papers');
    } finally {
      setIsSearching(false);
    }
  }, [searchQuery, numClusters]);

  const handlePaperClick = useCallback((paperId: string) => {
    const node = graphState.nodes.find((entry) => entry.id === paperId);
    if (!node) {
      return;
    }

    setSelectedNode(node);
    setFocusNodeId(paperId);
    setTimeout(() => setFocusNodeId(undefined), 700);
  }, [graphState.nodes]);

  const handleDownloadPdf = useCallback(async () => {
    if (!selectedNode) {
      return;
    }

    const paper = papers.get(selectedNode.id);
    if (!paper) {
      return;
    }

    setDownloadingPdf(true);
    try {
      const result = await executeTool('process_iclr_paper', {
        paper_id: paper.paper_id,
        out_dir: '/data/pdf/iclr2025',
      });

      if (!result.success) {
        alert(`Pipeline failed: ${result.error}`);
      } else {
        const info = result.result?.pipeline_results;
        const refCount = info?.ref_count || 0;
        alert(`Process Complete!\n\n- PDF Saved: ${info?.pdf_path}\n- References Found: ${refCount}`);
      }
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setDownloadingPdf(false);
    }
  }, [selectedNode, papers]);

  const selectedPaper = selectedNode ? papers.get(selectedNode.id) : null;

  useEffect(() => {
    if (!selectedPaper) {
      return;
    }

    recordRecentPaper({
      paperId: selectedPaper.paper_id,
      title: selectedPaper.title,
      venue: 'ICLR 2025',
      route: `/iclr2025?paper=${encodeURIComponent(selectedPaper.paper_id)}`,
    });
  }, [selectedPaper]);

  const renderICLRDetails = () => {
    if (!selectedPaper) {
      return null;
    }

    const openReviewUrl = `https://openreview.net/forum?id=${selectedPaper.paper_id}`;

    return (
      <div style={{ marginTop: '18px' }}>
        <div className="workspace-panel-rule" style={{ paddingTop: '18px' }}>
          <div className="workspace-section-label">Authors</div>
          <div style={{ color: 'rgba(22, 22, 22, 0.74)', fontSize: '13px', lineHeight: 1.65 }}>
            {selectedPaper.authors || 'N/A'}
          </div>
        </div>

        <div style={{ marginTop: '14px' }}>
          <a
            href={openReviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="workspace-btn-secondary"
            style={{
              display: 'inline-flex',
              padding: '10px 14px',
              textDecoration: 'none',
              fontSize: '12px',
            }}
          >
            View on OpenReview
          </a>
        </div>

        <button
          onClick={handleDownloadPdf}
          disabled={downloadingPdf}
          className="workspace-btn"
          style={{
            width: '100%',
            marginTop: '14px',
            padding: '12px 16px',
            borderRadius: '18px',
            border: 'none',
            fontSize: '12px',
            cursor: downloadingPdf ? 'not-allowed' : 'pointer',
          }}
        >
          {downloadingPdf ? 'Downloading...' : 'Download PDF'}
        </button>
      </div>
    );
  };

  if (isLoading) {
    return (
      <div className="workspace-loading-state workspace-stage">
        <div className="workspace-empty-card workspace-floating-panel">
          <div className="workspace-kicker">ICLR Workspace</div>
          <h2 className="workspace-title" style={{ fontSize: '30px' }}>Loading paper map</h2>
          <p>Fetching ICLR 2025 papers, clusters, and similarity links.</p>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="workspace-error-state workspace-stage">
        <div className="workspace-empty-card workspace-floating-panel">
          <div className="workspace-kicker">ICLR Workspace</div>
          <h2 className="workspace-title" style={{ fontSize: '30px' }}>Workspace unavailable</h2>
          <p>{loadError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-stage">
      <div className="workspace-shell">
        {showControls ? (
          <div
            className="workspace-floating-panel"
            style={{ ...floatingPanelBase, top: '16px', left: '16px', width: '300px' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
              <div>
                <div className="workspace-kicker">ICLR 2025</div>
                <div className="workspace-title" style={{ fontSize: '22px', marginTop: '6px' }}>Explorer controls</div>
              </div>
              <button
                onClick={() => setShowControls(false)}
                className="workspace-ghost-btn"
                style={{ border: 'none', padding: '8px 12px', cursor: 'pointer', fontSize: '11px' }}
              >
                Hide
              </button>
            </div>

            <div className="workspace-mobile-stack" style={{ marginTop: '18px' }}>
              <button
                onClick={() => setViewMode('graph')}
                className="workspace-chip"
                data-active={viewMode === 'graph'}
                style={{ border: 'none', padding: '10px 14px', cursor: 'pointer', fontSize: '11px' }}
              >
                Node view
              </button>
              <button
                onClick={() => setViewMode('list')}
                className="workspace-chip"
                data-active={viewMode === 'list'}
                style={{ border: 'none', padding: '10px 14px', cursor: 'pointer', fontSize: '11px' }}
              >
                List view
              </button>
            </div>

            <div style={{ marginTop: '18px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span className="workspace-section-label" style={{ marginBottom: 0 }}>Clusters</span>
                <span className="workspace-pill" data-tone="accent">{numClusters}</span>
              </div>
              <input
                className="workspace-slider"
                type="range"
                min={5}
                max={30}
                step={1}
                value={numClusters}
                onChange={(event) => setNumClusters(parseInt(event.target.value, 10))}
              />
              <div className="workspace-subtle" style={{ fontSize: '12px', marginTop: '6px' }}>
                Tune the topic partition count.
              </div>
            </div>

            <div style={{ marginTop: '18px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span className="workspace-section-label" style={{ marginBottom: 0 }}>Cluster gravity</span>
                <span className="workspace-pill" data-tone="moss">{clusterStrength.toFixed(2)}</span>
              </div>
              <input
                className="workspace-slider"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={clusterStrength}
                onChange={(event) => setClusterStrength(parseFloat(event.target.value))}
              />
              <div className="workspace-subtle" style={{ fontSize: '12px', marginTop: '6px' }}>
                Increase to tighten cluster centers.
              </div>
            </div>

            <div style={{ marginTop: '18px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span className="workspace-section-label" style={{ marginBottom: 0 }}>Similarity floor</span>
                <span className="workspace-pill">{minSim.toFixed(2)}</span>
              </div>
              <input
                className="workspace-slider"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={minSim}
                onChange={(event) => setMinSim(parseFloat(event.target.value))}
              />
              <div className="workspace-subtle" style={{ fontSize: '12px', marginTop: '6px' }}>
                Raise the threshold to hide weaker links.
              </div>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowControls(true)}
            className="workspace-floating-panel workspace-btn-secondary workspace-floating-toggle"
            style={{
              top: '16px',
              left: '16px',
              padding: '12px 16px',
              border: 'none',
              cursor: 'pointer',
              fontSize: '11px',
            }}
          >
            Show Controls
          </button>
        )}

        {showSearchUI ? (
          <>
            <button
              onClick={() => setShowSearchUI(false)}
              className="workspace-floating-panel workspace-ghost-btn workspace-floating-toggle"
              style={{
                top: '16px',
                right: '16px',
                padding: '12px 16px',
                border: 'none',
                cursor: 'pointer',
                fontSize: '11px',
              }}
            >
              Hide Search
            </button>
            <ICLRSearchSidebar
              searchQuery={searchQuery}
              onSearchQueryChange={setSearchQuery}
              onSearch={handleSearch}
              isSearching={isSearching}
            />
          </>
        ) : (
          <button
            onClick={() => setShowSearchUI(true)}
            className="workspace-floating-panel workspace-btn-secondary workspace-floating-toggle"
            style={{
              top: '16px',
              right: '16px',
              padding: '12px 16px',
              border: 'none',
              cursor: 'pointer',
              fontSize: '11px',
            }}
          >
            Show Search
          </button>
        )}

        {showSearchUI && (isSearching ? (
          <div className="workspace-floating-panel" style={overlayMessageStyle}>
            <div className="workspace-kicker">Semantic ranking</div>
            <div className="workspace-title" style={{ fontSize: '24px', marginTop: '6px' }}>
              Searching ICLR papers
            </div>
            <div className="workspace-subtle" style={{ marginTop: '6px', fontSize: '13px' }}>
              Running profile-aware ranking across the current conference graph.
            </div>
          </div>
        ) : searchResults.length > 0 ? (
          <ICLRRankedList
            papers={searchResults}
            onPaperClick={handlePaperClick}
            clusterMap={clusterMap}
            onClose={() => {
              setSearchResults([]);
              setSearchQuery('');
              setHighlightedPaperIds(new Set());
            }}
          />
        ) : searchQuery.trim() && !isSearching ? (
          <div className="workspace-floating-panel" style={overlayMessageStyle}>
            <div className="workspace-kicker">No ranked matches</div>
            <div className="workspace-title" style={{ fontSize: '22px', marginTop: '6px' }}>
              Try a tighter research prompt
            </div>
            <div className="workspace-subtle" style={{ marginTop: '6px', fontSize: '13px' }}>
              No papers were returned for the current query and profile constraints.
            </div>
          </div>
        ) : null)}

        {searchError && (
          <div
            className="workspace-floating-panel"
            style={{
              ...overlayMessageStyle,
              bottom: '88px',
              background: 'rgba(204, 88, 51, 0.12)',
              borderColor: 'rgba(204, 88, 51, 0.24)',
            }}
          >
            <div className="workspace-kicker" style={{ color: '#9b3c1f' }}>Search error</div>
            <div style={{ color: '#7c2d12', fontSize: '13px', marginTop: '6px' }}>{searchError}</div>
          </div>
        )}

        {viewMode === 'graph' && (
          <GraphCanvas
            nodes={graphState.nodes}
            edges={filteredEdges as any}
            onNodeClick={handleNodeClick}
            selectedNodeId={selectedNode?.id}
            nodeColorMap={nodeColorMap}
            clusterCenters={clusterCenters}
            clusterStrength={clusterStrength}
            highlightedNodeIds={Array.from(highlightedPaperIds)}
            focusNodeId={focusNodeId}
            mode="global"
          />
        )}

        {viewMode === 'list' && (
          <div style={{ position: 'absolute', inset: 0, paddingTop: '76px', zIndex: 1 }}>
            <PaperListView
              nodes={graphState.nodes as any}
              edges={filteredEdges as any}
              groupBy={(node) => node.cluster ?? 0}
              groupTitle={(key) => `Cluster ${key}`}
              onOpenPaper={(paperId) => {
                window.location.href = `/paper/${encodeURIComponent(paperId)}`;
              }}
              initialPrefetchCount={80}
              conferenceType="iclr"
            />
          </div>
        )}

        <div
          className="workspace-stat-chip"
          style={{
            position: 'absolute',
            left: '16px',
            bottom: '16px',
            zIndex: 4,
            padding: '10px 14px',
            fontSize: '11px',
            fontFamily: 'JetBrains Mono, monospace',
            color: 'rgba(22, 22, 22, 0.72)',
          }}
        >
          {graphState.nodes.length} papers | {numClusters} clusters | {filteredEdges.length} edges
        </div>
      </div>

      {viewMode === 'graph' && (
        <SidePanel
          selectedNode={selectedNode ? { ...selectedNode, label: selectedPaper?.title || selectedNode.label } : null}
          onClose={() => setSelectedNode(null)}
          layoutMode="docked"
          panelWidth={360}
          onNodeColorChange={(key, color) => {
            const selectedKey = selectedNode?.stableKey || key;
            handleNodeColorChange(selectedKey, color);
          }}
          onNodeColorReset={(key) => {
            const selectedKey = selectedNode?.stableKey || key;
            handleNodeColorReset(selectedKey);
          }}
          nodeColor={selectedNode?.stableKey ? nodeColorMap[selectedNode.stableKey] : undefined}
          extraContent={renderICLRDetails()}
        />
      )}
    </div>
  );
}
