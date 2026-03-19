import React, { useEffect, useRef, useCallback, useState } from 'react';
import * as d3 from 'd3';
import { GraphNode, GraphEdge } from '../lib/mcp';

interface ClusterCenters {
  [clusterId: string]: { x: number; y: number };
}

interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  mode: 'global' | 'paper';
  centerId?: string;
  selectedNodeId?: string;
  nodeColorMap?: Record<string, string>;
  clusterCenters?: ClusterCenters;
  clusterStrength?: number;
  onNodeClick?: (node: GraphNode) => void;
  onNodeDoubleClick?: (node: GraphNode) => void;
  highlightedNodeIds?: string[];
  focusNodeId?: string;
}

const CLUSTER_COLORS = ['#4299e1', '#48bb78', '#ed8936', '#9f7aea', '#f56565', '#38b2ac', '#ed64a6', '#667eea'];
const clusterColorIndex = (d: any) => ((Number((d as any).cluster ?? 0) % 8) + 8) % 8;
const isHexColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

export default function GraphCanvas({
  nodes, edges, mode, centerId, selectedNodeId, nodeColorMap,
  clusterCenters, clusterStrength = 0.15,
  onNodeClick, onNodeDoubleClick, highlightedNodeIds, focusNodeId
}: GraphCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simulationRef = useRef<any>(null);
  const stopTimerRef = useRef<number | null>(null);

  const zoomBehaviorRef = useRef<any>(null);
  const zoomSelectionRef = useRef<any>(null);
  const zoomTransformRef = useRef<any>(d3.zoomIdentity);

  const nodeSelectionRef = useRef<any>(null);
  const posCacheRef = useRef<Map<string, { x?: number; y?: number; vx?: number; vy?: number }>>(new Map());

  const nodeColorMapRef = useRef<Record<string, string>>(nodeColorMap ?? {});
  const centerIdRef = useRef<string | undefined>(centerId);

  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const { width, height } = dimensions;

  useEffect(() => { nodeColorMapRef.current = nodeColorMap ?? {}; }, [nodeColorMap]);
  useEffect(() => { centerIdRef.current = centerId; }, [centerId]);

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setDimensions({ width: containerRef.current.clientWidth || 800, height: containerRef.current.clientHeight || 600 });
      }
    };
    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, []);

  const nodeKey = useCallback((d: any) => String((d as any).stableKey ?? d?.id ?? ''), []);
  const isCenterNode = useCallback((d: any) => Boolean((d as any).is_center || d.id === centerIdRef.current), []);
  const getNodeFill = useCallback((d: any) => {
    if (isCenterNode(d)) return '#f56565';
    const key = nodeKey(d);
    const map = nodeColorMapRef.current;
    if (map[key] && isHexColor(map[key])) return map[key];
    if (map[d.id] && isHexColor(map[d.id])) return map[d.id];
    return CLUSTER_COLORS[clusterColorIndex(d)];
  }, [isCenterNode, nodeKey]);

  const updateNodeStyles = useCallback(() => {
    const sel = nodeSelectionRef.current;
    if (!sel) return;

    // Highlight logic
    const hasHighlight = highlightedNodeIds && highlightedNodeIds.length > 0;
    const highlightSet = hasHighlight ? new Set(highlightedNodeIds) : null;

    sel.select('circle')
      .attr('r', (d: any) => isCenterNode(d) ? 20 : d.id === selectedNodeId ? 18 : 12)
      .attr('fill', (d: any) => getNodeFill(d))
      .attr('stroke', (d: any) => d.id === selectedNodeId ? '#000' : '#fff')
      .attr('stroke-width', 2)
      .attr('opacity', (d: any) => {
        if (!hasHighlight) return 1;
        return highlightSet?.has(d.id) ? 1 : 0.1;
      });

    sel.select('text')
      .attr('opacity', (d: any) => {
        if (!hasHighlight) return 1;
        return highlightSet?.has(d.id) ? 1 : 0.1;
      });

  }, [selectedNodeId, isCenterNode, getNodeFill, highlightedNodeIds]);

  // Main D3 Effect
  useEffect(() => {
    if (!svgRef.current) return;

    const sim = simulationRef.current;
    if (sim) {
      const m = new Map<string, any>();
      sim.nodes().forEach((n: any) => m.set(nodeKey(n), { x: n.x, y: n.y, vx: n.vx, vy: n.vy }));
      posCacheRef.current = m;
    }

    const svg = d3.select(svgRef.current);
    if (!zoomBehaviorRef.current) {
      const zoom = d3.zoom().scaleExtent([0.1, 4]).on('zoom', (e: any) => {
        zoomTransformRef.current = e.transform;
        svg.select('g.canvas-root').attr('transform', e.transform.toString());
      });
      zoomBehaviorRef.current = zoom;
      zoomSelectionRef.current = svg;
      svg.call(zoom);
    }

    svg.selectAll('g.canvas-root').remove();
    const container = svg.append('g').attr('class', 'canvas-root').attr('transform', zoomTransformRef.current.toString());

    const graphNodes = nodes.map(n => {
      const k = nodeKey(n);
      const c = posCacheRef.current.get(k) ?? posCacheRef.current.get(n.id);
      return c ? { ...n, ...c } : { ...n };
    });
    const graphEdges = edges.map(e => ({ ...e }));

    const params = mode === 'global'
      ? { dist: 60, charge: -300, center: 0.05 }
      : { dist: 80, charge: -500, center: 0.08 };

    const simulation = d3.forceSimulation(graphNodes as any)
      .force('link', d3.forceLink(graphEdges as any).id((d: any) => d.id).distance(params.dist))
      .force('charge', d3.forceManyBody().strength(params.charge))
      .force('center', d3.forceCenter(width / 2, height / 2).strength(params.center))
      .force('collide', d3.forceCollide(30));

    if (clusterCenters) {
      simulation
        .force('clusterX', d3.forceX((d: any) => clusterCenters[d.cluster]?.x ?? width / 2).strength(clusterStrength))
        .force('clusterY', d3.forceY((d: any) => clusterCenters[d.cluster]?.y ?? height / 2).strength(clusterStrength));
    }

    simulationRef.current = simulation;
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    stopTimerRef.current = window.setTimeout(() => simulation.stop(), 3000);

    const link = container.append('g').attr('class', 'links')
      .selectAll('line').data(graphEdges).enter().append('line')
      .attr('stroke', '#cbd5e0').attr('stroke-opacity', 0.6)
      .attr('stroke-width', (d: any) => d.type === 'references' ? 1 : 2);

    const node = container.append('g').attr('class', 'nodes')
      .selectAll('g').data(graphNodes).enter().append('g')
      .style('cursor', 'pointer')
      .call(d3.drag()
        .on('start', (e: any, d: any) => { simulation.alphaTarget(0).stop(); d.fx = d.x; d.fy = d.y; })
        .on('drag', (e: any, d: any) => {
          d.fx = e.x; d.fy = e.y;
          d3.select(e.sourceEvent.target.parentNode).attr('transform', `translate(${e.x},${e.y})`);
          link
            .attr('x1', (l: any) => l.source.x).attr('y1', (l: any) => l.source.y)
            .attr('x2', (l: any) => l.target.x).attr('y2', (l: any) => l.target.y);
        })
        .on('end', (_e: any, d: any) => { if (mode !== 'paper' || d.id !== centerId) { d.fx = null; d.fy = null; } })
      );
    nodeSelectionRef.current = node as any;

    node.append('circle');
    node.append('text').attr('dy', 25).attr('text-anchor', 'middle').attr('font-size', '10px').attr('fill', '#4a5568')
      .text((d: any) => (d.title || d.id).slice(0, 20) + ((d.title || d.id).length > 20 ? '...' : ''));

    node.on('click', (e, d) => { e.stopPropagation(); onNodeClick?.(d as GraphNode); });
    node.on('dblclick', (e, d) => { e.stopPropagation(); onNodeDoubleClick?.(d as GraphNode); });

    simulation.on('tick', () => {
      link
        .attr('x1', (d: any) => d.source.x).attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x).attr('y2', (d: any) => d.target.y);
      node.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
    });

    updateNodeStyles();

    return () => { if (stopTimerRef.current) clearTimeout(stopTimerRef.current); simulation.stop(); };
  }, [nodes, edges, mode, width, height, clusterCenters, clusterStrength]);

  useEffect(() => { updateNodeStyles(); }, [updateNodeStyles, nodeColorMap, highlightedNodeIds]);

  // Focus Zoom
  useEffect(() => {
    if (!focusNodeId || !simulationRef.current || !zoomBehaviorRef.current || !zoomSelectionRef.current) return;
    const sim = simulationRef.current;
    const node: any = sim.nodes().find((n: any) => n.id === focusNodeId);
    if (!node) return;

    const scale = 1.2;
    const transform = d3.zoomIdentity.translate(width / 2 - node.x * scale, height / 2 - node.y * scale).scale(scale);
    zoomSelectionRef.current.transition().duration(750).call(zoomBehaviorRef.current.transform, transform);
  }, [focusNodeId, width, height]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%', backgroundColor: '#f7fafc' }}><svg ref={svgRef} width={width} height={height} /></div>;
}
