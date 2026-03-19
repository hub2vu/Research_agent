import React, { useMemo, useState } from 'react';
import { Activity } from 'lucide-react';
import { TAXONOMY } from './taxonomy';
import VenueCard from './VenueCard';

export default function VenueAtlas() {
  const [activeCommunity, setActiveCommunity] = useState(TAXONOMY[0].id);
  const currentCommunity = useMemo(
    () => TAXONOMY.find((community) => community.id === activeCommunity) ?? TAXONOMY[0],
    [activeCommunity]
  );

  return (
    <section id="venue-atlas" className="relative border-t border-black/5 bg-[#F2F0E9] px-6 pb-24 pt-12 md:px-16 lg:px-24">
      <div className="mx-auto max-w-7xl">
        <div className="mb-16">
          <h2 className="mb-4 text-4xl font-bold tracking-tight text-[#161616] md:text-5xl">
            Venue <span className="font-editorial text-[#CC5833]">Atlas.</span>
          </h2>
          <p className="max-w-xl font-mono-data text-sm uppercase tracking-wider text-[#161616]/60">
            Community Taxonomy Engine
          </p>
        </div>

        <div className="flex flex-col gap-12 lg:flex-row">
          <div className="flex w-full flex-col gap-1 lg:w-1/4">
            <h3 className="mb-4 pl-4 font-mono-data text-xs uppercase tracking-widest text-black/40">Community</h3>
            {TAXONOMY.map((community) => (
              <button
                key={community.id}
                type="button"
                onClick={() => setActiveCommunity(community.id)}
                className={`rounded-xl border px-4 py-3 text-left transition-all duration-300 ${
                  activeCommunity === community.id
                    ? 'border-black/10 bg-black/5 font-medium text-[#161616]'
                    : 'border-transparent text-black/50 hover:bg-black/5 hover:text-[#161616]'
                }`}
              >
                {community.label}
              </button>
            ))}
          </div>

          <div className="w-full lg:w-3/4">
            <div className="grid min-h-[400px] grid-cols-1 gap-6 md:grid-cols-2">
              {currentCommunity.venues.length > 0 ? (
                currentCommunity.venues.map((venue) => <VenueCard key={venue.id} venue={venue} />)
              ) : (
                <div className="col-span-full flex flex-col items-center justify-center rounded-[2rem] border border-dashed border-black/10 p-12 text-center">
                  <Activity className="mb-4 text-black/10" size={48} />
                  <p className="font-mono-data text-sm text-black/40">
                    No venues categorized under {currentCommunity.label}.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
