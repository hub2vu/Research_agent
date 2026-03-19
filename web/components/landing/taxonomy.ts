import type { Scope, TaxonomyCommunity } from './types';

export const TAXONOMY: TaxonomyCommunity[] = [
  {
    id: 'general-ml',
    label: 'General ML & AI',
    venues: [
      {
        id: 'neurips',
        name: 'NeurIPS',
        scope: 'Generalist',
        description: 'Broad top-tier ML venue spanning algorithms, theory, and systems at scale.',
        signals: ['LLM agents', 'diffusion language models', 'embodied world models'],
        route: '/neurips2025',
        statusLabel: 'Live route',
        indexedCount: 'NeurIPS 2025',
      },
      {
        id: 'icml',
        name: 'ICML',
        scope: 'Generalist',
        description: 'General machine learning venue with heavy coverage of scalable learning, foundations, and model behavior.',
        signals: ['foundation-model systems', 'test-time compute', 'robustness'],
        statusLabel: 'Coming soon',
        indexedCount: 'Mapping in progress',
      },
      {
        id: 'iclr',
        name: 'ICLR',
        scope: 'Generalist',
        description: 'Representation learning and deep learning methods with strong generative and optimization content.',
        signals: ['diffusion efficiency', 'multimodal alignment', 'LLM reasoning'],
        route: '/iclr2025',
        statusLabel: 'Live route',
        indexedCount: 'ICLR 2025',
      },
      {
        id: 'aaai',
        name: 'AAAI',
        scope: 'Generalist',
        description: 'General AI across reasoning, learning, and applications, with strong systems and agents coverage.',
        signals: ['AI agents', 'VLM systems', 'efficient GenAI'],
        statusLabel: 'Coming soon',
        indexedCount: 'Mapping in progress',
      },
    ],
  },
  {
    id: 'cv',
    label: 'Computer Vision',
    venues: [
      {
        id: 'cvpr',
        name: 'CVPR',
        scope: 'Field-Flagship',
        description: 'Flagship computer vision venue covering recognition, generation, 3D and vision systems.',
        signals: ['3D Gaussian splatting', 'video generation', 'vision-language models'],
        statusLabel: 'Coming soon',
        indexedCount: 'Mapping in progress',
      },
      {
        id: 'iccv',
        name: 'ICCV',
        scope: 'Field-Flagship',
        description: 'Flagship vision venue with strong representation learning, geometry, and generative methods.',
        signals: ['3D geometry', 'diffusion for video', 'VLM evaluation'],
        statusLabel: 'Coming soon',
        indexedCount: 'Mapping in progress',
      },
    ],
  },
  {
    id: 'nlp',
    label: 'Natural Language Processing',
    venues: [
      {
        id: 'acl',
        name: 'ACL',
        scope: 'Field-Flagship',
        description: 'Flagship NLP venue covering models, evaluation, datasets, and applied language systems.',
        signals: ['RAG pipelines', 'LLM evaluation', 'grounded generation'],
        statusLabel: 'Coming soon',
        indexedCount: 'Mapping in progress',
      },
      {
        id: 'emnlp',
        name: 'EMNLP',
        scope: 'Field-Flagship',
        description: 'Empirical NLP venue with strong focus on evaluation, benchmarks, and applied LLM research.',
        signals: ['agents and collaboration', 'factuality', 'small-model distillation'],
        statusLabel: 'Coming soon',
        indexedCount: 'Mapping in progress',
      },
    ],
  },
];

export const SCOPES: Scope[] = ['Generalist', 'Field-Flagship', 'Specialist'];
