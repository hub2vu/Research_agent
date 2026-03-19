export interface RecentPaperEntry {
  paperId: string;
  title: string;
  venue: string;
  route: string;
  viewedAt: number;
}

const RECENT_PAPERS_STORAGE_KEY = 'recent-papers';
const MAX_RECENT_PAPERS = 3;
export const RECENT_PAPERS_EVENT = 'recent-papers-updated';

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function normalizeText(value: string | undefined, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function chooseBetterTitle(current: string, next: string, paperId: string) {
  const normalizedCurrent = normalizeText(current, paperId);
  const normalizedNext = normalizeText(next, paperId);

  if (normalizedCurrent === paperId && normalizedNext !== paperId) {
    return normalizedNext;
  }
  return normalizedNext || normalizedCurrent;
}

function chooseBetterVenue(current: string, next: string) {
  const normalizedCurrent = normalizeText(current, 'Workspace');
  const normalizedNext = normalizeText(next, normalizedCurrent);
  if (normalizedCurrent === 'Workspace' && normalizedNext !== 'Workspace') {
    return normalizedNext;
  }
  return normalizedNext || normalizedCurrent;
}

function readStoredRecentPapers(): RecentPaperEntry[] {
  if (!canUseStorage()) {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(RECENT_PAPERS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed;
  } catch {
    return [];
  }
}

function normalizeRecentPapers(entries: RecentPaperEntry[]) {
  const byPaperId = new Set<string>();

  return entries
    .filter((item): item is RecentPaperEntry => Boolean(item?.paperId && item?.route))
    .sort((left, right) => right.viewedAt - left.viewedAt)
    .filter(item => {
      if (byPaperId.has(item.paperId)) {
        return false;
      }

      byPaperId.add(item.paperId);
      return true;
    })
    .slice(0, MAX_RECENT_PAPERS);
}

function persistRecentPapers(entries: RecentPaperEntry[]) {
  window.localStorage.setItem(RECENT_PAPERS_STORAGE_KEY, JSON.stringify(entries));
}

export function getRecentPapers(limit = MAX_RECENT_PAPERS): RecentPaperEntry[] {
  const stored = readStoredRecentPapers();
  const normalized = normalizeRecentPapers(stored);

  if (canUseStorage() && JSON.stringify(stored) !== JSON.stringify(normalized)) {
    persistRecentPapers(normalized);
  }

  return normalized.slice(0, Math.max(0, limit));
}

export function recordRecentPaper(entry: Omit<RecentPaperEntry, 'viewedAt'>) {
  if (!canUseStorage()) {
    return;
  }

  const normalizedEntry: RecentPaperEntry = {
    paperId: normalizeText(entry.paperId),
    title: normalizeText(entry.title, normalizeText(entry.paperId)),
    venue: normalizeText(entry.venue, 'Workspace'),
    route: normalizeText(entry.route),
    viewedAt: Date.now(),
  };

  if (!normalizedEntry.paperId || !normalizedEntry.route) {
    return;
  }

  const current = normalizeRecentPapers(readStoredRecentPapers());
  const existing = current.find(item => item.paperId === normalizedEntry.paperId);
  const merged: RecentPaperEntry = existing
    ? {
        ...existing,
        title: chooseBetterTitle(existing.title, normalizedEntry.title, normalizedEntry.paperId),
        venue: chooseBetterVenue(existing.venue, normalizedEntry.venue),
        route: normalizedEntry.route || existing.route,
        viewedAt: normalizedEntry.viewedAt,
      }
    : normalizedEntry;

  const next = normalizeRecentPapers([merged, ...current.filter(item => item.paperId !== merged.paperId)]);
  persistRecentPapers(next);
  window.dispatchEvent(new CustomEvent(RECENT_PAPERS_EVENT, { detail: next }));
}
