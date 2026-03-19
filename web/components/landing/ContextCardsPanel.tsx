import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getRecentPapers, type RecentPaperEntry, RECENT_PAPERS_EVENT } from '../../lib/recentPapers';

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

function formatRoute(route: string) {
  const cleanRoute = route.split('?')[0]?.replace(/^\//, '') || 'graph';
  return cleanRoute.replace(/-/g, ' ');
}

function getFooterFields(paper: RecentPaperEntry) {
  return [
    { label: 'Paper ID', value: paper.paperId },
    { label: 'Route', value: formatRoute(paper.route) },
    { label: 'Last Viewed', value: formatViewedAt(paper.viewedAt) },
  ];
}

export default function ContextCardsPanel() {
  const navigate = useNavigate();
  const [recentPapers, setRecentPapers] = useState<RecentPaperEntry[]>(() => getRecentPapers());
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);
  const innerRefs = useRef<Array<HTMLButtonElement | null>>([]);

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

  useLayoutEffect(() => {
    if (recentPapers.length < 2) {
      innerRefs.current.forEach((inner) => {
        if (!inner) {
          return;
        }

        inner.style.transform = 'scale(1)';
        inner.style.filter = 'blur(0px)';
        inner.style.opacity = '1';
      });
      return;
    }

    let frame = 0;

    const updateStack = () => {
      frame = 0;
      const isDesktop = window.innerWidth >= 768;
      const scaleDrop = isDesktop ? 0.14 : 0.07;
      const blurMax = isDesktop ? 12 : 5;
      const opacityDrop = isDesktop ? 0.55 : 0.35;
      const stickyTop = isDesktop ? 80 : 64;

      innerRefs.current.forEach((inner, index) => {
        if (!inner) {
          return;
        }

        if (index === innerRefs.current.length - 1) {
          inner.style.transform = 'scale(1)';
          inner.style.filter = 'blur(0px)';
          inner.style.opacity = '1';
          return;
        }

        const card = cardRefs.current[index];
        if (!card) {
          return;
        }

        const { top, height } = card.getBoundingClientRect();
        const progress = Math.max(0, Math.min(1, (stickyTop - top) / Math.max(height, 1)));

        inner.style.transform = `scale(${1 - scaleDrop * progress})`;
        inner.style.filter = `blur(${(blurMax * progress).toFixed(2)}px)`;
        inner.style.opacity = String(1 - opacityDrop * progress);
      });
    };

    const scheduleUpdate = () => {
      if (frame) {
        return;
      }

      frame = window.requestAnimationFrame(updateStack);
    };

    updateStack();
    window.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);

    return () => {
      window.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [recentPapers]);

  const stackHeight = useMemo(() => `${Math.max(recentPapers.length, 1) * 90}vh`, [recentPapers.length]);

  return (
    <section
      id="context-cards"
      className="relative border-t border-[#2E4036]/10 bg-[#EAE7DF] px-6 pb-24 pt-12 md:px-16 lg:px-24"
    >
      <div className="mx-auto max-w-7xl">
        <div className="mb-10 text-center">
          <p className="mb-3 font-mono-jb text-[11px] uppercase tracking-[0.2em] text-[#1A1A1A]/45">
            Stacking Archive
          </p>
          <h3 className="font-outfit text-3xl font-light text-[#1A1A1A] md:text-4xl">
            Context cards that <span className="font-garamond italic text-[#CC5833]">layer by relevance.</span>
          </h3>
        </div>

        {recentPapers.length > 0 ? (
          <div style={{ height: stackHeight }} className="relative w-full">
            {recentPapers.map((paper, index) => (
              <div
                key={paper.paperId}
                ref={(node) => {
                  cardRefs.current[index] = node;
                }}
                className="stack-card sticky top-16 flex h-[78vh] w-full items-center justify-center pb-8 md:top-20"
              >
                <button
                  ref={(node) => {
                    innerRefs.current[index] = node;
                  }}
                  type="button"
                  onClick={() => navigate(paper.route)}
                  className="card-inner group relative flex h-full max-h-[680px] w-full max-w-5xl flex-col justify-between overflow-hidden rounded-[3rem] border border-[#2E4036]/10 bg-white p-8 text-left shadow-[0_20px_60px_rgba(46,64,54,0.10)] transition-transform md:p-14"
                >
                  <div className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-[#2E4036]/5 blur-3xl" />

                  <div>
                    <div className="mb-10 flex items-start justify-between gap-6">
                      <span className="font-mono-jb text-xs tracking-widest text-[#2E4036]/45">
                        {String(index + 1).padStart(2, '0')} // ARCHIVE
                      </span>
                      <span className="rounded-full bg-[#2E4036]/5 px-4 py-2 font-outfit text-xs font-semibold uppercase tracking-wide text-[#CC5833]">
                        {paper.venue}
                      </span>
                    </div>
                    <h4 className="mb-5 font-garamond text-4xl leading-[1.08] text-[#1A1A1A] md:text-6xl">
                      {paper.title}
                    </h4>
                    <p className="font-outfit text-base text-[#1A1A1A]/55 md:text-lg">{formatViewedAt(paper.viewedAt)}</p>
                  </div>

                  <div className="mt-auto grid grid-cols-1 gap-6 border-t border-[#1A1A1A]/10 pt-10 md:grid-cols-3">
                    {getFooterFields(paper).map((field) => (
                      <div key={`${paper.paperId}-${field.label}`}>
                        <p className="mb-2 font-mono-jb text-[10px] uppercase tracking-widest text-[#1A1A1A]/45">
                          {field.label}
                        </p>
                        <p className="line-clamp-2 font-outfit text-lg font-medium text-[#1A1A1A] first-letter:uppercase">
                          {field.value}
                        </p>
                      </div>
                    ))}
                  </div>

                  <div className="absolute bottom-10 right-10 rounded-full border border-[#2E4036]/12 bg-[#F7F4EE] px-4 py-3 font-mono-jb text-sm text-[#2E4036]/70 transition-colors group-hover:border-[#CC5833]/30 group-hover:text-[#CC5833]">
                    Context archive preview
                  </div>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex min-h-[420px] items-center justify-center">
            <div className="relative flex h-full max-h-[680px] w-full max-w-5xl flex-col justify-between overflow-hidden rounded-[3rem] border border-[#2E4036]/10 bg-white p-8 shadow-[0_20px_60px_rgba(46,64,54,0.08)] md:p-14">
              <div className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-[#2E4036]/5 blur-3xl" />
              <div>
                <div className="mb-10 flex items-start justify-between gap-6">
                  <span className="font-mono-jb text-xs tracking-widest text-[#2E4036]/45">00 // ARCHIVE</span>
                  <span className="rounded-full bg-[#2E4036]/5 px-4 py-2 font-outfit text-xs font-semibold uppercase tracking-wide text-[#CC5833]">
                    Workspace
                  </span>
                </div>
                <h4 className="mb-5 font-garamond text-4xl leading-[1.08] text-[#1A1A1A] md:text-6xl">
                  Recently viewed papers will appear here.
                </h4>
                <p className="font-outfit text-base text-[#1A1A1A]/55 md:text-lg">
                  Open a paper from NeurIPS 2025, ICLR 2025, notes, or the global graph to seed this archive.
                </p>
              </div>

              <div className="mt-auto grid grid-cols-1 gap-6 border-t border-[#1A1A1A]/10 pt-10 md:grid-cols-3">
                <div>
                  <p className="mb-2 font-mono-jb text-[10px] uppercase tracking-widest text-[#1A1A1A]/45">Paper ID</p>
                  <p className="font-outfit text-lg font-medium text-[#1A1A1A]">Awaiting first context</p>
                </div>
                <div>
                  <p className="mb-2 font-mono-jb text-[10px] uppercase tracking-widest text-[#1A1A1A]/45">Route</p>
                  <p className="font-outfit text-lg font-medium text-[#1A1A1A]">Stored from existing paper pages</p>
                </div>
                <div>
                  <p className="mb-2 font-mono-jb text-[10px] uppercase tracking-widest text-[#1A1A1A]/45">Last Viewed</p>
                  <p className="font-outfit text-lg font-medium text-[#1A1A1A]">Local activity only</p>
                </div>
              </div>

              <div className="absolute bottom-10 right-10 rounded-full border border-[#2E4036]/12 bg-[#F7F4EE] px-4 py-3 font-mono-jb text-sm text-[#2E4036]/70">
                Context archive preview
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
