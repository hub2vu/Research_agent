/**
 * PipelineModal Component
 *
 * Modal for configuring and running the LLM-orchestrated research agent pipeline.
 * Includes source selection, analysis settings, and notification configuration.
 */

import React, { useState, useEffect, useRef } from 'react';
import { runResearchAgent, runConferencePipeline, getAgentStatus, listAgentJobs, listLocalPdfs, getDiscordConfig, updateDiscordConfig } from '../lib/mcp';
import UserProfileSettingsModal from './UserProfileSettingsModal';

interface PipelineModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type PipelineStep = 'config' | 'running' | 'complete' | 'error';
type SourceType = 'arxiv' | 'neurips' | 'local';
type AnalysisMode = 'quick' | 'standard' | 'deep';

interface LocalPdf {
  filename: string;
  path: string;
  relative_path?: string;
  size_mb: number;
  already_extracted?: boolean;
}

interface PipelineResult {
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

export default function PipelineModal({ isOpen, onClose }: PipelineModalProps) {
  // Step management
  const [currentStep, setCurrentStep] = useState<PipelineStep>('config');
  const [configStep, setConfigStep] = useState<1 | 2 | 3>(1);
  
  // Step 1: Source Selection
  const [source, setSource] = useState<SourceType>('local');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPapers, setSelectedPapers] = useState<string[]>([]);
  const [localPdfs, setLocalPdfs] = useState<LocalPdf[]>([]);
  const [loadingPdfs, setLoadingPdfs] = useState(false);
  const [paperCount, setPaperCount] = useState(3);
  
  // Profile Settings (for arxiv/neurips) - reuse existing modal (avoid duplicating rank_filter tool logic)
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  
  // Step 2: Analysis Settings
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('quick');
  const [goal, setGoal] = useState('');
  
  // Step 3: Notification Settings
  const [discordWebhookFull, setDiscordWebhookFull] = useState('');
  const [discordWebhookSummary, setDiscordWebhookSummary] = useState('');
  const [savingDiscordConfig, setSavingDiscordConfig] = useState(false);
  
  // Execution state
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollingIntervalRef = useRef<number | null>(null);

  // Load local PDFs when source is 'local'
  useEffect(() => {
    if (isOpen && source === 'local') {
      loadLocalPdfs();
    }
  }, [isOpen, source]);

  // Auto-open profile modal only when entering step 2 with arxiv/neurips source
  useEffect(() => {
    if (isOpen && configStep === 2 && (source === 'arxiv' || source === 'neurips')) {
      setIsProfileModalOpen(true);
    } else {
      // Close profile modal when leaving step 2 or changing source
      setIsProfileModalOpen(false);
    }
  }, [isOpen, configStep, source]);

  // Check for running jobs when modal opens
  useEffect(() => {
    if (isOpen) {
      loadDiscordConfig();
      checkRunningJobs();
    } else {
      // Stop polling when modal closes
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    }
    
    return () => {
      // Cleanup on unmount
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, [isOpen]);

  // Reload Discord config when entering step 3 to reflect the latest saved settings
  useEffect(() => {
    if (isOpen && configStep === 3) {
      loadDiscordConfig();
    }
  }, [isOpen, configStep]);

  const loadDiscordConfig = async () => {
    try {
      const cfg = await getDiscordConfig();
      console.log('[PipelineModal] Loaded Discord config:', cfg);
      // Always set values (even if empty) to ensure UI reflects current state
      setDiscordWebhookFull(cfg.discord_webhook_full || '');
      setDiscordWebhookSummary(cfg.discord_webhook_summary || '');
    } catch (e) {
      console.error('[PipelineModal] Failed to load Discord config:', e);
      // If not available, keep empty
      setDiscordWebhookFull('');
      setDiscordWebhookSummary('');
    }
  };

  const persistDiscordConfig = async (nextFull: string, nextSummary: string) => {
    setSavingDiscordConfig(true);
    try {
      await updateDiscordConfig({
        discord_webhook_full: nextFull,
        discord_webhook_summary: nextSummary,
      });
    } finally {
      setSavingDiscordConfig(false);
    }
  };

  const checkRunningJobs = async () => {
    try {
      const jobs = await listAgentJobs();
      // Find the most recent running job
      const runningJob = jobs.find(j => j.status === 'running');
      if (runningJob) {
        setCurrentJobId(runningJob.job_id);
        setIsRunning(true);
        setCurrentStep('running');
        startPolling(runningJob.job_id);
      } else {
        // Check for most recent completed job
        const completedJob = jobs.find(j => j.status === 'completed');
        if (completedJob) {
          // Load its status to show result
          try {
            const status = await getAgentStatus(completedJob.job_id);
            if (status.status === 'completed' && status.result) {
              setCurrentJobId(completedJob.job_id);
              setResult({
                success: true,
                papers_analyzed: status.paper_results_count,
                report_path: status.result.report_path,
                reasoning_log_count: status.reasoning_log_count,
              });
              setCurrentStep('complete');
            }
          } catch (e) {
            // Ignore errors when loading completed job
          }
        }
      }
    } catch (err) {
      console.error('Failed to check running jobs:', err);
    }
  };

  const startPolling = (jobId: string) => {
    // Clear any existing polling
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
    }
    
    // Poll every 2 seconds
    pollingIntervalRef.current = window.setInterval(async () => {
      try {
        const status = await getAgentStatus(jobId);
        
        setProgress(status.current_step);
        setProgressPercent(status.progress_percent);
        
        if (status.status === 'completed') {
          setIsRunning(false);
          if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current);
            pollingIntervalRef.current = null;
          }
          
          // Load final result
          setResult({
            success: true,
            papers_analyzed: status.paper_results_count,
            report_path: status.result?.report_path,
            reasoning_log_count: status.reasoning_log_count,
            errors: status.errors.length > 0 ? status.errors : undefined,
          });
          setCurrentStep('complete');
        } else if (status.status === 'failed') {
          setIsRunning(false);
          if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current);
            pollingIntervalRef.current = null;
          }
          setError(status.errors.join(', ') || 'Pipeline failed');
          setCurrentStep('error');
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 2000);
  };

  const loadLocalPdfs = async () => {
    setLoadingPdfs(true);
    try {
      const pdfs = await listLocalPdfs();
      setLocalPdfs(pdfs);
    } catch (err) {
      console.error('Failed to load PDFs:', err);
      setLocalPdfs([]);
    } finally {
      setLoadingPdfs(false);
    }
  };

  const handlePaperSelect = (pdf: LocalPdf) => {
    // Use relative_path if available, otherwise use filename
    const identifier = pdf.relative_path || pdf.filename;
    setSelectedPapers(prev => {
      if (prev.includes(identifier)) {
        return prev.filter(p => p !== identifier);
      }
      if (prev.length >= 3) {
        return prev; // Max 3 papers
      }
      return [...prev, identifier];
    });
  };

  const handleRunPipeline = async () => {
    // Validate based on source type
    let paperIds: string[] = [];
    if (source === 'local') {
      if (selectedPapers.length === 0) {
        setError('Please select at least one paper');
        return;
      }
      // Convert relative_path identifiers back to filenames for the API
      // The API expects filenames, but we use relative_path for uniqueness
      paperIds = selectedPapers.map(id => {
        // If it's a relative path, extract just the filename
        const pdf = localPdfs.find(p => (p.relative_path || p.filename) === id);
        return pdf ? pdf.filename : id;
      });
    } else {
      // arxiv or neurips
      if (!searchQuery.trim()) {
        setError('Please enter a search query');
        return;
      }
    }

    setIsRunning(true);
    setCurrentStep('running');
    setProgress('Starting pipeline in background...');
    setProgressPercent(0);
    setError(null);
    setResult(null);

    try {
      let response;
      
      if (source === 'local') {
        // Use the original research agent for local PDFs
        response = await runResearchAgent({
          paper_ids: paperIds,
          goal: goal || 'general understanding',
          analysis_mode: analysisMode,
          discord_webhook_full: discordWebhookFull || '',
          discord_webhook_summary: discordWebhookSummary || '',
          source: source
        });
      } else {
        // Use the conference pipeline for arxiv/neurips
        response = await runConferencePipeline({
          source: source as 'arxiv' | 'neurips',
          query: searchQuery,
          top_k: paperCount,
          goal: goal || 'general understanding',
          analysis_mode: analysisMode,
          discord_webhook_full: discordWebhookFull || '',
          discord_webhook_summary: discordWebhookSummary || '',
        });
      }

      if (response.success && response.job_id) {
        setCurrentJobId(response.job_id);
        setProgress('Pipeline started. Monitoring progress...');
        startPolling(response.job_id);
        // Don't set isRunning to false here - polling will handle it
      } else {
        throw new Error(response.error || 'Failed to start pipeline');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setCurrentStep('error');
      setIsRunning(false);
    }
  };

  const canProceedStep1 = () => {
    if (source === 'local') {
      return selectedPapers.length > 0;
    }
    return searchQuery.trim().length > 0;
  };

  const canProceedStep2 = () => {
    return true; // Analysis mode has default
  };

  const canProceedStep3 = () => {
    // At least one Discord webhook should be configured
    const hasFull = discordWebhookFull.startsWith('https://discord.com/api/webhooks/');
    const hasSummary = discordWebhookSummary.startsWith('https://discord.com/api/webhooks/');
    return hasFull || hasSummary;
  };

  if (!isOpen) return null;

  const renderStepIndicator = () => (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      gap: '8px',
      marginBottom: '20px',
    }}>
      {[1, 2, 3].map(step => (
        <div
          key={step}
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '14px',
            fontWeight: 500,
            backgroundColor: configStep >= step ? '#4a90d9' : '#2d3748',
            color: configStep >= step ? '#fff' : '#718096',
            transition: 'all 0.2s ease',
          }}
        >
          {step}
        </div>
      ))}
    </div>
  );

  const renderStep1 = () => (
    <div>
      <h3 style={{ color: '#fff', fontSize: '16px', marginBottom: '16px' }}>
        Step 1: Select Papers
      </h3>

      {/* Source Selection */}
      <div style={{ marginBottom: '16px' }}>
        <label style={{ display: 'block', color: '#a0aec0', fontSize: '12px', marginBottom: '8px' }}>
          Paper Source
        </label>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {(['local', 'arxiv', 'neurips'] as SourceType[]).map(s => (
            <button
              key={s}
              onClick={() => {
                setSource(s);
                setSelectedPapers([]);
                setSearchQuery('');
              }}
              style={{
                padding: '8px 16px',
                borderRadius: '6px',
                border: source === s ? '2px solid #4a90d9' : '1px solid #2d3748',
                backgroundColor: source === s ? '#2d3748' : 'transparent',
                color: source === s ? '#fff' : '#a0aec0',
                fontSize: '13px',
                cursor: 'pointer',
              }}
            >
              {s === 'local' ? '📁 Local PDF' :
               s === 'arxiv' ? '📄 arXiv' : '🏆 NeurIPS 2025'}
            </button>
          ))}
        </div>
      </div>

      {/* Source-specific content */}
      {source === 'local' ? (
        <div>
          <label style={{ display: 'block', color: '#a0aec0', fontSize: '12px', marginBottom: '8px' }}>
            Select PDFs (max 3)
          </label>
          {loadingPdfs ? (
            <div style={{ color: '#718096', padding: '20px', textAlign: 'center' }}>
              Loading PDFs...
            </div>
          ) : localPdfs.length === 0 ? (
            <div style={{ color: '#718096', padding: '20px', textAlign: 'center' }}>
              No PDFs found in the pdf directory
            </div>
          ) : (
            <div style={{
              maxHeight: '200px',
              overflowY: 'auto',
              border: '1px solid #2d3748',
              borderRadius: '6px',
            }}>
              {localPdfs.map(pdf => {
                const identifier = pdf.relative_path || pdf.filename;
                const isSelected = selectedPapers.includes(identifier);
                return (
                  <div
                    key={pdf.path}
                    onClick={() => handlePaperSelect(pdf)}
                    style={{
                      padding: '10px 12px',
                      borderBottom: '1px solid #2d3748',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      cursor: 'pointer',
                      backgroundColor: isSelected ? '#2d3748' : 'transparent',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {}}
                      style={{ cursor: 'pointer' }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ 
                        color: '#fff', 
                        fontSize: '13px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                      }}>
                        <span>{pdf.filename}</span>
                        {pdf.already_extracted && (
                          <span style={{
                            fontSize: '10px',
                            padding: '2px 6px',
                            backgroundColor: '#48bb78',
                            color: '#fff',
                            borderRadius: '3px',
                          }}>
                            ✓ Extracted
                          </span>
                        )}
                      </div>
                      <div style={{ color: '#718096', fontSize: '11px' }}>
                        {pdf.relative_path && pdf.relative_path !== pdf.filename && (
                          <span style={{ marginRight: '8px' }}>
                            📁 {pdf.relative_path}
                          </span>
                        )}
                        <span>{pdf.size_mb} MB</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ marginTop: '8px', color: '#718096', fontSize: '11px' }}>
            Selected: {selectedPapers.length}/3 papers
          </div>
        </div>
      ) : (
        <div>
          <label style={{ display: 'block', color: '#a0aec0', fontSize: '12px', marginBottom: '8px' }}>
            Search Query
          </label>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`Search ${source === 'arxiv' ? 'arXiv' : 'NeurIPS 2025'} papers...`}
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: '6px',
              border: '1px solid #2d3748',
              backgroundColor: '#2d3748',
              color: '#fff',
              fontSize: '14px',
            }}
          />
          <div style={{ marginTop: '12px' }}>
            <label style={{ display: 'block', color: '#a0aec0', fontSize: '12px', marginBottom: '8px' }}>
              Number of papers to analyze (auto-selected by ranking)
            </label>
            <select
              value={paperCount}
              onChange={(e) => setPaperCount(parseInt(e.target.value))}
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: '6px',
                border: '1px solid #2d3748',
                backgroundColor: '#2d3748',
                color: '#fff',
                fontSize: '14px',
              }}
            >
              <option value={1}>1 paper</option>
              <option value={2}>2 papers</option>
              <option value={3}>3 papers</option>
              <option value={4}>4 papers</option>
              <option value={5}>5 papers</option>
            </select>
          </div>

          {/* Profile Editor (Collapsible) */}
          <div style={{ marginTop: '16px' }}>
            <button
              onClick={() => setIsProfileModalOpen(true)}
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: '6px',
                border: '1px solid #4a5568',
                backgroundColor: 'transparent',
                color: '#a0aec0',
                fontSize: '13px',
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span>⚙️ Edit Profile Settings (for ranking)</span>
              <span>↗</span>
            </button>
          </div>

          {/* Info box */}
          <div style={{
            marginTop: '12px',
            padding: '12px',
            backgroundColor: '#2d374820',
            borderRadius: '6px',
            border: '1px solid #48bb78',
            color: '#48bb78',
            fontSize: '12px',
          }}>
            ✅ The pipeline will automatically search, rank, download, and analyze papers.
          </div>
        </div>
      )}
    </div>
  );

  const renderStep2 = () => (
    <div>
      <h3 style={{ color: '#fff', fontSize: '16px', marginBottom: '16px' }}>
        Step 2: Analysis Settings
      </h3>

      {/* Analysis Mode */}
      <div style={{ marginBottom: '20px' }}>
        <label style={{ display: 'block', color: '#a0aec0', fontSize: '12px', marginBottom: '8px' }}>
          Analysis Depth
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {([
            { mode: 'quick' as AnalysisMode, label: '⚡ Quick', desc: '2 key sections per paper', enabled: true },
            { mode: 'standard' as AnalysisMode, label: '📊 Standard', desc: '3-4 sections per paper', enabled: false },
            { mode: 'deep' as AnalysisMode, label: '🔬 Deep', desc: '5+ sections per paper', enabled: false },
          ]).map(({ mode, label, desc, enabled }) => (
            <div
              key={mode}
              onClick={() => enabled && setAnalysisMode(mode)}
              style={{
                padding: '12px 16px',
                borderRadius: '6px',
                border: analysisMode === mode ? '2px solid #4a90d9' : '1px solid #2d3748',
                backgroundColor: analysisMode === mode ? '#2d3748' : 'transparent',
                opacity: enabled ? 1 : 0.5,
                cursor: enabled ? 'pointer' : 'not-allowed',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <div style={{ color: '#fff', fontSize: '14px' }}>{label}</div>
                <div style={{ color: '#718096', fontSize: '12px' }}>{desc}</div>
              </div>
              {!enabled && (
                <span style={{ color: '#718096', fontSize: '11px' }}>Coming soon</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Goal */}
      <div>
        <label style={{ display: 'block', color: '#a0aec0', fontSize: '12px', marginBottom: '8px' }}>
          Analysis Goal (optional)
        </label>
        <input
          type="text"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g., understand the methodology, implementation details..."
          style={{
            width: '100%',
            padding: '10px 12px',
            borderRadius: '6px',
            border: '1px solid #2d3748',
            backgroundColor: '#2d3748',
            color: '#fff',
            fontSize: '14px',
          }}
        />
        <div style={{ marginTop: '6px', color: '#718096', fontSize: '11px' }}>
          The agent will prioritize sections relevant to your goal
        </div>
      </div>

      {/* Info box */}
      <div style={{
        marginTop: '20px',
        padding: '12px',
        backgroundColor: '#2d3748',
        borderRadius: '6px',
        border: '1px solid #4a5568',
      }}>
        <div style={{ color: '#e2e8f0', fontSize: '13px', fontWeight: 500, marginBottom: '8px' }}>
          🤖 How the Agent Works
        </div>
        <div style={{ color: '#a0aec0', fontSize: '12px', lineHeight: 1.6 }}>
          1. Generates a summary report for each paper<br/>
          2. Uses LLM to identify key sections based on the summary<br/>
          3. Performs deep analysis on selected sections<br/>
          4. Compiles everything with reasoning explanations
        </div>
      </div>
    </div>
  );

  const renderStep3 = () => (
    <div>
      <h3 style={{ color: '#fff', fontSize: '16px', marginBottom: '16px' }}>
        Step 3: Discord Notification Settings
      </h3>

      {/* Full Report Channel */}
      <div style={{ marginBottom: '20px' }}>
        <label style={{ display: 'block', color: '#a0aec0', fontSize: '13px', marginBottom: '8px' }}>
          📄 Full Report Channel (전체 리포트)
        </label>
        <input
          type="text"
          value={discordWebhookFull}
          onChange={(e) => setDiscordWebhookFull(e.target.value)}
          onBlur={(e) => persistDiscordConfig(e.target.value, discordWebhookSummary)}
          placeholder="https://discord.com/api/webhooks/... (전체 리포트용)"
          style={{
            width: '100%',
            padding: '10px 12px',
            borderRadius: '6px',
            border: '1px solid #2d3748',
            backgroundColor: '#2d3748',
            color: '#fff',
            fontSize: '14px',
          }}
        />
        <div style={{ marginTop: '6px', color: '#718096', fontSize: '11px' }}>
          전체 분석 리포트가 전송됩니다 (종합 요약 + 심층 분석 + Agent 판단 근거)
        </div>
      </div>

      {/* Summary Channel */}
      <div style={{ marginBottom: '20px' }}>
        <label style={{ display: 'block', color: '#a0aec0', fontSize: '13px', marginBottom: '8px' }}>
          📋 Summary Channel (요약본)
        </label>
        <input
          type="text"
          value={discordWebhookSummary}
          onChange={(e) => setDiscordWebhookSummary(e.target.value)}
          onBlur={(e) => persistDiscordConfig(discordWebhookFull, e.target.value)}
          placeholder="https://discord.com/api/webhooks/... (요약본용)"
          style={{
            width: '100%',
            padding: '10px 12px',
            borderRadius: '6px',
            border: '1px solid #2d3748',
            backgroundColor: '#2d3748',
            color: '#fff',
            fontSize: '14px',
          }}
        />
        <div style={{ marginTop: '6px', color: '#718096', fontSize: '11px' }}>
          Executive Summary만 전송됩니다 (빠른 확인용)
        </div>
      </div>

      {/* Info box */}
      <div style={{
        padding: '12px',
        backgroundColor: '#2d3748',
        borderRadius: '6px',
        border: '1px solid #4a5568',
        fontSize: '12px',
        color: '#a0aec0',
        marginBottom: '20px',
      }}>
        <div style={{ color: '#e2e8f0', fontWeight: 500, marginBottom: '6px' }}>
          💡 Setup Instructions
        </div>
        <div style={{ lineHeight: 1.6 }}>
          1. Discord 서버 설정 → 통합 → 웹후크 → 새 웹후크<br/>
          2. 각 채널마다 별도의 Webhook URL 생성<br/>
          3. 위 입력 필드에 Webhook URL 붙여넣기<br/>
          4. 최소 하나의 채널은 설정해야 합니다<br/>
        </div>
        {savingDiscordConfig && (
          <div style={{ marginTop: '8px', fontSize: '11px', color: '#718096' }}>
            Saving Discord webhook settings...
          </div>
        )}
      </div>

      {/* Summary */}
      <div style={{
        padding: '12px',
        backgroundColor: '#1e293b',
        borderRadius: '6px',
        border: '1px solid #334155',
      }}>
        <div style={{ color: '#e2e8f0', fontWeight: 500, marginBottom: '8px' }}>
          📋 Pipeline Summary
        </div>
        <div style={{ color: '#a0aec0', fontSize: '12px', lineHeight: 1.8 }}>
          • Source: {source === 'local' ? 'Local PDF' : source === 'arxiv' ? 'arXiv' : 'NeurIPS 2025'}<br/>
          {source === 'local' ? (
            <>• Papers: {selectedPapers.length > 0 ? selectedPapers.join(', ') : 'None selected'}<br/></>
          ) : (
            <>
              • Query: {searchQuery || '(not set)'}<br/>
              • Top K: {paperCount} papers<br/>
            </>
          )}
          • Mode: {analysisMode}<br/>
          • Goal: {goal || 'General understanding'}<br/>
          • Discord Channels: {[
            discordWebhookFull && 'Full Report',
            discordWebhookSummary && 'Summary'
          ].filter(Boolean).join(', ') || 'None configured'}
        </div>
      </div>
    </div>
  );

  const renderRunning = () => (
    <div style={{ textAlign: 'center', padding: '40px 20px' }}>
      <div style={{
        width: '60px',
        height: '60px',
        margin: '0 auto 20px',
        border: '4px solid #2d3748',
        borderTopColor: '#4a90d9',
        borderRadius: '50%',
        animation: 'spin 1s linear infinite',
      }} />
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      <div style={{ color: '#fff', fontSize: '16px', marginBottom: '8px' }}>
        🤖 Agent is working...
      </div>
      <div style={{ color: '#a0aec0', fontSize: '14px', marginBottom: '16px' }}>
        {progress || 'Processing...'}
      </div>
      
      {/* Progress Bar */}
      <div style={{
        width: '100%',
        height: '8px',
        backgroundColor: '#2d3748',
        borderRadius: '4px',
        overflow: 'hidden',
        marginBottom: '12px',
      }}>
        <div style={{
          width: `${progressPercent}%`,
          height: '100%',
          backgroundColor: '#4a90d9',
          transition: 'width 0.3s ease',
        }} />
      </div>
      <div style={{ color: '#718096', fontSize: '12px', marginBottom: '20px' }}>
        {Math.round(progressPercent)}% complete
      </div>
      
      {currentJobId && (
        <div style={{
          marginTop: '12px',
          padding: '8px 12px',
          backgroundColor: '#1e293b',
          borderRadius: '4px',
          fontSize: '11px',
          color: '#718096',
        }}>
          Job ID: {currentJobId}
        </div>
      )}
      
      <div style={{
        marginTop: '20px',
        padding: '12px',
        backgroundColor: '#2d3748',
        borderRadius: '6px',
        color: '#718096',
        fontSize: '12px',
      }}>
        💡 You can close this modal and continue working. The pipeline will continue in the background.
        <br />
        Open this modal again anytime to check progress.
      </div>
    </div>
  );

  const renderComplete = () => (
    <div style={{ padding: '20px' }}>
      <div style={{ textAlign: 'center', marginBottom: '24px' }}>
        <div style={{ fontSize: '48px', marginBottom: '12px' }}>✅</div>
        <div style={{ color: '#48bb78', fontSize: '18px', fontWeight: 500 }}>
          Analysis Complete!
        </div>
      </div>

      {result && (
        <div>
          {/* Stats */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: '12px',
            marginBottom: '20px',
          }}>
            <div style={{
              padding: '12px',
              backgroundColor: '#2d3748',
              borderRadius: '6px',
              textAlign: 'center',
            }}>
              <div style={{ color: '#4a90d9', fontSize: '24px', fontWeight: 600 }}>
                {result.papers_analyzed || 0}
              </div>
              <div style={{ color: '#a0aec0', fontSize: '12px' }}>Papers Analyzed</div>
            </div>
            <div style={{
              padding: '12px',
              backgroundColor: '#2d3748',
              borderRadius: '6px',
              textAlign: 'center',
            }}>
              <div style={{ color: '#48bb78', fontSize: '24px', fontWeight: 600 }}>
                {result.reasoning_log_count || 0}
              </div>
              <div style={{ color: '#a0aec0', fontSize: '12px' }}>Agent Decisions</div>
            </div>
          </div>

          {/* Executive Summary */}
          {result.executive_summary && (
            <div style={{
              marginBottom: '20px',
              padding: '16px',
              backgroundColor: '#2d3748',
              borderRadius: '6px',
              border: '1px solid #4a5568',
            }}>
              <div style={{ color: '#e2e8f0', fontWeight: 500, marginBottom: '8px' }}>
                📋 Executive Summary
              </div>
              <div style={{ color: '#a0aec0', fontSize: '13px', lineHeight: 1.6 }}>
                {result.executive_summary}
              </div>
            </div>
          )}

          {/* Report Path */}
          {result.report_path && (
            <div style={{
              padding: '12px',
              backgroundColor: '#1e293b',
              borderRadius: '6px',
              fontSize: '12px',
            }}>
              <div style={{ color: '#718096', marginBottom: '4px' }}>Report saved to:</div>
              <div style={{ color: '#4a90d9', wordBreak: 'break-all' }}>
                {result.report_path}
              </div>
            </div>
          )}

          {/* Errors */}
          {result.errors && result.errors.length > 0 && (
            <div style={{
              marginTop: '16px',
              padding: '12px',
              backgroundColor: '#f5656520',
              borderRadius: '6px',
              border: '1px solid #f56565',
            }}>
              <div style={{ color: '#f56565', fontWeight: 500, marginBottom: '8px' }}>
                ⚠️ Some issues occurred:
              </div>
              {result.errors.map((err, i) => (
                <div key={i} style={{ color: '#fca5a5', fontSize: '12px' }}>
                  • {err}
                </div>
              ))}
            </div>
          )}

          {/* Run again */}
          <div style={{
            marginTop: '20px',
            display: 'flex',
            justifyContent: 'center',
          }}>
            <button
              onClick={() => {
                // Reset all state and go back to step 1 (don't re-run automatically)
                setResult(null);
                setCurrentJobId(null);
                setError(null);
                setCurrentStep('config');
                setConfigStep(1);
                // Reset form fields
                setSearchQuery('');
                setSelectedPapers([]);
                setGoal('');
                setAnalysisMode('quick');
                setPaperCount(3);
                setSource('local');
              }}
              style={{
                padding: '10px 24px',
                borderRadius: '6px',
                border: 'none',
                backgroundColor: '#48bb78',
                color: '#fff',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              🔁 Run again
            </button>
          </div>
        </div>
      )}
    </div>
  );

  const renderError = () => (
    <div style={{ textAlign: 'center', padding: '40px 20px' }}>
      <div style={{ fontSize: '48px', marginBottom: '12px' }}>❌</div>
      <div style={{ color: '#f56565', fontSize: '18px', fontWeight: 500, marginBottom: '12px' }}>
        Pipeline Failed
      </div>
      <div style={{
        padding: '12px',
        backgroundColor: '#f5656520',
        borderRadius: '6px',
        color: '#fca5a5',
        fontSize: '13px',
      }}>
        {error}
      </div>
      <button
        onClick={() => {
          // Reset all state and go back to step 1 (don't re-run automatically)
          setError(null);
          setResult(null);
          setCurrentJobId(null);
          setCurrentStep('config');
          setConfigStep(1);
          // Reset form fields
          setSearchQuery('');
          setSelectedPapers([]);
          setGoal('');
          setAnalysisMode('quick');
          setPaperCount(3);
          setSource('local');
        }}
        style={{
          marginTop: '20px',
          padding: '10px 20px',
          borderRadius: '6px',
          border: 'none',
          backgroundColor: '#4a90d9',
          color: '#fff',
          fontSize: '14px',
          cursor: 'pointer',
        }}
      >
        🔁 Run again
      </button>
    </div>
  );

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 1000,
    }}>
      <div style={{
        width: '600px',
        maxWidth: '95vw',
        maxHeight: '90vh',
        backgroundColor: '#1a202c',
        borderRadius: '12px',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid #2d3748',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <h2 style={{ margin: 0, color: '#fff', fontSize: '18px' }}>
            🤖 Research Agent Pipeline
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: '#a0aec0',
              fontSize: '24px',
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            &times;
          </button>
        </div>

        {/* Content */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '20px',
        }}>
          {currentStep === 'config' && (
            <>
              {renderStepIndicator()}
              {configStep === 1 && renderStep1()}
              {configStep === 2 && renderStep2()}
              {configStep === 3 && renderStep3()}
            </>
          )}
          {currentStep === 'running' && renderRunning()}
          {currentStep === 'complete' && renderComplete()}
          {currentStep === 'error' && renderError()}
        </div>

        {/* Reuse the existing profile settings modal (shared implementation) */}
        <UserProfileSettingsModal
          isOpen={isProfileModalOpen}
          onClose={() => setIsProfileModalOpen(false)}
          onSave={() => {
            // Profile is persisted via updateUserProfile() in the modal
            setIsProfileModalOpen(false);
          }}
        />

        {/* Footer */}
        {currentStep === 'config' && (
          <div style={{
            padding: '16px 20px',
            borderTop: '1px solid #2d3748',
            display: 'flex',
            justifyContent: 'space-between',
          }}>
            <button
              onClick={() => setConfigStep(prev => Math.max(1, prev - 1) as 1 | 2 | 3)}
              disabled={configStep === 1}
              style={{
                padding: '10px 20px',
                borderRadius: '6px',
                border: '1px solid #2d3748',
                backgroundColor: 'transparent',
                color: configStep === 1 ? '#4a5568' : '#a0aec0',
                fontSize: '14px',
                cursor: configStep === 1 ? 'not-allowed' : 'pointer',
              }}
            >
              Back
            </button>
            
            {configStep < 3 ? (
              <button
                onClick={() => setConfigStep(prev => Math.min(3, prev + 1) as 1 | 2 | 3)}
                disabled={
                  (configStep === 1 && !canProceedStep1()) ||
                  (configStep === 2 && !canProceedStep2())
                }
                style={{
                  padding: '10px 20px',
                  borderRadius: '6px',
                  border: 'none',
                  backgroundColor: 
                    (configStep === 1 && !canProceedStep1()) ||
                    (configStep === 2 && !canProceedStep2())
                      ? '#4a5568' : '#4a90d9',
                  color: '#fff',
                  fontSize: '14px',
                  cursor: 
                    (configStep === 1 && !canProceedStep1()) ||
                    (configStep === 2 && !canProceedStep2())
                      ? 'not-allowed' : 'pointer',
                }}
              >
                Next
              </button>
            ) : (
              <button
                onClick={handleRunPipeline}
                disabled={!canProceedStep3()}
                style={{
                  padding: '10px 24px',
                  borderRadius: '6px',
                  border: 'none',
                  backgroundColor: !canProceedStep3() ? '#4a5568' : '#48bb78',
                  color: '#fff',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: !canProceedStep3() ? 'not-allowed' : 'pointer',
                }}
              >
                🚀 Run Pipeline
              </button>
            )}
          </div>
        )}

        {currentStep === 'complete' && (
          <div style={{
            padding: '16px 20px',
            borderTop: '1px solid #2d3748',
            display: 'flex',
            justifyContent: 'flex-end',
          }}>
            <button
              onClick={onClose}
              style={{
                padding: '10px 20px',
                borderRadius: '6px',
                border: 'none',
                backgroundColor: '#4a90d9',
                color: '#fff',
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
