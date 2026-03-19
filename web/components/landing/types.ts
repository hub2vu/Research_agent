export type Scope = 'Generalist' | 'Field-Flagship' | 'Specialist';

export type Venue = {
  id: string;
  name: string;
  scope: Scope;
  description: string;
  signals: string[];
  route?: string;
  statusLabel?: string;
  indexedCount?: string;
};

export type TaxonomyCommunity = {
  id: string;
  label: string;
  venues: Venue[];
};
