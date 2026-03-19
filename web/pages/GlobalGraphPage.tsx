import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import GraphCanvas from '../components/GraphCanvas';
import SidePanel from '../components/SidePanel';
import ArxivSearchSidebar from '../components/ArxivSearchSidebar';
import ArxivRankedList from '../components/ArxivRankedList';
import PaperListView from '../components/PaperListView';
import { getGlobalGraph, rebuildGlobalGraph, GraphNode, executeRankFilterPipeline } from '../lib/mcp';
import { recordRecentPaper } from '../lib/recentPapers';
import { ScoredPaper } from '../components/PaperResultCard';
import { useNodeColors } from '../hooks/useNodeColors';

interface GlobalGraphState {
  nodes: GraphNode[];
  edges: any[];
  loading: boolean;
  error: string | null;
  meta: any;
}

function normalizeArxivToDoiLike(id: string): string {
  if (!id) return id;
  if (id.startsWith('10.48550_arxiv.')) return id;
  const m = id.match(/^(\d{4}\.\d{4,5})(v\d+)?$/);
  if (m) return `10.48550_arxiv.${m[1]}`;
  return id;
}

function getStableKey(node: any): string {
  if (node?.stableKey) return String(node.stableKey);
  const id = String(node?.id ?? '');
  const normalized = normalizeArxivToDoiLike(id);
  return `paper:${normalized || id}`;
}

export default function GlobalGraphPage() {
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState<'graph' | 'list'>('graph');

  const [state, setState] = useState<GlobalGraphState>({
    nodes: [],
    edges: [],
    loading: true,
    error: null,
    meta: null
  });

  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [similarityThreshold, setSimilarityThreshold] = useState(0.7);
  const [useEmbeddings, setUseEmbeddings] = useState(true);

  // Search & Ranking state
  const [showSearchSidebar, setShowSearchSidebar] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ScoredPaper[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [highlightedPaperIds, setHighlightedPaperIds] = useState<Set<string>>(new Set());
  const [focusNodeId, setFocusNodeId] = useState<string | undefined>(undefined);
  const [searchError, setSearchError] = useState<string | null>(null);

  const lastTimestampRef = useRef<number>(0);
  const lastGraphSigRef = useRef<string | null>(null);

  const {
    nodeColorMap,
    setNodeColor: handleNodeColorChange,
    resetNodeColor: handleNodeColorReset
  } = useNodeColors();

  const loadGraph = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const data = await getGlobalGraph();
      const nodesWithKey = (data.nodes || []).map((n: any) => ({
        ...n,
        stableKey: getStableKey(n)
      })) as any as GraphNode[];

      setState({
        nodes: nodesWithKey,
        edges: data.edges || [],
        loading: false,
        error: data.meta?.error || null,
        meta: data.meta
      });

      setSelectedNode(prev => {
        if (!prev) return prev;
        const prevKey = getStableKey(prev as any);
        const found = (nodesWithKey as any[]).find(nn => getStableKey(nn) === prevKey);
        return (found as any) || prev;
      });
    } catch (err) {
      setState(prev => ({ ...prev, loading: false, error: String(err) }));
    }
  }, []);

  const handleRebuild = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const data = await rebuildGlobalGraph(similarityThreshold, useEmbeddings);
      const nodesWithKey = (data.nodes || []).map((n: any) => ({
        ...n,
        stableKey: getStableKey(n)
      })) as any as GraphNode[];

      setState({
        nodes: nodesWithKey,
        edges: data.edges || [],
        loading: false,
        error: null,
        meta: data.meta
      });
    } catch (err) {
      setState(prev => ({ ...prev, loading: false, error: String(err) }));
    }
  }, [similarityThreshold, useEmbeddings]);

  useEffect(() => { loadGraph(); }, [loadGraph]);

  useEffect(() => {
    const checkUiState = async () => {
      try {
        const res = await fetch('/output/graph/ui_state.json', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (data.timestamp > lastTimestampRef.current) {
          lastTimestampRef.current = data.timestamp;
          if (data.mode === 'paper' && data.focus_id) {
            navigate(`/paper/${encodeURIComponent(data.focus_id)}`);
          } else if (data.mode === 'global') {
            loadGraph();
          }
        }
      } catch { }
    };
    const interval = window.setInterval(checkUiState, 1000);
    return () => window.clearInterval(interval);
  }, [navigate, loadGraph]);

  useEffect(() => {
    const url = '/output/graph/global_graph.json';
    const checkGlobalGraph = async () => {
      try {
        const head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        const sig = head.headers.get('etag') ?? head.headers.get('last-modified');
        if (sig) {
          if (lastGraphSigRef.current && lastGraphSigRef.current !== sig) await loadGraph();
          lastGraphSigRef.current = sig;
          return;
        }
        const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const text = await res.text();
        const sig2 = `${text.length}`;
        if (lastGraphSigRef.current && lastGraphSigRef.current !== sig2) await loadGraph();
        lastGraphSigRef.current = sig2;
      } catch { }
    };
    const interval = window.setInterval(checkGlobalGraph, 1000);
    return () => window.clearInterval(interval);
  }, [loadGraph]);

  const handleNodeClick = useCallback((node: GraphNode) => setSelectedNode(node), []);
  const handleNodeDoubleClick = useCallback((node: GraphNode) => {
    if (node?.id) navigate(`/paper/${encodeURIComponent(node.id)}`);
  }, [navigate]);
  const handleViewPaperGraph = useCallback((paperId: string) => navigate(`/paper/${encodeURIComponent(paperId)}`), [navigate]);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true); setSearchError(null); setSearchResults([]); setHighlightedPaperIds(new Set());
    try {
      const result = await executeRankFilterPipeline({ query: searchQuery.trim(), max_results: 50, top_k: 10 });
      if (result.success && result.ranked_papers) {
        setSearchResults(result.ranked_papers);
        const highlightedSet = new Set<string>();
        result.ranked_papers.forEach(paper => {
          const matchingNode = state.nodes.find(n => {
            const nodeId = String(n.id || '');
            const paperId = String(paper.paper_id || '');
            return nodeId === paperId || nodeId.includes(paperId) || paperId.includes(nodeId);
          });
          if (matchingNode) highlightedSet.add(matchingNode.id);
          else highlightedSet.add(paper.paper_id);
        });
        setHighlightedPaperIds(highlightedSet);
      } else throw new Error(result.error || 'Search failed');
    } catch (err) { setSearchError(err instanceof Error ? err.message : 'Failed to search papers'); }
    finally { setIsSearching(false); }
  }, [searchQuery, state.nodes]);

  const handlePaperClick = useCallback((paperId: string) => {
    const node = state.nodes.find(n => {
      const nodeId = String(n.id || '');
      const pId = String(paperId || '');
      return nodeId === pId || nodeId.includes(pId) || pId.includes(nodeId);
    });
    if (node) {
      setSelectedNode(node);
      setFocusNodeId(node.id);
      setTimeout(() => setFocusNodeId(undefined), 700);
    }
  }, [state.nodes]);

  useEffect(() => {
    if (!selectedNode?.id) {
      return;
    }

    recordRecentPaper({
      paperId: normalizeArxivToDoiLike(String(selectedNode.id)),
      title: String(selectedNode.title || selectedNode.label || selectedNode.id),
      venue: 'Workspace',
      route: `/paper/${encodeURIComponent(String(selectedNode.id))}`
    });
  }, [selectedNode]);

  const selectedKey = selectedNode ? getStableKey(selectedNode as any) : '';

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, overflow: 'hidden', backgroundColor: '#f5f5f5' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <header style={{ padding: '16px 24px', backgroundColor: '#fff', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <h1 style={{ margin: 0, fontSize: '20px', color: '#1a202c' }}>Global Paper Graph</h1>
            <div style={{ display: 'flex', backgroundColor: '#edf2f7', borderRadius: '6px', padding: '2px' }}>
              <button onClick={() => setViewMode('graph')} style={{ padding: '6px 12px', borderRadius: '4px', border: 'none', backgroundColor: viewMode === 'graph' ? '#fff' : 'transparent', color: viewMode === 'graph' ? '#2d3748' : '#718096', fontWeight: viewMode === 'graph' ? 600 : 400, boxShadow: viewMode === 'graph' ? '0 1px 2px rgba(0,0,0,0.1)' : 'none', cursor: 'pointer', fontSize: '13px' }}>Node</button>
              <button onClick={() => setViewMode('list')} style={{ padding: '6px 12px', borderRadius: '4px', border: 'none', backgroundColor: viewMode === 'list' ? '#fff' : 'transparent', color: viewMode === 'list' ? '#2d3748' : '#718096', fontWeight: viewMode === 'list' ? 600 : 400, boxShadow: viewMode === 'list' ? '0 1px 2px rgba(0,0,0,0.1)' : 'none', cursor: 'pointer', fontSize: '13px' }}>List</button>
            </div>
            <p style={{ margin: 0, fontSize: '13px', color: '#718096', borderLeft: '1px solid #cbd5e0', paddingLeft: '16px' }}>Overview of all papers</p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label style={{ fontSize: '13px', color: '#4a5568' }}>Sim:</label>
              <input type="range" min="0.3" max="0.95" step="0.05" value={similarityThreshold} onChange={(e) => setSimilarityThreshold(parseFloat(e.target.value))} style={{ width: '70px' }} />
              <span style={{ fontSize: '13px', width: '28px' }}>{similarityThreshold.toFixed(2)}</span>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
              <input type="checkbox" checked={useEmbeddings} onChange={(e) => setUseEmbeddings(e.target.checked)} />
              Embed
            </label>
            <button onClick={() => setShowSearchSidebar(!showSearchSidebar)} style={{ padding: '8px 16px', backgroundColor: showSearchSidebar ? '#2d3748' : '#48bb78', color: '#', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>ArxivSearch</button>
            <button onClick={handleRebuild} disabled={state.loading} style={{ padding: '8px 16px', backgroundColor: state.loading ? '#cbd5e0' : '#4299e1', color: '#fff', border: 'none', borderRadius: '6px', cursor: state.loading ? 'not-allowed' : 'pointer' }}>{state.loading ? '...' : 'Refresh'}</button>
          </div>
        </header>

        <div style={{ flex: 1, position: 'relative', minWidth: 0, minHeight: 0 }}>
          {!state.loading && !state.error && showSearchSidebar && (
            <div style={{ position: 'absolute', top: '16px', right: '16px', zIndex: 10 }}>
              <ArxivSearchSidebar searchQuery={searchQuery} onSearchQueryChange={setSearchQuery} onSearch={handleSearch} isSearching={isSearching} />
            </div>
          )}

          {!state.loading && !state.error && isSearching && <div style={{ position: 'absolute', bottom: '16px', right: '16px', zIndex: 5, backgroundColor: 'rgba(255, 255, 255, 0.95)', padding: '16px', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', fontSize: '14px', textAlign: 'center' }}>Searching...</div>}
          {!state.loading && !state.error && searchResults.length > 0 && <ArxivRankedList papers={searchResults} onPaperClick={handlePaperClick} onClose={() => { setSearchResults([]); setSearchQuery(''); setHighlightedPaperIds(new Set()); }} />}
          {searchError && <div style={{ position: 'absolute', bottom: '80px', right: '16px', zIndex: 6, backgroundColor: '#f56565', padding: '12px 16px', borderRadius: '8px', color: '#fff' }}>{searchError}</div>}

          {!state.loading && !state.error && viewMode === 'graph' && (
            <GraphCanvas
              nodes={state.nodes}
              edges={state.edges as any}
              mode="global"
              selectedNodeId={selectedNode?.id}
              onNodeClick={handleNodeClick}
              onNodeDoubleClick={handleNodeDoubleClick}
              nodeColorMap={nodeColorMap}
              highlightedNodeIds={Array.from(highlightedPaperIds)}
              focusNodeId={focusNodeId}
            />
          )}

          {!state.loading && !state.error && viewMode === 'list' && (
            <PaperListView
              nodes={state.nodes as any}
              edges={state.edges as any}
              groupBy={(n) => (n.cluster ?? '0')}
              groupTitle={(k) => `Category ${k}`}
              onOpenPaper={(paperId) => navigate(`/paper/${encodeURIComponent(paperId)}`)}
              initialPrefetchCount={60}
            />
          )}
        </div>

        {state.meta && (
          <div style={{ padding: '8px 24px', backgroundColor: '#fff', borderTop: '1px solid #e2e8f0', display: 'flex', gap: '24px', fontSize: '12px', color: '#718096' }}>
            <span>Papers: {state.meta.total_papers}</span>
            <span>Edges: {state.meta.total_edges}</span>
          </div>
        )}
      </div>

      {viewMode === 'graph' && (
        <SidePanel
          selectedNode={selectedNode}
          mode="global"
          onAction={() => { if (selectedNode?.id) handleViewPaperGraph(selectedNode.id); }}
          onNavigate={(node) => handleViewPaperGraph(node.id)}
          onClose={() => setSelectedNode(null)}
          nodeColorMap={nodeColorMap}
          nodeColor={selectedNode ? (nodeColorMap[selectedKey] ?? nodeColorMap[selectedNode.id]) : undefined}
          onNodeColorChange={(keyOrId, color) => { const k = selectedNode ? getStableKey(selectedNode as any) : keyOrId; handleNodeColorChange(k, color); }}
          onNodeColorReset={(keyOrId) => { const k = selectedNode ? getStableKey(selectedNode as any) : keyOrId; handleNodeColorReset(k); }}
        />
      )}
    </div>
  );
}
