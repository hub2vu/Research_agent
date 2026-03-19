import React, { useEffect, useState } from 'react';
import { BookOpen, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getRecentPapers, RecentPaperEntry, RECENT_PAPERS_EVENT } from '../../lib/recentPapers';

interface ResultsPreviewStripProps {
  onOpenGraph: () => void;
}

function formatViewedAt(viewedAt: number) {
  const elapsedMs = Math.max(0, Date.now() - viewedAt);
  const elapsedMinutes = Math.floor(elapsedMs / 60000);

  if (elapsedMinutes < 1) {
    return 'Viewed just now';
  }
  if (elapsedMinutes < 60) {
    return `Viewed ${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `Viewed ${elapsedHours}h ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `Viewed ${elapsedDays}d ago`;
}

export default function ResultsPreviewStrip({ onOpenGraph }: ResultsPreviewStripProps) {
  const navigate = useNavigate();
  const [recentPapers, setRecentPapers] = useState<RecentPaperEntry[]>(() => getRecentPapers());

  useEffect(() => {
    const syncRecentPapers = () => {
      setRecentPapers(getRecentPapers());
    };

    syncRecentPapers();
    window.addEventListener('storage', syncRecentPapers);
    window.addEventListener(RECENT_PAPERS_EVENT, syncRecentPapers as EventListener);

    return () => {
      window.removeEventListener('storage', syncRecentPapers);
      window.removeEventListener(RECENT_PAPERS_EVENT, syncRecentPapers as EventListener);
    };
  }, []);

  return (
    <div className="animate-slide-in w-full overflow-hidden border-y border-black/5 bg-[#EAE7DF]">
      <div className="px-6 py-6 md:px-16 lg:px-24">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h3 className="font-mono-data text-xs uppercase tracking-widest text-black/60">Context Cards</h3>
          <button type="button" onClick={onOpenGraph} className="text-xs font-medium text-[#CC5833]">
            Open global graph
          </button>
        </div>
        <div className="hide-scroll flex gap-4 overflow-x-auto pb-4">
          {recentPapers.length > 0 ? recentPapers.map((paper, index) => (
            <button
              key={paper.paperId}
              type="button"
              onClick={() => navigate(paper.route)}
              className="result-card animate-slide-left group flex w-80 flex-shrink-0 rounded-2xl border border-black/10 bg-white p-5 text-left transition-colors hover:border-black/30"
              style={{ animationDelay: `${200 + index * 100}ms` }}
            >
              <div className="flex h-full w-full flex-col">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <span className="rounded-md bg-black/5 px-2 py-1 font-mono-data text-xs text-black/70">
                    {paper.venue}
                  </span>
                  <span className="text-black/30 transition-colors group-hover:text-[#CC5833]">
                    <BookOpen size={16} />
                  </span>
                </div>
                <h4 className="mb-3 line-clamp-2 text-[#161616] transition-colors group-hover:text-[#CC5833]">
                  {paper.title}
                </h4>
                <p className="mt-auto flex items-center gap-1 text-xs text-black/40">
                  <Sparkles size={12} />
                  <span>{formatViewedAt(paper.viewedAt)}</span>
                </p>
              </div>
            </button>
          )) : (
            <div className="result-card flex min-h-[152px] w-full rounded-2xl border border-dashed border-black/10 bg-white/60 p-5">
              <div className="flex flex-col justify-center">
                <h4 className="text-sm font-medium text-[#161616]">Recently viewed papers will appear here.</h4>
                <p className="mt-2 text-sm text-black/50">
                  Open a paper from NeurIPS 2025, ICLR 2025, the global graph, or notes to pin it into this strip.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
