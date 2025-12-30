/**
 * MCP REST Client
 *
 * Handles all communication with the MCP backend server.
 * Web UI should NEVER perform side-effects directly.
 */

// Use /api prefix for Vite proxy to forward requests to MCP server
const MCP_BASE_URL = '/api';

// Types
export interface GraphNode {
  id: string;
  title: string;
  paper_id?: string;
  authors?: string[];
  abstract?: string;
  year?: number;
  cluster?: number;
  depth?: number;
  is_center?: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight?: number;
  type: 'references' | 'similarity';
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta?: Record<string, any>;
}

export interface GraphDiff {
  new_nodes: GraphNode[];
  new_edges: GraphEdge[];
  is_incremental: boolean;
}

// API Functions

/**
 * Health check
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${MCP_BASE_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get list of available tools
 */
export async function getTools(): Promise<any[]> {
  const response = await fetch(`${MCP_BASE_URL}/tools`);
  if (!response.ok) throw new Error('Failed to fetch tools');
  const data = await response.json();
  return data.tools;
}

/**
 * Execute a tool
 */
export async function executeTool(
  toolName: string,
  args: Record<string, any> = {}
): Promise<any> {
  const response = await fetch(`${MCP_BASE_URL}/tools/${toolName}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ arguments: args })
  });

  if (!response.ok) {
    throw new Error(`Tool execution failed: ${response.statusText}`);
  }

  return response.json();
}

// ==================== Graph B (Global) API ====================

/**
 * Get global graph data (Graph B)
 */
export interface GlobalGraphOptions {
  similarityThreshold?: number;
  useEmbeddings?: boolean;
}

export async function getGlobalGraph(
  options: GlobalGraphOptions = {}
): Promise<GraphData> {
  const { similarityThreshold = 0.7, useEmbeddings = true } = options;

  const result = await executeTool('build_global_graph', {
    similarity_threshold: similarityThreshold,
    use_embeddings: useEmbeddings
  });

  if (!result.success) {
    throw new Error(result.error || 'Failed to build global graph');
  }

  return result.result;
}

// ==================== Graph A (Paper) API ====================

/**
 * Get paper reference subgraph (Graph A) - Initial load
 */
export async function getPaperGraph(paperId: string, depth: number = 1): Promise<GraphData> {
  const result = await executeTool('build_reference_subgraph', {
    paper_id: paperId,
    depth: depth,
    existing_nodes: []
  });

  if (!result.success) {
    throw new Error(result.error || 'Failed to build paper graph');
  }

  return {
    nodes: result.result.new_nodes,
    edges: result.result.new_edges,
    meta: { center: result.result.center }
  };
}

/**
 * Expand paper graph (Graph A) - Incremental update
 */
export async function expandPaperGraph(
  paperId: string,
  existingNodeIds: string[]
): Promise<GraphDiff> {
  const result = await executeTool('build_reference_subgraph', {
    paper_id: paperId,
    depth: 1,
    existing_nodes: existingNodeIds
  });

  if (!result.success) {
    throw new Error(result.error || 'Failed to expand paper graph');
  }

  return {
    new_nodes: result.result.new_nodes,
    new_edges: result.result.new_edges,
    is_incremental: result.result.is_incremental
  };
}

/**
 * Check if paper PDF exists
 */
export async function hasPdf(paperId: string): Promise<{ exists: boolean }> {
  const result = await executeTool('has_pdf', { paper_id: paperId });
  return { exists: result.success && result.result?.exists };
}

/**
 * Fetch paper if missing
 */
export async function fetchPaperIfMissing(paperId: string): Promise<{
  action: 'already_exists' | 'downloaded';
  path: string;
}> {
  const result = await executeTool('fetch_paper_if_missing', {
    paper_id: paperId
  });

  if (!result.success) {
    throw new Error(result.error || 'Failed to fetch paper');
  }

  return result.result;
}

/**
 * Get paper references
 */
export async function getReferences(paperId: string): Promise<{
  references: Array<{ arxiv_id: string }>;
  from_cache: boolean;
}> {
  const result = await executeTool('get_references', { paper_id: paperId });

  if (!result.success) {
    throw new Error(result.error || 'Failed to get references');
  }

  return result.result;
}

// ==================== PDF API ====================

/**
 * List all PDFs
 */
export async function listPdfs(): Promise<Array<{
  filename: string;
  size_mb: number;
}>> {
  const result = await executeTool('list_pdfs', {});

  if (!result.success) {
    throw new Error(result.error || 'Failed to list PDFs');
  }

  return result.result.files;
}

/**
 * Process all PDFs
 */
export async function processAllPdfs(): Promise<any> {
  const result = await executeTool('process_all_pdfs', {});

  if (!result.success) {
    throw new Error(result.error || 'Failed to process PDFs');
  }

  return result.result;
}
