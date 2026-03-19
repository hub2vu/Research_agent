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
  label?: string;
  stableKey?: string;
  type?: string;
  x?: number;
  y?: number;
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
  type?: 'references' | 'similarity' | string;
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
// ==================== Report API (tools/report.py) ====================
export async function getReport(paperId: string): Promise<{ found: boolean; content?: string; message?: string }> {
  const result = await executeTool('get_report', { paper_id: paperId });
  if (!result.success) throw new Error(result.error || 'get_report failed');
  return result.result as any;
}

export async function generateReport(paperId: string): Promise<any> {
  const result = await executeTool('generate_report', { paper_id: paperId });
  if (!result.success) throw new Error(result.error || 'generate_report failed');
  return result.result;
}

/**
 * get_report -> 없으면 generate_report(오직 이때만) -> get_report 재시도
 * ReportViewer 토글에서 "자동 생성" 동작을 위한 헬퍼
 */
export async function getOrCreateReport(
  paperId: string
): Promise<{ content: string }> {
  const first = await getReport(paperId);
  if (first.found) {
    return { content: first.content || '' };
  }

  // ✅ report txt가 없는 경우에만 생성 메카니즘 작동
  await generateReport(paperId);

  const second = await getReport(paperId);
  if (second.found) {
    return { content: second.content || '' };
  }

  throw new Error(second.message || 'Report still not found after generation');
}


// ==================== Graph B (Global) API ====================

/**
 * Get global graph data (Graph B) - loads from global_graph.json
 */
export async function getGlobalGraph(): Promise<GraphData> {
  const result = await executeTool('get_global_graph', {});

  if (!result.success) {
    throw new Error(result.error || 'Failed to get global graph');
  }

  return result.result;
}

/**
 * Rebuild global graph with new parameters
 */
export async function rebuildGlobalGraph(
  similarityThreshold: number = 0.7,
  useEmbeddings: boolean = true
): Promise<GraphData> {
  const result = await executeTool('build_global_graph', {
    similarity_threshold: similarityThreshold,
    use_embeddings: useEmbeddings
  });

  if (!result.success) {
    throw new Error(result.error || 'Failed to rebuild global graph');
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

// ==================== Rank Filter API ====================

export interface PaperInput {
  paper_id: string;
  title: string;
  abstract: string;
  authors: string[];
  published?: string;
  categories?: string[];
  pdf_url?: string;
  github_url?: string | null;
}

export interface RankFilterPipelineParams {
  query: string;
  max_results?: number;
  purpose?: string;
  ranking_mode?: string;
  top_k?: number;
  include_contrastive?: boolean;
  contrastive_type?: string;
  exclude_local_papers?: boolean;
}

export interface UserProfile {
  interests: {
    primary: string[];
    secondary: string[];
    exploratory: string[];
  };
  keywords: {
    must_include: string[];
    exclude: {
      hard: string[];
      soft: string[];
    };
  };
  preferred_authors: string[];
  preferred_institutions: string[];
  constraints: {
    min_year: number;
    require_code: boolean;
    exclude_local_papers: boolean;
  };
  purpose?: string;
  ranking_mode?: string;
  top_k?: number;
  include_contrastive?: boolean;
  contrastive_type?: string;
  exclude_local_papers?: boolean;
}

/**
 * Search arXiv and convert results to PaperInput format
 */
export async function searchArxivForRanking(
  query: string,
  maxResults: number = 50
): Promise<{
  query: string;
  total_results: number;
  papers: PaperInput[];
}> {
  const response = await fetch(`${MCP_BASE_URL}/arxiv/search-for-ranking`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, max_results: maxResults })
  });

  if (!response.ok) {
    throw new Error(`Failed to search arXiv: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Execute the full rank and filter pipeline
 */
export async function executeRankFilterPipeline(
  params: RankFilterPipelineParams
): Promise<any> {
  const response = await fetch(`${MCP_BASE_URL}/rank-filter/execute-pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || 'Failed to execute pipeline');
  }

  return response.json();
}

/**
 * Get user profile
 */
export async function getUserProfile(
  profilePath: string = 'users/profile.json'
): Promise<UserProfile> {
  const response = await fetch(`${MCP_BASE_URL}/rank-filter/profile?profile_path=${encodeURIComponent(profilePath)}`);

  if (!response.ok) {
    throw new Error(`Failed to get profile: ${response.statusText}`);
  }

  const data = await response.json();
  return data.profile;
}

/**
 * Update user profile
 */
export async function updateUserProfile(
  profile: Partial<UserProfile>,
  profilePath: string = 'users/profile.json'
): Promise<any> {
  const response = await fetch(`${MCP_BASE_URL}/rank-filter/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profile_path: profilePath,
      ...profile
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || 'Failed to update profile');
  }

  return response.json();
}

// ==================== NeurIPS Search & Rank API ====================

/**
 * Execute NeurIPS search and rank pipeline
 */
export async function executeNeurIPSSearchAndRank(
  query: string,
  profilePath: string = 'users/profile.json',
  topK: number = 10,
  clusterK?: number
): Promise<{
  ranked_papers: Array<{
    rank: number;
    paper_id: string;
    title: string;
    authors: string[];
    published?: string;
    score: {
      final: number;
      breakdown: any;
      soft_penalty: number;
      penalty_keywords: string[];
      evaluation_method: string;
    };
    tags: string[];
    local_status: {
      already_downloaded: boolean;
      local_path: string | null;
    };
    original_data: any;
    reasoning?: string;
  }>;
  success: boolean;
  error?: string;
}> {
  try {
    // Step 1: Search NeurIPS papers
    const searchResult = await executeTool('neurips_search', {
      query,
      max_results: 100,
      profile_path: profilePath,
    });

    if (!searchResult.success) {
      return {
        ranked_papers: [],
        success: false,
        error: searchResult.error || 'NeurIPS search failed',
      };
    }

    if (!searchResult.result?.papers || searchResult.result.papers.length === 0) {
      return {
        ranked_papers: [],
        success: true,
      };
    }

    // Step 2: Apply hard filters
    const filterResult = await executeTool('apply_hard_filters', {
      papers: searchResult.result.papers,
      profile_path: profilePath,
    });

    if (!filterResult.success) {
      throw new Error(filterResult.error || 'Hard filters failed');
    }

    const passedPapers = filterResult.result?.passed_papers || [];

    if (passedPapers.length === 0) {
      return {
        ranked_papers: [],
        success: true,
      };
    }

    // Step 3: Calculate semantic scores
    const semanticResult = await executeTool('calculate_semantic_scores', {
      papers: passedPapers,
      query,
      profile_path: profilePath,
    });

    if (!semanticResult.success) {
      throw new Error(semanticResult.error || 'Semantic scoring failed');
    }

    const semanticScores = semanticResult.result?.scores || {};

    // Step 4: Evaluate metrics (with NeurIPS cluster map)
    // Load cluster map with cluster_k parameter (default: 15)
    const clusterKToUse = clusterK ?? 15;
    let neuripsClusterMap: Record<string, number> = {};
    try {
      const clusterRes = await fetch(`/api/neurips/clusters?k=${clusterKToUse}`);
      if (clusterRes.ok) {
        const clusterData = await clusterRes.json();
        neuripsClusterMap = clusterData.paper_id_to_cluster || {};
      }
    } catch (e) {
      console.warn('Failed to load cluster map:', e);
    }

    const metricsResult = await executeTool('evaluate_paper_metrics', {
      papers: passedPapers,
      semantic_scores: semanticScores,
      neurips_cluster_map: neuripsClusterMap,
      profile_path: profilePath,
    });

    if (!metricsResult.success) {
      throw new Error(metricsResult.error || 'Metrics evaluation failed');
    }

    const metricsScores = metricsResult.result?.scores || {};

    // Step 5: Rank and select top K
    const rankResult = await executeTool('rank_and_select_top_k', {
      papers: passedPapers,
      semantic_scores: semanticScores,
      metrics_scores: metricsScores,
      neurips_cluster_map: neuripsClusterMap,
      top_k: topK,
      profile_path: profilePath,
      cluster_k: clusterKToUse,
    });

    if (!rankResult.success) {
      throw new Error(rankResult.error || 'Ranking failed');
    }

    return {
      ranked_papers: rankResult.result?.ranked_papers || [],
      success: true,
    };
  } catch (error) {
    return {
      ranked_papers: [],
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ==================== ICLR Search & Rank API ====================

/**
 * Execute ICLR search and rank pipeline
 */
export async function executeICLRSearchAndRank(
  query: string,
  profilePath: string = 'users/profile.json',
  topK: number = 10,
  clusterK?: number
): Promise<{
  ranked_papers: Array<{
    rank: number;
    paper_id: string;
    title: string;
    authors: string[];
    published?: string;
    score: {
      final: number;
      breakdown: any;
      soft_penalty: number;
      penalty_keywords: string[];
      evaluation_method: string;
    };
    tags: string[];
    local_status: {
      already_downloaded: boolean;
      local_path: string | null;
    };
    original_data: any;
    reasoning?: string;
  }>;
  success: boolean;
  error?: string;
}> {
  try {
    // Step 1: Search ICLR papers
    const searchResult = await executeTool('iclr_search', {
      query,
      max_results: 100,
      profile_path: profilePath,
    });

    if (!searchResult.success) {
      return {
        ranked_papers: [],
        success: false,
        error: searchResult.error || 'ICLR search failed',
      };
    }

    if (!searchResult.result?.papers || searchResult.result.papers.length === 0) {
      return {
        ranked_papers: [],
        success: true,
      };
    }

    // Step 2: Apply hard filters
    const filterResult = await executeTool('apply_hard_filters', {
      papers: searchResult.result.papers,
      profile_path: profilePath,
    });

    if (!filterResult.success) {
      throw new Error(filterResult.error || 'Hard filters failed');
    }

    const passedPapers = filterResult.result?.passed_papers || [];

    if (passedPapers.length === 0) {
      return {
        ranked_papers: [],
        success: true,
      };
    }

    // Step 3: Calculate semantic scores
    const semanticResult = await executeTool('calculate_semantic_scores', {
      papers: passedPapers,
      query,
      profile_path: profilePath,
    });

    if (!semanticResult.success) {
      throw new Error(semanticResult.error || 'Semantic scoring failed');
    }

    const semanticScores = semanticResult.result?.scores || {};

    // Step 4: Evaluate metrics (with ICLR cluster map)
    const clusterKToUse = clusterK ?? 15;
    let iclrClusterMap: Record<string, number> = {};
    try {
      const clusterRes = await fetch(`/api/iclr/clusters?k=${clusterKToUse}`);
      if (clusterRes.ok) {
        const clusterData = await clusterRes.json();
        iclrClusterMap = clusterData.paper_id_to_cluster || {};
      }
    } catch (e) {
      console.warn('Failed to load ICLR cluster map:', e);
    }

    const metricsResult = await executeTool('evaluate_paper_metrics', {
      papers: passedPapers,
      semantic_scores: semanticScores,
      neurips_cluster_map: iclrClusterMap,
      profile_path: profilePath,
    });

    if (!metricsResult.success) {
      throw new Error(metricsResult.error || 'Metrics evaluation failed');
    }

    const metricsScores = metricsResult.result?.scores || {};

    // Step 5: Rank and select top K
    const rankResult = await executeTool('rank_and_select_top_k', {
      papers: passedPapers,
      semantic_scores: semanticScores,
      metrics_scores: metricsScores,
      neurips_cluster_map: iclrClusterMap,
      top_k: topK,
      profile_path: profilePath,
      cluster_k: clusterKToUse,
    });

    if (!rankResult.success) {
      throw new Error(rankResult.error || 'Ranking failed');
    }

    return {
      ranked_papers: rankResult.result?.ranked_papers || [],
      success: true,
    };
  } catch (error) {
    return {
      ranked_papers: [],
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ==================== Research Agent Pipeline API ====================

export interface LocalPdfInfo {
  filename: string;
  path: string;
  relative_path?: string;
  size_bytes: number;
  size_mb: number;
  already_extracted?: boolean;
}

export interface PipelineConfig {
  paper_ids: string[];
  goal?: string;
  analysis_mode?: 'quick' | 'standard' | 'deep';
  discord_webhook_full?: string;
  discord_webhook_summary?: string;
  source?: 'arxiv' | 'neurips' | 'iclr' | 'local';
}

export interface PipelineResult {
  success: boolean;
  papers_analyzed?: number;
  report_path?: string;
  executive_summary?: string;
  reasoning_log_count?: number;
  notifications?: {
    discord_full?: { success: boolean; error?: string };
    discord_summary?: { success: boolean; error?: string };
  };
  errors?: string[];
}

/**
 * List all local PDFs available for analysis
 */
export async function listLocalPdfs(): Promise<LocalPdfInfo[]> {
  const result = await executeTool('list_pdfs', {});
  
  if (!result.success) {
    throw new Error(result.error || 'Failed to list PDFs');
  }
  
  return result.result.files || [];
}

/**
 * Run the LLM-orchestrated research agent pipeline in background
 */
export async function runResearchAgent(config: PipelineConfig): Promise<{ success: boolean; job_id?: string; error?: string }> {
  const response = await fetch(`${MCP_BASE_URL}/agent/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ arguments: {
      paper_ids: config.paper_ids,
      goal: config.goal || 'general understanding',
      analysis_mode: config.analysis_mode || 'quick',
      discord_webhook_full: config.discord_webhook_full || '',
      discord_webhook_summary: config.discord_webhook_summary || '',
      source: config.source || 'local',
    }})
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    return {
      success: false,
      error: error.detail || 'Failed to start pipeline',
    };
  }
  
  const data = await response.json();
  return {
    success: true,
    job_id: data.job_id,
  };
}

// ==================== Conference Pipeline API ====================

export interface ConferencePipelineConfig {
  source: 'arxiv' | 'neurips';
  query: string;
  top_k?: number;
  goal?: string;
  analysis_mode?: 'quick' | 'standard' | 'deep';
  discord_webhook_full?: string;
  discord_webhook_summary?: string;
  profile_path?: string;
}

/**
 * Run the conference pipeline (arXiv/NeurIPS) in background.
 * Searches, ranks, downloads, extracts, and analyzes papers automatically.
 */
export async function runConferencePipeline(config: ConferencePipelineConfig): Promise<{
  success: boolean;
  job_id?: string;
  source?: string;
  query?: string;
  top_k?: number;
  error?: string;
}> {
  const response = await fetch(`${MCP_BASE_URL}/agent/conference-pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: config.source,
      query: config.query,
      top_k: config.top_k ?? 3,
      goal: config.goal || 'general understanding',
      analysis_mode: config.analysis_mode || 'quick',
      discord_webhook_full: config.discord_webhook_full || '',
      discord_webhook_summary: config.discord_webhook_summary || '',
      profile_path: config.profile_path || 'users/profile.json',
    })
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    return {
      success: false,
      error: error.detail || 'Failed to start conference pipeline',
    };
  }
  
  const data = await response.json();
  return {
    success: true,
    job_id: data.job_id,
    source: data.source,
    query: data.query,
    top_k: data.top_k,
  };
}

/**
 * Get the status of a running pipeline job
 */
export async function getAgentStatus(jobId: string): Promise<{
  success: boolean;
  job_id: string;
  status: 'running' | 'completed' | 'failed';
  current_step: string;
  progress_percent: number;
  papers: string[];
  current_paper_idx: number;
  paper_results_count: number;
  reasoning_log_count: number;
  errors: string[];
  created_at: string;
  updated_at: string;
  result?: {
    report_path: string;
    report_exists: boolean;
  };
}> {
  const response = await fetch(`${MCP_BASE_URL}/agent/status/${jobId}`);
  
  if (!response.ok) {
    throw new Error(`Failed to get status: ${response.statusText}`);
  }
  
  return response.json();
}

/**
 * List all agent jobs
 */
export async function listAgentJobs(): Promise<Array<{
  job_id: string;
  status: string;
  goal: string;
  papers_count: number;
  progress_percent: number;
  created_at: string;
  updated_at: string;
}>> {
  const response = await fetch(`${MCP_BASE_URL}/agent/jobs`);
  
  if (!response.ok) {
    throw new Error(`Failed to list jobs: ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.jobs || [];
}

// ==================== Service Credentials ====================

export interface ServiceCredentialsConfig {
  openai_api_key: string;
  tavily_api_key: string;
  settings_path?: string;
}

export async function getServiceCredentials(): Promise<ServiceCredentialsConfig> {
  const response = await fetch(`${MCP_BASE_URL}/config/credentials`);
  if (!response.ok) {
    throw new Error(`Failed to load service credentials: ${response.statusText}`);
  }
  const data = await response.json();
  return {
    openai_api_key: data.openai_api_key || '',
    tavily_api_key: data.tavily_api_key || '',
    settings_path: data.settings_path,
  };
}

export async function updateServiceCredentials(payload: {
  openai_api_key: string;
  tavily_api_key: string;
}): Promise<ServiceCredentialsConfig & { success: boolean }> {
  const response = await fetch(`${MCP_BASE_URL}/config/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || 'Failed to update service credentials');
  }
  const data = await response.json();
  return {
    success: !!data.success,
    openai_api_key: data.openai_api_key || '',
    tavily_api_key: data.tavily_api_key || '',
    settings_path: data.settings_path,
  };
}

// ==================== Discord Config ====================

export async function getDiscordConfig(): Promise<{
  discord_webhook_full: string;
  discord_webhook_summary: string;
  settings_path?: string;
}> {
  const response = await fetch(`${MCP_BASE_URL}/config/discord`);
  if (!response.ok) {
    throw new Error(`Failed to load Discord config: ${response.statusText}`);
  }
  const data = await response.json();
  return {
    discord_webhook_full: data.discord_webhook_full || '',
    discord_webhook_summary: data.discord_webhook_summary || '',
    settings_path: data.settings_path,
  };
}

export async function updateDiscordConfig(payload: {
  discord_webhook_full: string;
  discord_webhook_summary: string;
}): Promise<{ success: boolean; settings_path?: string }> {
  const response = await fetch(`${MCP_BASE_URL}/config/discord`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || 'Failed to update Discord config');
  }
  const data = await response.json();
  return { success: !!data.success, settings_path: data.settings_path };
}

/**
 * Test notification configuration
 */
export async function testNotifications(
  discordWebhookFull?: string,
  discordWebhookSummary?: string
): Promise<{
  discord_full?: { success: boolean; error?: string };
  discord_summary?: { success: boolean; error?: string };
  environment_status: Record<string, string>;
}> {
  const result = await executeTool('test_notifications', {
    discord_webhook_full: discordWebhookFull || '',
    discord_webhook_summary: discordWebhookSummary || '',
  });

  if (!result.success) {
    throw new Error(result.error || 'Failed to test notifications');
  }

  return {
    discord_full: result.result.test_results?.discord_full,
    discord_summary: result.result.test_results?.discord_summary,
    environment_status: result.result.environment_status || {},
  };
}

// ==================== Notion API ====================

export interface NotionConnectionStatus {
  connected: boolean;
  server_url: string;
  workspace_id: string;
  workspace_name: string;
  workspace_icon: string;
  bot_id: string;
  owner_user_id: string;
  connected_at: string;
  expires_at: string;
  settings_path?: string;
}

export interface NotionPageSummary {
  id: string;
  url: string;
  title: string;
  path: string;
  kind: string;
}

export interface SaveNotionNotesPayload {
  paper_id: string;
  paper_title: string;
  notes: Array<Record<string, any>>;
  target_page_id: string;
  destination_title: string;
  create_new_page: boolean;
  updated_at?: string;
}

export interface SaveNotionNotesResult {
  success: boolean;
  mode: 'created' | 'updated';
  page_id: string;
  page_url: string;
  page_title: string;
  raw_text?: string;
}

async function readApiError(response: Response, fallbackMessage: string): Promise<never> {
  const error = await response.json().catch(() => ({ detail: response.statusText }));
  throw new Error(error.detail || fallbackMessage);
}

export function buildNotionOAuthUrl(publicBaseUrl: string, frontendOrigin: string): string {
  const params = new URLSearchParams({
    public_base_url: publicBaseUrl,
    frontend_origin: frontendOrigin,
  });
  return `${MCP_BASE_URL}/notion/oauth/start?${params.toString()}`;
}

export async function getNotionStatus(): Promise<NotionConnectionStatus> {
  const response = await fetch(`${MCP_BASE_URL}/notion/status`);
  if (!response.ok) {
    throw new Error(`Failed to load Notion status: ${response.statusText}`);
  }
  const data = await response.json();
  return {
    connected: !!data.connected,
    server_url: data.server_url || '',
    workspace_id: data.workspace_id || '',
    workspace_name: data.workspace_name || '',
    workspace_icon: data.workspace_icon || '',
    bot_id: data.bot_id || '',
    owner_user_id: data.owner_user_id || '',
    connected_at: data.connected_at || '',
    expires_at: data.expires_at || '',
    settings_path: data.settings_path,
  };
}

export async function disconnectNotion(): Promise<{ success: boolean; connected: boolean }> {
  const response = await fetch(`${MCP_BASE_URL}/notion/disconnect`, {
    method: 'POST',
  });
  if (!response.ok) {
    await readApiError(response, 'Failed to disconnect Notion');
  }
  const data = await response.json();
  return {
    success: !!data.success,
    connected: !!data.connected,
  };
}

export async function searchNotionPages(query: string, limit: number = 20): Promise<NotionPageSummary[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const params = new URLSearchParams({
    query: normalizedQuery,
    limit: String(limit),
  });
  const response = await fetch(`${MCP_BASE_URL}/notion/pages/search?${params.toString()}`);
  if (!response.ok) {
    await readApiError(response, 'Failed to search Notion pages');
  }
  const data = await response.json();
  return (data.pages || []) as NotionPageSummary[];
}

export async function listNotionPages(limit: number = 10): Promise<NotionPageSummary[]> {
  const params = new URLSearchParams({
    limit: String(limit),
  });
  const response = await fetch(`${MCP_BASE_URL}/notion/pages?${params.toString()}`);
  if (!response.ok) {
    await readApiError(response, 'Failed to load Notion pages');
  }
  const data = await response.json();
  return (data.pages || []) as NotionPageSummary[];
}

export async function saveNotionNotes(payload: SaveNotionNotesPayload): Promise<SaveNotionNotesResult> {
  const response = await fetch(`${MCP_BASE_URL}/notion/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await readApiError(response, 'Failed to save to Notion');
  }
  const data = await response.json();
  return {
    success: !!data.success,
    mode: data.mode,
    page_id: data.page_id || '',
    page_url: data.page_url || '',
    page_title: data.page_title || '',
    raw_text: data.raw_text,
  };
}
