import React, { useState } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import AccountSettingsModal from './components/AccountSettingsModal';
import LLMChatPopup from './components/LLMChatPopup';
import NavBar from './components/NavBar';
import PipelineModal from './components/PipelineModal';
import GlobalGraphPage from './pages/GlobalGraphPage';
import HomePage from './pages/HomePage';
import ICLR2025Page from './pages/ICLR2025Page';
import NeurIPS2025Page from './pages/NeurIPS2025Page';
import NotePage from './pages/NotePage';
import PaperGraphPage from './pages/PaperGraphPage';

function PaperGraphWrapper() {
  return <PaperGraphPage />;
}

function AppContent() {
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isPipelineOpen, setIsPipelineOpen] = useState(false);
  const [isAccountSettingsOpen, setIsAccountSettingsOpen] = useState(false);
  const location = useLocation();
  const isLandingRoute = location.pathname === '/';

  const appRoutes = (
    <Routes>
      <Route
        path="/"
        element={(
          <HomePage
            onOpenPipeline={() => setIsPipelineOpen(true)}
            onOpenAccountSettings={() => setIsAccountSettingsOpen(true)}
          />
        )}
      />
      <Route path="/graph" element={<GlobalGraphPage />} />
      <Route path="/paper/:paperId" element={<PaperGraphWrapper />} />
      <Route path="/neurips2025" element={<NeurIPS2025Page />} />
      <Route path="/iclr2025" element={<ICLR2025Page />} />
      <Route
        path="/note/:paperId"
        element={<NotePage onOpenAccountSettings={() => setIsAccountSettingsOpen(true)} />}
      />
    </Routes>
  );

  return (
    <div className="relative min-h-screen bg-[#f2f0e9] text-[#161616] selection:bg-[#CC5833]/30 selection:text-[#161616]">
      <div className="bg-noise" />

      {isLandingRoute ? (
        <div className="relative z-10">{appRoutes}</div>
      ) : (
        <div className="relative z-10 flex h-screen min-h-screen flex-col px-3 pb-4 pt-4 sm:px-4 lg:px-6">
          <div className="mx-auto flex w-full max-w-[1600px] flex-1 min-h-0 flex-col gap-4">
            <NavBar
              onOpenChat={() => setIsChatOpen(true)}
              onOpenPipeline={() => setIsPipelineOpen(true)}
              onOpenAccountSettings={() => setIsAccountSettingsOpen(true)}
            />
            <div className="flex-1 min-h-0 overflow-hidden rounded-[2rem] border border-[rgba(46,64,54,0.12)] bg-[rgba(255,255,255,0.5)] shadow-[0_24px_80px_rgba(26,26,26,0.08)] backdrop-blur-sm">
              <div className="h-full min-h-0">
                {appRoutes}
              </div>
            </div>
          </div>
        </div>
      )}

      <LLMChatPopup isOpen={isChatOpen} onClose={() => setIsChatOpen(false)} />
      <PipelineModal isOpen={isPipelineOpen} onClose={() => setIsPipelineOpen(false)} />
      <AccountSettingsModal
        isOpen={isAccountSettingsOpen}
        onClose={() => setIsAccountSettingsOpen(false)}
      />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}
