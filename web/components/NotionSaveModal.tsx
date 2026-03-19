import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getNotionStatus,
  listNotionPages,
  saveNotionNotes,
  searchNotionPages,
  type NotionConnectionStatus,
  type NotionPageSummary,
  type SaveNotionNotesResult,
} from '../lib/mcp';

interface NotionSaveModalProps {
  isOpen: boolean;
  paperId: string;
  paperTitle: string;
  notes: Array<Record<string, any>>;
  onClose: () => void;
  onOpenAccountSettings?: () => void;
  onSaved?: (result: SaveNotionNotesResult) => void;
}

const RECENT_TARGETS_STORAGE_KEY = 'notion-save-modal-recent-targets';
const MAX_RECENT_TARGETS = 6;

type RecentNotionTarget = NotionPageSummary & {
  lastUsedAt: string;
};

function isLikelyNotionPageId(value: string | null | undefined): boolean {
  const normalizedValue = (value || '').trim();
  return /^[0-9a-f]{32}$/i.test(normalizedValue)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalizedValue);
}

function getSecondaryTargetLabel(page: Pick<NotionPageSummary, 'id' | 'path' | 'title'>): string {
  const normalizedPath = page.path.trim();
  if (normalizedPath && !isLikelyNotionPageId(normalizedPath)) {
    return normalizedPath;
  }

  const normalizedTitle = page.title.trim();
  if (normalizedTitle && !isLikelyNotionPageId(normalizedTitle)) {
    return normalizedTitle;
  }

  return 'Untitled page';
}

function getPrimaryTargetLabel(page: Pick<NotionPageSummary, 'id' | 'path' | 'title'>): string {
  const normalizedTitle = page.title.trim();
  if (normalizedTitle && !isLikelyNotionPageId(normalizedTitle)) {
    return normalizedTitle;
  }

  return getSecondaryTargetLabel(page);
}

function getSelectedTargetSummary(page: Pick<NotionPageSummary, 'id' | 'path' | 'title'>): string {
  const secondaryLabel = getSecondaryTargetLabel(page);
  const primaryLabel = getPrimaryTargetLabel(page);

  if (!secondaryLabel || secondaryLabel === primaryLabel) {
    return primaryLabel;
  }

  return `${primaryLabel} (${secondaryLabel})`;
}

function normalizeSearchSeed(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function readRecentTargets(): RecentNotionTarget[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const rawValue = window.localStorage.getItem(RECENT_TARGETS_STORAGE_KEY);
    if (!rawValue) {
      return [];
    }

    const parsedValue = JSON.parse(rawValue);
    if (!Array.isArray(parsedValue)) {
      return [];
    }

    return parsedValue
      .filter((item): item is RecentNotionTarget => (
        item &&
        typeof item.id === 'string' &&
        typeof item.url === 'string' &&
        typeof item.title === 'string' &&
        typeof item.path === 'string' &&
        typeof item.kind === 'string' &&
        typeof item.lastUsedAt === 'string'
      ))
      .slice(0, MAX_RECENT_TARGETS);
  } catch {
    return [];
  }
}

function writeRecentTarget(page: NotionPageSummary) {
  if (typeof window === 'undefined') {
    return;
  }

  const nextTargets: RecentNotionTarget[] = [
    { ...page, lastUsedAt: new Date().toISOString() },
    ...readRecentTargets().filter(target => target.id !== page.id),
  ].slice(0, MAX_RECENT_TARGETS);

  try {
    window.localStorage.setItem(RECENT_TARGETS_STORAGE_KEY, JSON.stringify(nextTargets));
  } catch {
    // Ignore storage failures; they should not block saving.
  }
}

export default function NotionSaveModal({
  isOpen,
  paperId,
  paperTitle,
  notes,
  onClose,
  onOpenAccountSettings,
  onSaved,
}: NotionSaveModalProps) {
  const [status, setStatus] = useState<NotionConnectionStatus | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [pages, setPages] = useState<NotionPageSummary[]>([]);
  const [recentTargets, setRecentTargets] = useState<RecentNotionTarget[]>([]);
  const [selectedPageId, setSelectedPageId] = useState('');
  const [destinationTitle, setDestinationTitle] = useState('');
  const [createNewPage, setCreateNewPage] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [lastSearchQuery, setLastSearchQuery] = useState('');

  const selectedPage = useMemo(
    () => pages.find(page => page.id === selectedPageId) || recentTargets.find(page => page.id === selectedPageId) || null,
    [pages, recentTargets, selectedPageId]
  );

  const starterQueries = useMemo(() => {
    const candidateQueries = [
      paperTitle,
      paperId,
      ...notes.map(note => {
        const title = note?.title;
        return typeof title === 'string' ? title : '';
      }),
    ];
    const seenQueries = new Set<string>();
    const nextQueries: string[] = [];

    for (const candidateQuery of candidateQueries) {
      const normalizedQuery = normalizeSearchSeed(candidateQuery);
      const lookupKey = normalizedQuery.toLowerCase();
      if (!normalizedQuery || seenQueries.has(lookupKey)) {
        continue;
      }

      seenQueries.add(lookupKey);
      nextQueries.push(normalizedQuery);

      if (nextQueries.length >= 4) {
        break;
      }
    }

    return nextQueries;
  }, [notes, paperId, paperTitle]);

  const loadPages = useCallback(async (query: string) => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      setError(null);
      return;
    }

    setSearching(true);
    setError(null);
    try {
      const results = await searchNotionPages(normalizedQuery, 20);
      setPages(results);
      setSelectedPageId(currentSelectedPageId => (
        results.some(page => page.id === currentSelectedPageId)
          ? currentSelectedPageId
          : results[0]?.id || currentSelectedPageId
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to search Notion pages');
    } finally {
      setSearching(false);
    }
  }, []);

  const loadInitialPages = useCallback(async () => {
    setSearching(true);
    setError(null);
    try {
      const results = await listNotionPages(10);
      setPages(results);
      setSelectedPageId(currentSelectedPageId => (
        results.some(page => page.id === currentSelectedPageId)
          ? currentSelectedPageId
          : results[0]?.id || currentSelectedPageId
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Notion pages');
    } finally {
      setSearching(false);
    }
  }, []);

  const runSearch = useCallback(async (query: string) => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return;
    }

    setHasSearched(true);
    setLastSearchQuery(normalizedQuery);
    setSearchQuery(normalizedQuery);
    await loadPages(normalizedQuery);
  }, [loadPages]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setDestinationTitle(`[${paperId}] ${paperTitle || paperId}`);
    setCreateNewPage(true);
    setError(null);
    setSearchQuery('');
    setPages([]);
    setRecentTargets(readRecentTargets());
    setSelectedPageId('');
    setHasSearched(false);
    setLastSearchQuery('');
    setLoadingStatus(true);

    void (async () => {
      try {
        const notionStatus = await getNotionStatus();
        setStatus(notionStatus);
        if (notionStatus.connected) {
          await loadInitialPages();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load Notion status');
      } finally {
        setLoadingStatus(false);
      }
    })();
  }, [isOpen, loadInitialPages, paperId, paperTitle]);

  const handleSearch = async () => {
    await runSearch(searchQuery);
  };

  const handleSave = async () => {
    if (!status?.connected) {
      setError('Connect a Notion account in Account Settings before saving.');
      return;
    }
    if (!selectedPageId) {
      setError('Select a target Notion page first.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = await saveNotionNotes({
        paper_id: paperId,
        paper_title: paperTitle || paperId,
        notes,
        target_page_id: selectedPageId,
        destination_title: destinationTitle.trim(),
        create_new_page: createNewPage,
        updated_at: new Date().toISOString(),
      });
      if (selectedPage) {
        writeRecentTarget(selectedPage);
        setRecentTargets(readRecentTargets());
      }
      onSaved?.(result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save to Notion');
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      backgroundColor: 'rgba(15, 23, 42, 0.58)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1200,
      padding: '20px',
    }}>
      <div style={{
        width: '720px',
        maxWidth: '96vw',
        maxHeight: '88vh',
        overflow: 'hidden',
        backgroundColor: '#ffffff',
        borderRadius: '18px',
        boxShadow: '0 24px 64px rgba(15, 23, 42, 0.25)',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{
          padding: '18px 22px',
          borderBottom: '1px solid #e2e8f0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: '#1e293b' }}>Save To Notion</div>
            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
              Choose a parent page, then create a child page or write into the selected page directly.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              color: '#64748b',
              fontSize: '24px',
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            &times;
          </button>
        </div>

        <div style={{ padding: '20px 22px', overflowY: 'auto' }}>
          {error ? (
            <div style={{
              marginBottom: '16px',
              borderRadius: '10px',
              border: '1px solid #fecaca',
              backgroundColor: '#fff1f2',
              color: '#b91c1c',
              padding: '12px 14px',
              fontSize: '13px',
            }}>
              {error}
            </div>
          ) : null}

          <div style={{
            marginBottom: '16px',
            borderRadius: '12px',
            border: '1px solid #e2e8f0',
            backgroundColor: '#f8fafc',
            padding: '14px',
          }}>
            <div style={{ fontSize: '12px', color: '#64748b' }}>Notion Connection</div>
            <div style={{ marginTop: '6px', fontSize: '15px', fontWeight: 600, color: '#0f172a' }}>
              {loadingStatus ? 'Checking connection...' : status?.connected ? (status.workspace_name || 'Connected') : 'Disconnected'}
            </div>
            {!loadingStatus && !status?.connected ? (
              <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ color: '#64748b', fontSize: '13px' }}>
                  Open Account Settings and connect Notion before saving.
                </div>
                {onOpenAccountSettings ? (
                  <button
                    type="button"
                    onClick={onOpenAccountSettings}
                    style={{
                      padding: '8px 12px',
                      borderRadius: '8px',
                      border: '1px solid #cbd5e1',
                      backgroundColor: '#fff',
                      color: '#1e293b',
                      cursor: 'pointer',
                    }}
                  >
                    Open Account Settings
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          <div style={{ display: 'grid', gap: '12px', marginBottom: '16px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#1e293b', marginBottom: '8px' }}>
                Search Pages
              </label>
              <div style={{ display: 'flex', gap: '10px' }}>
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void handleSearch();
                    }
                  }}
                  placeholder="Search accessible Notion pages"
                  style={{
                    flex: 1,
                    padding: '12px 14px',
                    borderRadius: '10px',
                    border: '1px solid #cbd5e1',
                    fontSize: '14px',
                    outline: 'none',
                  }}
                />
                <button
                  type="button"
                  onClick={() => void handleSearch()}
                  disabled={searching || !status?.connected || searchQuery.trim().length === 0}
                  style={{
                    padding: '0 16px',
                    borderRadius: '10px',
                    border: 'none',
                    backgroundColor: searching || !status?.connected || searchQuery.trim().length === 0 ? '#cbd5e1' : '#1d4ed8',
                    color: '#fff',
                    cursor: searching || !status?.connected || searchQuery.trim().length === 0 ? 'not-allowed' : 'pointer',
                  }}
                >
                  {searching ? 'Searching...' : 'Search'}
                </button>
              </div>
            </div>

            <div style={{
              border: '1px solid #e2e8f0',
              borderRadius: '12px',
              minHeight: '220px',
              maxHeight: '300px',
              overflowY: 'auto',
              backgroundColor: '#ffffff',
            }}>
              {pages.length === 0 ? (
                <div style={{ padding: '20px' }}>
                  <div style={{ textAlign: 'center', color: '#64748b', fontSize: '13px', lineHeight: 1.6 }}>
                    {!status?.connected
                      ? 'Connect Notion to load pages.'
                      : hasSearched
                        ? `No pages found for "${lastSearchQuery}". Try another query or pick a recent destination.`
                        : 'Search is query-based. Start with a page title or ID, or pick one of your recent destinations.'}
                  </div>

                  {status?.connected ? (
                    <div style={{ display: 'grid', gap: '16px', marginTop: '18px' }}>
                      {recentTargets.length > 0 ? (
                        <div>
                          <div style={{ fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '8px' }}>
                            Recent destinations
                          </div>
                          <div style={{ display: 'grid', gap: '8px' }}>
                            {recentTargets.map(page => {
                              const isSelected = page.id === selectedPageId;
                              return (
                                <button
                                  key={page.id}
                                  type="button"
                                  onClick={() => setSelectedPageId(page.id)}
                                  style={{
                                    width: '100%',
                                    textAlign: 'left',
                                    padding: '12px 14px',
                                    borderRadius: '10px',
                                    border: `1px solid ${isSelected ? '#93c5fd' : '#e2e8f0'}`,
                                    backgroundColor: isSelected ? '#eff6ff' : '#ffffff',
                                    cursor: 'pointer',
                                  }}
                                >
                                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#0f172a' }}>{getPrimaryTargetLabel(page)}</div>
                                  <div style={{ marginTop: '4px', fontSize: '12px', color: '#64748b' }}>
                                    {getSecondaryTargetLabel(page)}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}

                      {starterQueries.length > 0 ? (
                        <div>
                          <div style={{ fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '8px' }}>
                            Starter searches
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                            {starterQueries.map(query => (
                              <button
                                key={query}
                                type="button"
                                onClick={() => void runSearch(query)}
                                disabled={searching}
                                style={{
                                  padding: '8px 12px',
                                  borderRadius: '999px',
                                  border: '1px solid #cbd5e1',
                                  backgroundColor: '#ffffff',
                                  color: '#1e293b',
                                  cursor: searching ? 'not-allowed' : 'pointer',
                                }}
                              >
                                Search "{query}"
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : (
                pages.map(page => {
                  const isSelected = page.id === selectedPageId;
                  return (
                    <button
                      key={page.id || page.url}
                      type="button"
                      onClick={() => setSelectedPageId(page.id)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '14px 16px',
                        border: 'none',
                        borderBottom: '1px solid #f1f5f9',
                        backgroundColor: isSelected ? '#eff6ff' : '#ffffff',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#0f172a' }}>
                        {getPrimaryTargetLabel(page)}
                      </div>
                      <div style={{ marginTop: '4px', fontSize: '12px', color: '#64748b' }}>
                        {getSecondaryTargetLabel(page)}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div style={{
            borderRadius: '12px',
            border: '1px solid #e2e8f0',
            padding: '16px',
            backgroundColor: '#f8fafc',
          }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#1e293b', marginBottom: '8px' }}>
              Destination
            </div>
            <div style={{ fontSize: '13px', color: '#475569', marginBottom: '14px', lineHeight: 1.6 }}>
              {selectedPage
                ? `Selected target: ${getSelectedTargetSummary(selectedPage)}`
                : 'Select a page above to continue.'}
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px', color: '#1e293b', fontSize: '14px' }}>
              <input
                type="checkbox"
                checked={createNewPage}
                onChange={(event) => setCreateNewPage(event.target.checked)}
              />
              Create a new page under the selected target
            </label>

            <div style={{ marginBottom: '14px', color: '#64748b', fontSize: '12px', lineHeight: 1.6 }}>
              {createNewPage
                ? 'The title below becomes the new Notion page title.'
                : 'The title below is used as the section heading when appending into the selected page.'}
            </div>

            <input
              value={destinationTitle}
              onChange={(event) => setDestinationTitle(event.target.value)}
              placeholder="Destination title"
              style={{
                width: '100%',
                padding: '12px 14px',
                borderRadius: '10px',
                border: '1px solid #cbd5e1',
                fontSize: '14px',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>
        </div>

        <div style={{
          padding: '16px 22px',
          borderTop: '1px solid #e2e8f0',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '10px',
        }}>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              padding: '10px 16px',
              borderRadius: '10px',
              border: '1px solid #cbd5e1',
              backgroundColor: '#fff',
              color: '#334155',
              cursor: saving ? 'not-allowed' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !status?.connected || !selectedPageId || notes.length === 0}
            style={{
              padding: '10px 16px',
              borderRadius: '10px',
              border: 'none',
              backgroundColor: saving || !status?.connected || !selectedPageId || notes.length === 0 ? '#cbd5e1' : '#7c3aed',
              color: '#fff',
              cursor: saving || !status?.connected || !selectedPageId || notes.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? 'Saving...' : 'Save To Notion'}
          </button>
        </div>
      </div>
    </div>
  );
}
