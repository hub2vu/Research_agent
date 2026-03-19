import React from 'react';
import { ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { Venue } from './types';

interface VenueCardProps {
  venue: Venue;
}

export default function VenueCard({ venue }: VenueCardProps) {
  const navigate = useNavigate();
  const clickable = Boolean(venue.route);

  const content = (
    <>
      <div className="absolute inset-0 z-0 bg-gradient-to-br from-[#CC5833]/5 to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100" />

      <div className="relative z-10">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h4 className="text-2xl font-bold tracking-tight text-[#161616]">{venue.name}</h4>
              <span className="rounded-full bg-black/5 px-2.5 py-1 font-mono-data text-[10px] uppercase tracking-[0.16em] text-black/45">
                {venue.scope}
              </span>
            </div>
            <p className="text-sm font-medium text-black/60">{venue.description}</p>
          </div>
          <span
            className={`rounded-full p-2 transition-colors ${
              clickable ? 'bg-black/5 text-black/50 group-hover:bg-[#CC5833] group-hover:text-white' : 'bg-black/5 text-black/25'
            }`}
          >
            <ArrowRight size={16} />
          </span>
        </div>
      </div>

      <div className="relative z-10 mt-6">
        <p className="mb-3 font-mono-data text-xs uppercase tracking-wider text-black/30">Trending Signals</p>
        <div className="flex flex-wrap gap-2">
          {venue.signals.map((chip) => (
            <span
              key={chip}
              className="rounded-md border border-black/10 bg-white px-2.5 py-1 text-xs text-black/70 transition-colors group-hover:border-black/20"
            >
              {chip}
            </span>
          ))}
        </div>
      </div>

      <div className="absolute inset-0 z-20 flex translate-y-full flex-col border-t border-black/10 bg-[#EAE7DF] p-6 transition-transform duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:translate-y-0">
        <h5 className="mb-2 text-lg font-bold text-[#161616]">{venue.name} Atlas Entry</h5>
        <p className="mb-4 text-sm text-black/60">
          {clickable ? 'Open the live conference page in the existing util app.' : 'This venue stays in atlas mode until a matching conference route exists.'}
        </p>
        <div className="mt-auto flex items-center justify-between text-sm font-mono-data">
          <span className={clickable ? 'text-[#CC5833]' : 'text-black/45'}>{venue.statusLabel ?? 'Coming soon'}</span>
          <span className="text-black/30">{venue.indexedCount ?? 'Mapping in progress'}</span>
        </div>
      </div>
    </>
  );

  if (!clickable) {
    return (
      <div className="glass-panel group relative flex min-h-[240px] flex-col justify-between overflow-hidden rounded-[2rem] border border-black/10 p-6">
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => navigate(venue.route!)}
      className="glass-panel group relative flex min-h-[240px] cursor-pointer flex-col justify-between overflow-hidden rounded-[2rem] border border-black/10 p-6 text-left transition-all duration-500 hover:border-black/20"
    >
      {content}
    </button>
  );
}
