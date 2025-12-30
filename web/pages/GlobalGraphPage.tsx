/**
 * GlobalGraphPage (Graph B)
 *
 * Displays the global paper relationship overview.
 * [UPDATED] Adds polling to detect if Agent wants to switch to Paper View.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import GraphCanvas from '../components/GraphCanvas';
import SidePanel from '../components/SidePanel';
import { getGlobalGraph, GraphNode, GraphEdge } from '../lib/mcp';

interface GlobalGraphState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  loading: boolean;
  error: string | null;
  meta: {
    total_papers: number;
    total_edges: number;
    similarity_threshold: number;
    used_embeddings: boolean;
  } | null;
}

export default function GlobalGraphPage() {
  const navigate = useNavigate();

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

  // [NEW] Polling Ref
  const lastTimestampRef = useRef<number>(0);

  // Load global graph
  const loadGraph = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      const data = await getGlobalGraph({
        similarityThreshold,
        useEmbeddings
      });

      const meta = {
        total_papers: data.meta?.total_papers ?? data.nodes.length,
        total_edges: data.meta?.total_edges ?? data.edges.length,
        similarity_threshold: data.meta?.similarity_threshold ?? similarityThreshold,
        used_embeddings: data.meta?.used_embeddings ?? useEmbeddings,
      };
      setState({
        nodes: data.nodes,
        edges: data.edges,
        loading: false,
        error: null,
        meta
      });
    } catch (err) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load graph'
      }));
    }
  }, [similarityThreshold, useEmbeddings]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);


  /* ----------------------- [NEW] Agent Polling Logic ----------------------- */
  useEffect(() => {
    const checkUiState = async () => {
      try {
        const res = await fetch('/output/graph/ui_state.json', { cache: 'no-store' });
        if (!res.ok) return;
        
        const data = await res.json();
        
        if (data.timestamp > lastTimestampRef.current) {
          lastTimestampRef.current = data.timestamp;

          // Agent가 특정 논문을 상세히 보라고 명령한 경우
          if (data.mode === 'paper' && data.focus_id) {
            console.log("Agent Navigation Triggered (Global -> Paper):", data.focus_id);
            navigate(`/paper/${encodeURIComponent(data.focus_id)}`);
          }
          // Global 그래프를 갱신하라고 명령한 경우
          else if (data.mode === 'global') {
            console.log("Agent Refresh Triggered (Global)");
            loadGraph();
          }
        }
      } catch (e) {
        // Ignore polling errors
      }
    };

    const interval = setInterval(checkUiState, 1000);
    return () => clearInterval(interval);
  }, [navigate, loadGraph]);


  // Single click → select node (SidePanel)
  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNode(node);
  }, []);

  // Double click → move to Paper Reference Graph
  const handleNodeDoubleClick = useCallback((node: GraphNode) => {
    if (!node?.id) return;
    navigate(`/paper/${encodeURIComponent(node.id)}`);
  }, [navigate]);

  // SidePanel button action
  const handleViewPaperGraph = useCallback((paperId: string) => {
    navigate(`/paper/${encodeURIComponent(paperId)}`);
  }, [navigate]);

  const handleRebuild = useCallback(() => {
    loadGraph();
  }, [loadGraph]);

  return (
    <div style={{ display: 'flex', height: '100vh', backgroundColor: '#f5f5f5' }}>
      {/* Main Graph Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <header
          style={{
            padding: '16px 24px',
            backgroundColor: '#fff',
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: '20px', color: '#1a202c' }}>
              Global Paper Graph
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#718096' }}>
              Overview of all papers
            </p>
          </div>

          {/* Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label style={{ fontSize: '13px', color: '#4a5568' }}>Similarity:</label>
              <input
                type="range"
                min="0.3"
                max="0.95"
                step="0.05"
                value={similarityThreshold}
                onChange={(e) => setSimilarityThreshold(parseFloat(e.target.value))}
                style={{ width: '80px' }}
              />
              <span style={{ fontSize: '13px', width: '30px' }}>{similarityThreshold.toFixed(2)}</span>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
              <input
                type="checkbox"
                checked={useEmbeddings}
                onChange={(e) => setUseEmbeddings(e.target.checked)}
              />
              Embeddings
            </label>

            <button
              onClick={handleRebuild}
              disabled={state.loading}
              style={{
                padding: '8px 16px',
                backgroundColor: state.loading ? '#cbd5e0' : '#4299e1',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: state.loading ? 'not-allowed' : 'pointer'
              }}
            >
              {state.loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
        </header>

        {/* Graph Canvas */}
        <div style={{ flex: 1, position: 'relative' }}>
          {!state.loading && !state.error && (
            <GraphCanvas
              nodes={state.nodes}
              edges={state.edges}
              mode="global"
              selectedNodeId={selectedNode?.id}
              onNodeClick={handleNodeClick}
              onNodeDoubleClick={handleNodeDoubleClick}
            />
          )}
        </div>

        {/* Stats Bar */}
        {state.meta && (
          <div
            style={{
              padding: '8px 24px',
              backgroundColor: '#fff',
              borderTop: '1px solid #e2e8f0',
              display: 'flex',
              gap: '24px',
              fontSize: '12px',
              color: '#718096'
            }}
          >
            <span>Papers: {state.meta.total_papers}</span>
            <span>Edges: {state.meta.total_edges}</span>
          </div>
        )}
      </div>

      {/* Side Panel */}
      <SidePanel
        selectedNode={selectedNode}
        mode="global"
        onAction={handleViewPaperGraph}
        onClose={() => setSelectedNode(null)}
      />
    </div>
  );
}