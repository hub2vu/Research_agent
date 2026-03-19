import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AuthorizationSequence from '../components/landing/AuthorizationSequence';
import ContextCardsPanel from '../components/landing/ContextCardsPanel';
import LandingHero from '../components/landing/LandingHero';
import LandingNav from '../components/landing/LandingNav';
import VenueAtlas from '../components/landing/VenueAtlas';

interface LandingPageProps {
  onOpenPipeline: () => void;
  onOpenAccountSettings: () => void;
}

export default function LandingPage({
  onOpenPipeline,
  onOpenAccountSettings,
}: LandingPageProps) {
  const navigate = useNavigate();
  const [activePanel, setActivePanel] = useState<'venue' | 'context-cards'>('venue');

  const openGraph = () => navigate('/graph');

  return (
    <>
      <main className="relative min-h-screen text-[#161616] selection:bg-[#CC5833]/30 selection:text-[#161616]">
        <LandingNav
          onOpenWorkspace={onOpenPipeline}
          onOpenAccountSettings={onOpenAccountSettings}
        />
        <LandingHero
          activePanel={activePanel}
          onPanelChange={setActivePanel}
          onSearchEnter={() => {}}
          onOpenGraph={openGraph}
        />
        {activePanel === 'venue' && <VenueAtlas />}
        {activePanel === 'context-cards' && <ContextCardsPanel />}
      </main>
      <AuthorizationSequence
        onOpenWorkspace={onOpenPipeline}
        onOpenPipeline={onOpenPipeline}
        onReviewResults={() => navigate('/neurips2025')}
      />
    </>
  );
}
