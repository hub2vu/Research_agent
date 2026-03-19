import React, { useRef, useState } from 'react';
import { BookOpen, CheckCircle2, Filter, Layers, Search, Sparkles } from 'lucide-react';
import { SCOPES } from './taxonomy';

export type LandingPanel = 'venue' | 'context-cards';

interface LandingHeroProps {
  activePanel: LandingPanel;
  onPanelChange: (panel: LandingPanel) => void;
  onSearchEnter: () => void;
  onOpenGraph: () => void;
}

export default function LandingHero({
  activePanel,
  onPanelChange,
  onSearchEnter,
  onOpenGraph,
}: LandingHeroProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLDivElement | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  return (
    <section
      ref={containerRef}
      className="relative flex w-full flex-col justify-start overflow-hidden px-6 pb-10 pt-32 md:px-16 lg:px-24"
    >
      <div className="absolute inset-0 z-0 bg-[#F2F0E9]">
        <img
          src="https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?auto=format&fit=crop&w=2400&q=80"
          alt="Abstract nodes"
          className="h-full w-full scale-105 object-cover opacity-15 mix-blend-multiply grayscale"
        />
        <div className="pointer-events-none absolute left-0 top-0 z-0 h-48 w-full bg-gradient-to-b from-black/40 via-transparent to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#F2F0E9] via-[#F2F0E9]/80 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-[#F2F0E9] via-transparent to-transparent opacity-80" />
      </div>

      <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-col items-center">
        <div className="animate-fade-up delay-200 text-center">
          <p className="font-mono-data text-xs uppercase tracking-[0.24em] text-[#2E4036]/65">
            Research Agent Local Shell
          </p>
          <h1 className="mt-5 max-w-4xl text-5xl font-bold tracking-tight text-[#161616] md:text-7xl">
            Map conferences, then drop into the live paper workspace.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base text-[#161616]/65 md:text-lg">
            Start in Venue Atlas, then route straight into the existing NeurIPS 2025, ICLR 2025, and global graph flows.
          </p>
        </div>

        <div
          id="search-anchor"
          ref={searchRef}
          className="relative z-20 mt-10 w-full max-w-4xl animate-fade-up delay-800"
        >
          <div className="glass-panel focus-ring-signal flex flex-col rounded-[2rem] p-2 transition-all duration-300">
            <div className="relative z-10 flex items-center px-4 py-3">
              <Search className="mr-4 text-black/40" size={24} />
              <input
                type="text"
                placeholder="Ask or search AI paper"
                className="flex-1 bg-transparent text-lg font-medium text-[#161616] outline-none placeholder:text-black/40 md:text-xl"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    onSearchEnter();
                  }
                }}
              />
              <button
                type="button"
                onClick={() => setShowFilters((current) => !current)}
                className={`ml-4 flex items-center gap-2 rounded-full border px-4 py-2 transition-colors ${
                  showFilters
                    ? 'border-black/20 bg-black/5 text-[#161616]'
                    : 'border-black/10 text-black/60 hover:bg-black/5 hover:text-[#161616]'
                }`}
              >
                <Filter size={16} />
                <span className="hidden text-sm font-medium sm:inline">Filters</span>
              </button>
            </div>

            <div
              className={`overflow-hidden transition-all duration-500 ease-in-out ${
                showFilters ? 'mt-2 max-h-[400px] border-t border-black/10 opacity-100' : 'max-h-0 opacity-0'
              }`}
            >
              <div className="grid grid-cols-1 gap-8 p-6 text-sm md:grid-cols-3">
                <div>
                  <h4 className="mb-3 font-mono-data text-xs uppercase tracking-wider text-black/40">Scope</h4>
                  <div className="flex flex-wrap gap-2">
                    {SCOPES.map((scope) => (
                      <span
                        key={scope}
                        className="cursor-default rounded-full border border-black/10 bg-black/5 px-3 py-1 text-[#161616] transition-colors hover:border-[#CC5833]/50"
                      >
                        {scope}
                      </span>
                    ))}
                  </div>
                </div>

                <div>
                  <h4 className="mb-3 font-mono-data text-xs uppercase tracking-wider text-black/40">Toggles</h4>
                  <div className="space-y-3">
                    <label className="group flex cursor-default items-center gap-3">
                      <div className="flex h-5 w-5 items-center justify-center rounded border border-black/20 group-hover:border-black/40">
                        <CheckCircle2 size={14} className="opacity-0" />
                      </div>
                      <span className="text-[#161616]">Conference pages available</span>
                    </label>
                    <label className="group flex cursor-default items-center gap-3">
                      <div className="flex h-5 w-5 items-center justify-center rounded border border-[#CC5833] bg-[#CC5833]/10">
                        <CheckCircle2 size={14} className="text-[#CC5833]" />
                      </div>
                      <span className="text-[#161616]">Global graph route enabled</span>
                    </label>
                  </div>
                </div>

                <div>
                  <h4 className="mb-3 font-mono-data text-xs uppercase tracking-wider text-black/40">Suggestions</h4>
                  <div className="space-y-2">
                    {['Diffusion models', 'RAG techniques', 'Alignment', 'World models'].map((tag) => (
                      <div key={tag} className="flex items-center gap-2 text-black/60 transition-colors hover:text-[#161616]">
                        <Sparkles size={14} className="text-[#CC5833]" />
                        <span>{tag}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 w-full max-w-4xl animate-fade-up delay-400">
          <div className="inline-flex w-full flex-wrap items-center gap-2 rounded-2xl border border-[#2E4036]/15 bg-white/80 p-2">
            <button
              type="button"
              onClick={() => onPanelChange('venue')}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm transition-colors ${
                activePanel === 'venue'
                  ? 'bg-[#2E4036] text-[#F2F0E9]'
                  : 'text-[#1A1A1A]/70 hover:bg-[#2E4036]/10'
              }`}
            >
              <Layers size={15} />
              <span>Venue Atlas</span>
            </button>
            <button
              type="button"
              onClick={onOpenGraph}
              className="flex items-center gap-2 rounded-xl px-4 py-2 text-sm text-[#1A1A1A]/70 transition-colors hover:bg-[#2E4036]/10"
            >
              <BookOpen size={15} />
              <span>Global Paper</span>
            </button>
            <button
              type="button"
              onClick={() => onPanelChange('context-cards')}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm transition-colors ${
                activePanel === 'context-cards'
                  ? 'bg-[#2E4036] text-[#F2F0E9]'
                  : 'text-[#1A1A1A]/70 hover:bg-[#2E4036]/10'
              }`}
            >
              <Sparkles size={15} />
              <span>Context cards</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
