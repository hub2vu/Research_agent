import React from 'react';
import { ArrowRight, BrainCircuit } from 'lucide-react';

interface AuthorizationSequenceProps {
  onOpenWorkspace: () => void;
  onOpenPipeline: () => void;
  onReviewResults: () => void;
}

export default function AuthorizationSequence({
  onOpenWorkspace,
  onOpenPipeline,
  onReviewResults,
}: AuthorizationSequenceProps) {
  return (
    <section className="relative mt-24 overflow-hidden rounded-t-[4rem] bg-[#1A1A1A] pb-12 pt-28 text-[#F2F0E9]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(46,64,54,0.45),transparent_45%),radial-gradient(circle_at_80%_0%,rgba(204,88,51,0.35),transparent_35%)]" />
      <div className="relative z-10 mx-auto mb-20 max-w-6xl px-8">
        <div className="mb-16 text-center">
          <p className="mb-4 font-mono-jb text-xs uppercase tracking-[0.22em] text-[#F2F0E9]/45">Local Workflow</p>
          <h2 className="font-garamond text-5xl italic text-[#F2F0E9] md:text-6xl">
            Run the research loop on your own machine.
          </h2>
        </div>

        <div className="grid grid-cols-1 items-center gap-8 md:grid-cols-3">
          <div className="rounded-[2.5rem] border border-[#F2F0E9]/10 bg-white/[0.01] p-10 transition-colors hover:border-[#F2F0E9]/30">
            <h3 className="mb-2 font-outfit text-xl font-medium text-[#F2F0E9]/65">Watch Folder</h3>
            <div className="mb-8 font-garamond text-5xl">PDF_DIR</div>
            <ul className="mb-10 space-y-4 font-outfit text-sm font-light text-[#F2F0E9]/65">
              <li className="flex items-center gap-3">
                <div className="h-1.5 w-1.5 rounded-full bg-[#F2F0E9]/35" />
                Recursive local PDF discovery
              </li>
              <li className="flex items-center gap-3">
                <div className="h-1.5 w-1.5 rounded-full bg-[#F2F0E9]/35" />
                Existing extracted papers flagged immediately
              </li>
            </ul>
            <button
              type="button"
              onClick={onOpenWorkspace}
              className="w-full rounded-full bg-[#F2F0E9]/5 py-4 font-outfit text-sm text-[#F2F0E9] transition-colors hover:bg-[#F2F0E9]/10"
            >
              Open workspace
            </button>
          </div>

          <div className="relative rounded-[3rem] border border-[#2E4036] bg-[#2E4036] p-12 shadow-2xl md:-translate-y-4">
            <div className="absolute left-1/2 top-[-1rem] -translate-x-1/2 rounded-full bg-[#CC5833] px-4 py-1.5 font-mono-jb text-[10px] font-bold uppercase tracking-widest text-[#F2F0E9]">
              Local First
            </div>
            <h3 className="mb-2 font-outfit text-2xl font-medium text-[#F2F0E9]">Profile + Pipeline</h3>
            <div className="mb-8 font-garamond text-6xl text-[#CC5833]">MCP</div>
            <ul className="mb-10 space-y-4 font-outfit text-base font-light text-[#F2F0E9]/85">
              <li className="flex items-center gap-3">
                <div className="h-2 w-2 rounded-full bg-[#CC5833]" />
                Background job launch and polling
              </li>
              <li className="flex items-center gap-3">
                <div className="h-2 w-2 rounded-full bg-[#CC5833]" />
                Local ranking defaults in `users/profile.json`
              </li>
              <li className="flex items-center gap-3">
                <div className="h-2 w-2 rounded-full bg-[#CC5833]" />
                Report path and status visibility
              </li>
            </ul>
            <button type="button" onClick={onOpenPipeline} className="btn-clay w-full rounded-full py-4 font-outfit font-medium tracking-wide">
              Open pipeline
            </button>
          </div>

          <div className="rounded-[2.5rem] border border-[#F2F0E9]/10 bg-white/[0.01] p-10 transition-colors hover:border-[#CC5833]/35">
            <h3 className="mb-2 font-outfit text-xl font-medium text-[#F2F0E9]/65">Output Trail</h3>
            <div className="mb-8 font-garamond text-5xl">OUTPUT_DIR</div>
            <ul className="mb-10 space-y-4 font-outfit text-sm font-light text-[#F2F0E9]/65">
              <li className="flex items-center gap-3">
                <div className="h-1.5 w-1.5 rounded-full bg-[#F2F0E9]/35" />
                Agent status JSONs
              </li>
              <li className="flex items-center gap-3">
                <div className="h-1.5 w-1.5 rounded-full bg-[#F2F0E9]/35" />
                Markdown reports and extracted assets
              </li>
            </ul>
            <button
              type="button"
              onClick={onReviewResults}
              className="flex w-full items-center justify-center gap-2 rounded-full bg-[#F2F0E9]/5 py-4 font-outfit text-sm text-[#F2F0E9] transition-colors hover:bg-[#F2F0E9]/10"
            >
              Review recent results
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </div>

      <div className="relative z-10 mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 border-t border-[#F2F0E9]/10 px-8 pt-10 md:flex-row">
        <div className="flex items-center gap-3">
          <BrainCircuit size={22} className="text-[#F2F0E9]/35" />
          <span className="font-outfit font-bold tracking-tight text-[#F2F0E9]/35">Paper Atlas (c) 2026</span>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3 text-center">
          <span className="rounded-full border border-[#F2F0E9]/10 bg-[#F2F0E9]/5 px-4 py-2 font-mono-jb text-[10px] uppercase tracking-widest text-[#F2F0E9]/60">
            Proxy via /api
          </span>
          <span className="rounded-full border border-[#F2F0E9]/10 bg-[#F2F0E9]/5 px-4 py-2 font-mono-jb text-[10px] uppercase tracking-widest text-[#F2F0E9]/60">
            No hosted auth
          </span>
          <span className="rounded-full border border-[#F2F0E9]/10 bg-[#F2F0E9]/5 px-4 py-2 font-mono-jb text-[10px] uppercase tracking-widest text-[#F2F0E9]/60">
            Status in Global Paper
          </span>
        </div>
      </div>
    </section>
  );
}
