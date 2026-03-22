import React, { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  getAgentStatus,
  getDiscordConfig,
  listAgentJobs,
  listLocalPdfs,
  runConferencePipeline,
  runResearchAgent,
  updateDiscordConfig,
} from '../lib/mcp';
import type { LocalPdfInfo, PipelineResult } from '../lib/mcp';
import UserProfileSettingsModal from './UserProfileSettingsModal';
import './workspaceTheme.css';

interface PipelineModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type PipelineStep = 'config' | 'running' | 'complete' | 'error';
type SourceType = 'arxiv' | 'neurips' | 'local';
type AnalysisMode = 'quick' | 'standard' | 'deep';

const sources: Array<{ value: SourceType; label: string; desc: string }> = [
  { value: 'local', label: 'Local PDFs', desc: 'Use files already in the workspace.' },
  { value: 'arxiv', label: 'arXiv', desc: 'Search, rank, and analyze papers.' },
  { value: 'neurips', label: 'NeurIPS 2025', desc: 'Search the conference track.' },
];

const modes: Array<{ value: AnalysisMode; label: string; desc: string; enabled: boolean }> = [
  { value: 'quick', label: 'Quick', desc: '2 key sections per paper', enabled: true },
  { value: 'standard', label: 'Standard', desc: '3 to 4 sections per paper', enabled: false },
  { value: 'deep', label: 'Deep', desc: '5 or more sections per paper', enabled: false },
];

const fieldLabelStyle: CSSProperties = {
  display: 'block',
  marginBottom: '8px',
  fontSize: '11px',
  color: 'rgba(46, 64, 54, 0.7)',
  fontFamily: 'JetBrains Mono, monospace',
  textTransform: 'uppercase',
  letterSpacing: '0.16em',
};

const sectionCardStyle: CSSProperties = {
  padding: '18px',
  borderRadius: '24px',
};

const inputStyle: CSSProperties = {
  padding: '13px 14px',
  fontSize: '14px',
};

const mutedCardStyle: CSSProperties = {
  padding: '14px 16px',
  background: 'rgba(46, 64, 54, 0.06)',
  border: '1px solid rgba(46, 64, 54, 0.12)',
  borderRadius: '20px',
};

const errorCardStyle: CSSProperties = {
  padding: '14px 16px',
  background: 'rgba(204, 88, 51, 0.12)',
  border: '1px solid rgba(204, 88, 51, 0.2)',
  borderRadius: '20px',
  color: '#9b3c1f',
  fontSize: '13px',
};

const sourceLabel = (source: SourceType) =>
  source === 'local' ? 'Local PDFs' : source === 'arxiv' ? 'arXiv' : 'NeurIPS 2025';

export default function PipelineModal({ isOpen, onClose }: PipelineModalProps) {
  const [step, setStep] = useState<PipelineStep>('config');
  const [currentPage, setCurrentPage] = useState<1 | 2 | 3>(1);
  const [source, setSource] = useState<SourceType>('local');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPapers, setSelectedPapers] = useState<string[]>([]);
  const [localPdfs, setLocalPdfs] = useState<LocalPdfInfo[]>([]);
  const [loadingPdfs, setLoadingPdfs] = useState(false);
  const [topK, setTopK] = useState(3);
  const [isProfileSettingsOpen, setIsProfileSettingsOpen] = useState(false);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('quick');
  const [analysisGoal, setAnalysisGoal] = useState('');
  const [discordWebhookFull, setDiscordWebhookFull] = useState('');
  const [discordWebhookSummary, setDiscordWebhookSummary] = useState('');
  const [savingDiscordConfig, setSavingDiscordConfig] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [runningStepText, setRunningStepText] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollingRef = useRef<number | null>(null);

  useEffect(() => {
    if (isOpen && source === 'local') {
      void loadLocalPdfs();
    }
  }, [isOpen, source]);

  useEffect(() => {
    setIsProfileSettingsOpen(!!(isOpen && currentPage === 2 && (source === 'arxiv' || source === 'neurips')));
  }, [currentPage, isOpen, source]);

  useEffect(() => {
    if (isOpen) {
      void loadDiscordConfig();
      void checkExistingJobs();
    } else {
      clearPolling();
    }
    return () => clearPolling();
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && currentPage === 3) {
      void loadDiscordConfig();
    }
  }, [currentPage, isOpen]);

  const clearPolling = () => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  };

  const resetToConfig = () => {
    setResult(null);
    setJobId(null);
    setError(null);
    setStep('config');
    setCurrentPage(1);
    setSearchQuery('');
    setSelectedPapers([]);
    setAnalysisGoal('');
    setAnalysisMode('quick');
    setTopK(3);
    setSource('local');
    setRunningStepText('');
    setProgressPercent(0);
  };

  const loadDiscordConfig = async () => {
    try {
      const config = await getDiscordConfig();
      setDiscordWebhookFull(config.discord_webhook_full || '');
      setDiscordWebhookSummary(config.discord_webhook_summary || '');
    } catch {
      setDiscordWebhookFull('');
      setDiscordWebhookSummary('');
    }
  };

  const saveDiscordConfig = async (fullWebhook: string, summaryWebhook: string) => {
    setSavingDiscordConfig(true);
    try {
      await updateDiscordConfig({
        discord_webhook_full: fullWebhook,
        discord_webhook_summary: summaryWebhook,
      });
    } finally {
      setSavingDiscordConfig(false);
    }
  };

  const checkExistingJobs = async () => {
    try {
      const jobs = await listAgentJobs();
      const runningJob = jobs.find((candidate) => candidate.status === 'running');
      if (runningJob) {
        setJobId(runningJob.job_id);
        setStep('running');
        startPolling(runningJob.job_id);
        return;
      }
      const completedJob = jobs.find((candidate) => candidate.status === 'completed');
      if (!completedJob) return;
      try {
        const status = await getAgentStatus(completedJob.job_id);
        if (status.status === 'completed' && status.result) {
          setJobId(completedJob.job_id);
          setResult({
            success: true,
            papers_analyzed: status.paper_results_count,
            report_path: status.result.report_path,
            reasoning_log_count: status.reasoning_log_count,
          });
          setStep('complete');
        }
      } catch {}
    } catch (jobError) {
      console.error('Failed to check running jobs:', jobError);
    }
  };

  const startPolling = (activeJobId: string) => {
    clearPolling();
    pollingRef.current = window.setInterval(async () => {
      try {
        const status = await getAgentStatus(activeJobId);
        setRunningStepText(status.current_step);
        setProgressPercent(status.progress_percent);
        if (status.status === 'completed') {
          clearPolling();
          setResult({
            success: true,
            papers_analyzed: status.paper_results_count,
            report_path: status.result?.report_path,
            reasoning_log_count: status.reasoning_log_count,
            errors: status.errors.length > 0 ? status.errors : undefined,
          });
          setStep('complete');
          return;
        }
        if (status.status === 'failed') {
          clearPolling();
          setError(status.errors.join(', ') || 'Pipeline failed');
          setStep('error');
        }
      } catch (pollError) {
        console.error('Polling error:', pollError);
      }
    }, 2000);
  };

  const loadLocalPdfs = async () => {
    setLoadingPdfs(true);
    try {
      setLocalPdfs(await listLocalPdfs());
    } catch (loadError) {
      console.error('Failed to load PDFs:', loadError);
      setLocalPdfs([]);
    } finally {
      setLoadingPdfs(false);
    }
  };

  const togglePaperSelection = (pdf: LocalPdfInfo) => {
    const identifier = pdf.relative_path || pdf.filename;
    setSelectedPapers((current) => {
      if (current.includes(identifier)) return current.filter((entry) => entry !== identifier);
      if (current.length >= 3) return current;
      return [...current, identifier];
    });
  };

  const handleRunPipeline = async () => {
    let paperIds: string[] = [];
    if (source === 'local') {
      if (selectedPapers.length === 0) {
        setError('Please select at least one paper');
        return;
      }
      paperIds = selectedPapers.map((identifier) => {
        const pdf = localPdfs.find((entry) => (entry.relative_path || entry.filename) === identifier);
        return pdf ? pdf.filename : identifier;
      });
    } else if (!searchQuery.trim()) {
      setError('Please enter a search query');
      return;
    }

    setStep('running');
    setRunningStepText('Starting pipeline in background...');
    setProgressPercent(0);
    setError(null);
    setResult(null);

    try {
      const response = source === 'local'
        ? await runResearchAgent({
            paper_ids: paperIds,
            goal: analysisGoal || 'general understanding',
            analysis_mode: analysisMode,
            discord_webhook_full: discordWebhookFull || '',
            discord_webhook_summary: discordWebhookSummary || '',
            source,
          })
        : await runConferencePipeline({
            source,
            query: searchQuery,
            top_k: topK,
            goal: analysisGoal || 'general understanding',
            analysis_mode: analysisMode,
            discord_webhook_full: discordWebhookFull || '',
            discord_webhook_summary: discordWebhookSummary || '',
          });
      if (!response.success || !response.job_id) throw new Error(response.error || 'Failed to start pipeline');
      setJobId(response.job_id);
      setRunningStepText('Pipeline started. Monitoring progress...');
      startPolling(response.job_id);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'An error occurred');
      setStep('error');
    }
  };

  const hasValidStepOne = () => (source === 'local' ? selectedPapers.length > 0 : searchQuery.trim().length > 0);
  const hasDiscordWebhook = () =>
    discordWebhookFull.startsWith('https://discord.com/api/webhooks/') ||
    discordWebhookSummary.startsWith('https://discord.com/api/webhooks/');

  if (!isOpen) return null;

  const renderStepIndicator = () => (
    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '20px' }}>
      {['Choose source', 'Set analysis', 'Notifications'].map((label, index) => {
        const pageNumber = (index + 1) as 1 | 2 | 3;
        const active = currentPage === pageNumber;
        const complete = currentPage > pageNumber;
        return (
          <div
            key={label}
            className="workspace-pill"
            data-tone={active || complete ? 'accent' : undefined}
            style={{
              padding: '8px 14px',
              background: active || complete ? 'rgba(204, 88, 51, 0.11)' : 'rgba(255, 255, 255, 0.58)',
              borderColor: active || complete ? 'rgba(204, 88, 51, 0.22)' : 'rgba(46, 64, 54, 0.12)',
              color: active || complete ? '#9b3c1f' : 'rgba(22, 22, 22, 0.64)',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '22px', height: '22px', borderRadius: '999px', background: active || complete ? 'var(--clay)' : 'rgba(46, 64, 54, 0.12)', color: active || complete ? 'var(--cream)' : 'rgba(22, 22, 22, 0.72)', fontSize: '11px', fontWeight: 700 }}>
              {pageNumber}
            </span>
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );

  const renderStepOne = () => (
    <div style={{ display: 'grid', gap: '18px' }}>
      <div className="workspace-list-card" style={sectionCardStyle}>
        <div className="workspace-section-label">Step 1</div>
        <div className="workspace-title" style={{ fontSize: '28px', marginBottom: '6px' }}>Select papers</div>
        <div className="workspace-subtle" style={{ fontSize: '13px', lineHeight: 1.6 }}>Choose local files or let the pipeline search and rank papers from the selected source.</div>
      </div>

      <div className="workspace-list-card" style={sectionCardStyle}>
        <label style={fieldLabelStyle}>Paper Source</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
          {sources.map((option) => (
            <button key={option.value} type="button" onClick={() => { setSource(option.value); setSelectedPapers([]); setSearchQuery(''); }} className="workspace-chip" data-active={source === option.value} style={{ padding: '14px 16px', borderRadius: '20px', textAlign: 'left', cursor: 'pointer', display: 'grid', gap: '4px' }}>
              <span style={{ fontWeight: 700, fontSize: '14px' }}>{option.label}</span>
              <span style={{ fontSize: '12px', opacity: 0.78, lineHeight: 1.5 }}>{option.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {source === 'local' ? (
        <div className="workspace-list-card" style={sectionCardStyle}>
          <label style={fieldLabelStyle}>Select PDFs</label>
          {loadingPdfs ? (
            <div style={{ color: 'rgba(22, 22, 22, 0.54)', padding: '24px 0', textAlign: 'center', fontSize: '13px' }}>Loading PDFs...</div>
          ) : localPdfs.length === 0 ? (
            <div style={{ color: 'rgba(22, 22, 22, 0.54)', padding: '24px 0', textAlign: 'center', fontSize: '13px' }}>No PDFs found in the `pdf` directory.</div>
          ) : (
            <div className="workspace-list-card" style={{ marginTop: '14px', maxHeight: '260px', overflowY: 'auto', overflowX: 'hidden', borderRadius: '20px' }}>
              {localPdfs.map((pdf, index) => {
                const identifier = pdf.relative_path || pdf.filename;
                const selected = selectedPapers.includes(identifier);
                return (
                  <button key={pdf.path} type="button" onClick={() => togglePaperSelection(pdf)} style={{ width: '100%', padding: '14px 16px', border: 'none', borderBottom: index === localPdfs.length - 1 ? 'none' : '1px solid rgba(46, 64, 54, 0.08)', background: selected ? 'rgba(46, 64, 54, 0.1)' : 'transparent', display: 'flex', alignItems: 'flex-start', gap: '12px', textAlign: 'left', cursor: 'pointer' }}>
                    <input type="checkbox" checked={selected} readOnly style={{ marginTop: '3px', accentColor: 'var(--clay)' }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', color: 'var(--charcoal)', fontSize: '14px', fontWeight: 700 }}>
                        <span style={{ wordBreak: 'break-word' }}>{pdf.filename}</span>
                        {pdf.already_extracted ? <span className="workspace-pill" data-tone="moss" style={{ padding: '4px 8px', fontSize: '10px' }}>Extracted</span> : null}
                      </div>
                      <div style={{ marginTop: '4px', color: 'rgba(22, 22, 22, 0.54)', fontSize: '12px', lineHeight: 1.5 }}>
                        {pdf.relative_path && pdf.relative_path !== pdf.filename ? <span style={{ display: 'block', wordBreak: 'break-word' }}>{pdf.relative_path}</span> : null}
                        <span>{pdf.size_mb} MB</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          <div style={{ marginTop: '10px', color: 'rgba(22, 22, 22, 0.54)', fontSize: '12px' }}>Selected: {selectedPapers.length}/3 papers</div>
        </div>
      ) : (
        <div className="workspace-list-card" style={sectionCardStyle}>
          <div style={{ display: 'grid', gap: '16px' }}>
            <div>
              <label style={fieldLabelStyle}>Search Query</label>
              <input className="workspace-input" type="text" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={`Search ${source === 'arxiv' ? 'arXiv' : 'NeurIPS 2025'} papers...`} style={inputStyle} />
            </div>
            <div>
              <label style={fieldLabelStyle}>Paper Count</label>
              <select className="workspace-select" value={topK} onChange={(event) => setTopK(parseInt(event.target.value, 10))} style={inputStyle}>
                <option value={1}>1 paper</option><option value={2}>2 papers</option><option value={3}>3 papers</option><option value={4}>4 papers</option><option value={5}>5 papers</option>
              </select>
            </div>
            <button type="button" onClick={() => setIsProfileSettingsOpen(true)} className="workspace-ghost-btn" style={{ border: '1px solid rgba(46, 64, 54, 0.12)', padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
              <span style={{ fontWeight: 700 }}>Edit profile settings for ranking</span>
              <span style={{ fontSize: '18px', lineHeight: 1 }}>&gt;</span>
            </button>
          </div>
        </div>
      )}

      <div
        className="workspace-list-card"
        style={{
          ...sectionCardStyle,
          background: 'linear-gradient(135deg, rgba(46, 64, 54, 0.1), rgba(255, 255, 255, 0.7))',
          borderColor: 'rgba(46, 64, 54, 0.14)',
        }}
      >
        <div className="workspace-kicker">Pipeline Scope</div>
        <div style={{ marginTop: '8px', color: 'rgba(22, 22, 22, 0.72)', fontSize: '13px', lineHeight: 1.7 }}>
          {source === 'local'
            ? 'The pipeline will analyze the papers you selected from the workspace.'
            : 'The pipeline will search, rank, download, and analyze papers from the selected source.'}
        </div>
      </div>
    </div>
  );

  const renderStepTwo = () => (
    <div style={{ display: 'grid', gap: '18px' }}>
      <div className="workspace-list-card" style={sectionCardStyle}>
        <div className="workspace-section-label">Step 2</div>
        <div className="workspace-title" style={{ fontSize: '28px', marginBottom: '6px' }}>Shape the analysis</div>
        <div className="workspace-subtle" style={{ fontSize: '13px', lineHeight: 1.6 }}>Pick the current analysis depth and optionally steer the review toward a specific question.</div>
      </div>
      <div className="workspace-list-card" style={sectionCardStyle}>
        <label style={fieldLabelStyle}>Analysis Depth</label>
        <div style={{ display: 'grid', gap: '10px' }}>
          {modes.map((option) => {
            const selected = analysisMode === option.value;
            return (
              <button key={option.value} type="button" onClick={() => option.enabled && setAnalysisMode(option.value)} disabled={!option.enabled} className="workspace-list-card" style={{ padding: '16px 18px', borderRadius: '20px', textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', cursor: option.enabled ? 'pointer' : 'not-allowed', opacity: option.enabled ? 1 : 0.62, borderColor: selected ? 'rgba(204, 88, 51, 0.35)' : 'rgba(46, 64, 54, 0.1)', background: selected ? 'rgba(204, 88, 51, 0.08)' : 'rgba(255, 255, 255, 0.62)' }}>
                <div>
                  <div style={{ color: 'var(--charcoal)', fontSize: '14px', fontWeight: 700 }}>{option.label}</div>
                  <div style={{ marginTop: '4px', color: 'rgba(22, 22, 22, 0.54)', fontSize: '12px' }}>{option.desc}</div>
                </div>
                {!option.enabled ? <span className="workspace-pill" style={{ padding: '5px 10px', fontSize: '10px' }}>Coming soon</span> : selected ? <span className="workspace-pill" data-tone="accent" style={{ padding: '5px 10px', fontSize: '10px' }}>Selected</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      <div className="workspace-list-card" style={sectionCardStyle}>
        <label style={fieldLabelStyle}>Analysis Goal</label>
        <input className="workspace-input" type="text" value={analysisGoal} onChange={(event) => setAnalysisGoal(event.target.value)} placeholder="e.g. understand the methodology, assumptions, or implementation details" style={inputStyle} />
        <div style={{ marginTop: '6px', color: 'rgba(22, 22, 22, 0.54)', fontSize: '12px' }}>The agent will prioritize sections that best match this goal.</div>
      </div>
      <div className="workspace-list-card" style={{ ...sectionCardStyle, background: 'linear-gradient(135deg, rgba(204, 88, 51, 0.08), rgba(255, 255, 255, 0.72))' }}>
        <div className="workspace-kicker">How It Works</div>
        <div style={{ marginTop: '10px', color: 'rgba(22, 22, 22, 0.72)', fontSize: '13px', lineHeight: 1.8 }}>
          1. Generate a summary report for each paper.
          <br />
          2. Identify the most relevant sections from that summary.
          <br />
          3. Perform deeper analysis on the selected sections.
          <br />
          4. Compile the reasoning trail and report output.
        </div>
      </div>
    </div>
  );

  const renderStepThree = () => (
    <div style={{ display: 'grid', gap: '18px' }}>
      <div className="workspace-list-card" style={sectionCardStyle}>
        <div className="workspace-section-label">Step 3</div>
        <div className="workspace-title" style={{ fontSize: '28px', marginBottom: '6px' }}>Configure notifications</div>
        <div className="workspace-subtle" style={{ fontSize: '13px', lineHeight: 1.6 }}>Save one or both Discord webhook targets before starting the pipeline.</div>
      </div>
      <div className="workspace-list-card" style={sectionCardStyle}>
        <label style={fieldLabelStyle}>Full Report Channel</label>
        <input className="workspace-input" type="text" value={discordWebhookFull} onChange={(event) => setDiscordWebhookFull(event.target.value)} onBlur={(event) => void saveDiscordConfig(event.target.value, discordWebhookSummary)} placeholder="https://discord.com/api/webhooks/... for the full report" style={inputStyle} />
        <div style={{ marginTop: '6px', color: 'rgba(22, 22, 22, 0.54)', fontSize: '12px', lineHeight: 1.6 }}>Sends the complete pipeline output, including summaries, analysis, and agent reasoning.</div>
      </div>
      <div className="workspace-list-card" style={sectionCardStyle}>
        <label style={fieldLabelStyle}>Summary Channel</label>
        <input className="workspace-input" type="text" value={discordWebhookSummary} onChange={(event) => setDiscordWebhookSummary(event.target.value)} onBlur={(event) => void saveDiscordConfig(discordWebhookFull, event.target.value)} placeholder="https://discord.com/api/webhooks/... for the executive summary" style={inputStyle} />
        <div style={{ marginTop: '6px', color: 'rgba(22, 22, 22, 0.54)', fontSize: '12px', lineHeight: 1.6 }}>Sends only the executive summary for a faster checkpoint.</div>
      </div>
      <div className="workspace-list-card" style={mutedCardStyle}>
        <div className="workspace-kicker">Setup</div>
        <div style={{ marginTop: '8px', fontSize: '13px', color: 'rgba(22, 22, 22, 0.66)', lineHeight: 1.8 }}>
          1. Open Discord server settings and enable webhooks.
          <br />
          2. Create a webhook URL for each channel you want to use.
          <br />
          3. Paste those URLs into the fields above.
          <br />
          4. Configure at least one channel before running the pipeline.
        </div>
        {savingDiscordConfig ? <div style={{ marginTop: '10px', fontSize: '12px', color: 'rgba(22, 22, 22, 0.54)' }}>Saving Discord webhook settings...</div> : null}
      </div>
      <div className="workspace-list-card" style={{ ...sectionCardStyle, background: 'linear-gradient(135deg, rgba(204, 88, 51, 0.08), rgba(255, 255, 255, 0.72))' }}>
        <div className="workspace-kicker">Pipeline Summary</div>
        <div style={{ marginTop: '8px', fontSize: '13px', color: 'rgba(22, 22, 22, 0.66)', lineHeight: 1.8 }}>
          Source: {sourceLabel(source)}<br />
          {source === 'local' ? <>Papers: {selectedPapers.length > 0 ? selectedPapers.join(', ') : 'None selected'}<br /></> : <>Query: {searchQuery || '(not set)'}<br />Top K: {topK} papers<br /></>}
          Mode: {analysisMode}<br />
          Goal: {analysisGoal || 'General understanding'}<br />
          Discord Channels: {[discordWebhookFull && 'Full Report', discordWebhookSummary && 'Summary'].filter(Boolean).join(', ') || 'None configured'}
        </div>
      </div>
    </div>
  );

  const renderRunningState = () => (
    <div style={{ padding: '28px 8px 12px', display: 'grid', gap: '18px' }}>
      <style>{`@keyframes pipelineModalSpin { to { transform: rotate(360deg); } }`}</style>
      <div className="workspace-list-card" style={{ ...sectionCardStyle, textAlign: 'center' }}>
        <div style={{ width: '64px', height: '64px', margin: '0 auto 18px', borderRadius: '999px', border: '4px solid rgba(46, 64, 54, 0.12)', borderTopColor: 'var(--clay)', animation: 'pipelineModalSpin 1s linear infinite' }} />
        <div className="workspace-kicker">Pipeline Running</div>
        <div className="workspace-title" style={{ fontSize: '26px', marginTop: '6px' }}>Agent is working</div>
        <div style={{ marginTop: '10px', color: 'rgba(22, 22, 22, 0.64)', fontSize: '14px' }}>{runningStepText || 'Processing...'}</div>
        <div style={{ marginTop: '18px', width: '100%', height: '10px', background: 'rgba(46, 64, 54, 0.08)', borderRadius: '999px', overflow: 'hidden' }}>
          <div style={{ width: `${progressPercent}%`, height: '100%', borderRadius: '999px', background: 'linear-gradient(90deg, var(--clay), #d97b4a)', transition: 'width 0.3s ease' }} />
        </div>
        <div style={{ marginTop: '10px', color: 'rgba(22, 22, 22, 0.52)', fontSize: '12px' }}>{Math.round(progressPercent)}% complete</div>
        {jobId ? <div className="workspace-pill" style={{ marginTop: '14px', padding: '8px 12px', wordBreak: 'break-all' }}>Job ID: {jobId}</div> : null}
      </div>
      <div className="workspace-list-card" style={mutedCardStyle}>
        <div className="workspace-kicker">Background Execution</div>
        <div style={{ marginTop: '8px', fontSize: '13px', color: 'rgba(22, 22, 22, 0.66)', lineHeight: 1.7 }}>
          You can close this modal and keep working. The pipeline will continue in the background, and reopening this modal will show the latest status.
        </div>
      </div>
    </div>
  );

  const renderCompleteState = () => (
    <div style={{ padding: '8px 0', display: 'grid', gap: '18px' }}>
      <div className="workspace-list-card" style={{ ...sectionCardStyle, textAlign: 'center' }}>
        <div className="workspace-kicker">Pipeline Complete</div>
        <div className="workspace-title" style={{ fontSize: '30px', marginTop: '8px' }}>Analysis complete</div>
      </div>
      {result ? <div className="workspace-list-card" style={sectionCardStyle}><div className="workspace-kicker">Result</div><div style={{ marginTop: '10px', fontSize: '13px', lineHeight: 1.8 }}>Papers analyzed: {result.papers_analyzed || 0}<br />Agent decisions: {result.reasoning_log_count || 0}{result.report_path ? <><br />Report: {result.report_path}</> : null}</div></div> : null}
      {result?.errors && result.errors.length > 0 ? <div className="workspace-list-card" style={errorCardStyle}>{result.errors.map((message, index) => <div key={index}>- {message}</div>)}</div> : null}
    </div>
  );

  const renderErrorState = () => (
    <div style={{ padding: '18px 0', display: 'grid', gap: '18px' }}>
      <div className="workspace-list-card" style={errorCardStyle}>
        <div className="workspace-kicker" style={{ color: '#9b3c1f' }}>Pipeline Failed</div>
        <div style={{ marginTop: '10px', fontSize: '14px', lineHeight: 1.7 }}>{error}</div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <button type="button" onClick={resetToConfig} className="workspace-btn" style={{ border: 'none', padding: '12px 18px', cursor: 'pointer' }}>Run again</button>
      </div>
    </div>
  );

  return (
    <div className="workspace-modal-wrap">
      <div className="workspace-overlay" onClick={onClose} />
      <div className="workspace-modal-card" style={{ position: 'relative', width: '720px', maxWidth: 'calc(100vw - 32px)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', zIndex: 1, background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.84), rgba(242, 240, 233, 0.78))' }}>
        <div style={{ padding: '18px 20px', borderBottom: '1px solid rgba(46, 64, 54, 0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px' }}>
          <div style={{ minWidth: 0 }}>
            <div className="workspace-kicker">Run Pipeline</div>
            <div className="workspace-title" style={{ fontSize: '30px', marginTop: '4px' }}>Research agent</div>
          </div>
          <button type="button" onClick={onClose} className="workspace-ghost-btn workspace-dismiss-btn" aria-label="Close pipeline modal">X</button>
        </div>
        <div className="workspace-scroll" style={{ flex: 1, padding: '18px 20px 20px' }}>
          {step === 'config' ? <>{renderStepIndicator()}{currentPage === 1 ? renderStepOne() : null}{currentPage === 2 ? renderStepTwo() : null}{currentPage === 3 ? renderStepThree() : null}</> : null}
          {step === 'running' ? renderRunningState() : null}
          {step === 'complete' ? renderCompleteState() : null}
          {step === 'error' ? renderErrorState() : null}
        </div>
        <UserProfileSettingsModal isOpen={isProfileSettingsOpen} onClose={() => setIsProfileSettingsOpen(false)} onSave={() => setIsProfileSettingsOpen(false)} />
        {step === 'config' ? (
          <div style={{ padding: '18px 20px', borderTop: '1px solid rgba(46, 64, 54, 0.08)', display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <button type="button" onClick={() => setCurrentPage((page) => Math.max(1, page - 1) as 1 | 2 | 3)} disabled={currentPage === 1} className="workspace-btn-secondary" style={{ border: 'none', padding: '12px 16px', cursor: currentPage === 1 ? 'not-allowed' : 'pointer' }}>Back</button>
            {currentPage < 3 ? (
              <button type="button" onClick={() => setCurrentPage((page) => Math.min(3, page + 1) as 1 | 2 | 3)} disabled={currentPage === 1 && !hasValidStepOne()} className="workspace-btn" style={{ border: 'none', padding: '12px 16px', cursor: 'pointer' }}>Next</button>
            ) : (
              <button type="button" onClick={() => void handleRunPipeline()} disabled={!hasDiscordWebhook()} className="workspace-btn" style={{ border: 'none', padding: '12px 18px', cursor: 'pointer' }}>Run Pipeline</button>
            )}
          </div>
        ) : null}
        {step === 'complete' ? (
          <div style={{ padding: '18px 20px', borderTop: '1px solid rgba(46, 64, 54, 0.08)', display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
            <button type="button" onClick={resetToConfig} className="workspace-btn-secondary" style={{ border: 'none', padding: '12px 16px', cursor: 'pointer' }}>Run again</button>
            <button type="button" onClick={onClose} className="workspace-btn" style={{ border: 'none', padding: '12px 16px', cursor: 'pointer' }}>Close</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
