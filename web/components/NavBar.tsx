import React from 'react';
import { Bot, KeyRound, MessageSquareText, Orbit, PanelTop, Sparkles } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';

interface NavBarProps {
  onOpenChat: () => void;
  onOpenPipeline: () => void;
  onOpenAccountSettings: () => void;
}

const navItems = [
  { path: '/graph', label: 'Global Graph', icon: Orbit },
  { path: '/neurips2025', label: 'NeurIPS 2025', icon: Sparkles },
  { path: '/iclr2025', label: 'ICLR 2025', icon: PanelTop },
];

export default function NavBar({
  onOpenChat,
  onOpenPipeline,
  onOpenAccountSettings,
}: NavBarProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const navItemClass = (path: string) =>
    `inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
      location.pathname === path
        ? 'border-[#CC5833]/30 bg-[#CC5833] text-[#F2F0E9] shadow-[0_12px_24px_rgba(204,88,51,0.18)]'
        : 'border-[rgba(46,64,54,0.12)] bg-white/70 text-[#2E4036] hover:border-[#CC5833]/30 hover:text-[#CC5833]'
    }`;

  return (
    <nav className="island-nav relative flex flex-wrap items-center justify-between gap-3 rounded-[2rem] border border-[rgba(46,64,54,0.12)] px-3 py-3 text-[#2E4036] shadow-[0_18px_60px_rgba(26,26,26,0.06)] backdrop-blur-xl sm:px-4">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="flex items-center gap-2 rounded-full px-2 py-1 text-left"
        >
          <span className="text-base font-semibold tracking-tight text-[#161616]">Research</span>
          <span className="font-garamond text-3xl italic leading-none text-[#CC5833]">Agent</span>
        </button>

        <div className="flex flex-1 flex-wrap items-center gap-2">
          {navItems.map(({ path, label, icon: Icon }) => (
            <button
              key={path}
              type="button"
              onClick={() => navigate(path)}
              className={navItemClass(path)}
            >
              <Icon size={16} strokeWidth={2} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto sm:justify-start">
        <button
          type="button"
          onClick={onOpenChat}
          className="inline-flex items-center gap-2 rounded-full border border-[rgba(46,64,54,0.12)] bg-white/75 px-4 py-2 text-sm font-medium text-[#2E4036] transition-colors hover:border-[#CC5833]/30 hover:text-[#CC5833]"
        >
          <MessageSquareText size={16} strokeWidth={2} />
          <span>LLM Chat</span>
        </button>
        <button
          type="button"
          onClick={onOpenPipeline}
          className="inline-flex items-center gap-2 rounded-full bg-[#2E4036] px-4 py-2 text-sm font-semibold text-[#F2F0E9] shadow-[0_16px_30px_rgba(46,64,54,0.2)] transition-transform hover:-translate-y-0.5 hover:bg-[#24332b]"
        >
          <Bot size={16} strokeWidth={2} />
          <span>Run Pipeline</span>
        </button>
        <button
          type="button"
          onClick={onOpenAccountSettings}
          className="inline-flex items-center gap-2 rounded-full border border-[rgba(46,64,54,0.12)] bg-white/75 px-4 py-2 text-sm font-medium text-[#2E4036] transition-colors hover:border-[#CC5833]/30 hover:text-[#CC5833]"
        >
          <KeyRound size={16} strokeWidth={2} />
          <span>Account</span>
        </button>
      </div>
    </nav>
  );
}
