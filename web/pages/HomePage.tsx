import LandingPage from './LandingPage';

interface HomePageProps {
  onOpenPipeline: () => void;
  onOpenAccountSettings: () => void;
}

export default function HomePage({
  onOpenPipeline,
  onOpenAccountSettings,
}: HomePageProps) {
  return (
    <LandingPage
      onOpenPipeline={onOpenPipeline}
      onOpenAccountSettings={onOpenAccountSettings}
    />
  );
}
