import React, { useEffect, useState } from 'react';
import { KeyRound, UploadCloud } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface LandingNavProps {
  onOpenWorkspace: () => void;
  onOpenAccountSettings: () => void;
}

export default function LandingNav({
  onOpenWorkspace,
  onOpenAccountSettings,
}: LandingNavProps) {
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <header
      className={`island-nav fixed left-1/2 top-4 z-40 flex w-[95%] max-w-6xl -translate-x-1/2 items-center justify-between rounded-[2rem] px-2 py-2 ${
        scrolled ? 'scrolled text-[#2E4036]' : 'text-[#F2F0E9]'
      }`}
    >
      <button
        type="button"
        onClick={() => navigate('/')}
        className="flex items-center gap-2 px-4 text-left text-lg font-bold tracking-tight"
      >
        <span>Paper</span>
        <span className="font-garamond text-2xl italic leading-none text-[#CC5833]">Atlas</span>
      </button>

      <div className="flex items-center gap-2 pr-2 sm:gap-3">
        <button
          type="button"
          onClick={onOpenWorkspace}
          className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
            scrolled ? 'hover:bg-black/5' : 'hover:bg-white/10'
          }`}
        >
          <UploadCloud size={16} />
          <span className="hidden sm:inline">Open Local Workspace</span>
          <span className="sm:hidden">Workspace</span>
        </button>
        <div
          className={`rounded-full border px-3 py-2 text-[11px] uppercase tracking-[0.18em] ${
            scrolled ? 'border-black/10 bg-white/70 text-[#1A1A1A]' : 'border-white/25 bg-black/25 text-white'
          }`}
        >
          Local MCP Mode
        </div>
        <button
          type="button"
          onClick={onOpenAccountSettings}
          className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
            scrolled
              ? 'border-black/10 bg-white/75 text-[#1A1A1A] hover:border-[#CC5833]/40 hover:text-[#CC5833]'
              : 'border-white/20 bg-black/25 text-white hover:bg-white/10'
          }`}
        >
          <KeyRound size={16} />
          <span className="hidden sm:inline">Account</span>
        </button>
      </div>
    </header>
  );
}
