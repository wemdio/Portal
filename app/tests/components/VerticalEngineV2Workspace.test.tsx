import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VeEngineWorkspace } from '@/components/vertical-engine-v2/engine/HypothesisEngineView';
import { ProjectDetail } from '@/components/vertical-engine-v2/engine/ProjectDetail';
import type { VeProject } from '@/lib/verticalEngineV2/types';

const mockEngineCall = jest.fn();
const mockEnginePost = jest.fn();
const mockEnginePatch = jest.fn();

jest.mock('@/components/vertical-engine-v2/engine/api', () => ({
  VE_API: '/api/tools/vertical-engine-v2',
  veEngineCall: (...args: unknown[]) => mockEngineCall(...args),
  veEnginePost: (...args: unknown[]) => mockEnginePost(...args),
  veEnginePatch: (...args: unknown[]) => mockEnginePatch(...args),
}));

const PROJECT: VeProject = {
  id: 'project-1',
  created_by: 'user-1',
  name: 'Northstar Education Group — международная сеть образовательных центров',
  website_url: 'https://northstar.example',
  brief: null,
  status: 'draft',
  market: 'ru',
  error: null,
  llm_model: null,
  tokens_used: 0,
  cost_usd: 0,
  created_at: '2026-08-28T08:00:00.000Z',
  updated_at: '2026-08-28T08:00:00.000Z',
};

const scrollIntoView = jest.fn();
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
);

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  });
});

afterAll(() => {
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});

beforeEach(() => {
  mockEngineCall.mockReset();
  mockEnginePost.mockReset();
  mockEnginePatch.mockReset();
  scrollIntoView.mockReset();
});

describe('<VeEngineWorkspace />', () => {
  it('keeps project creation compact on mobile when projects already exist', async () => {
    mockEngineCall.mockResolvedValue({
      ok: true,
      status: 200,
      data: { projects: [PROJECT] },
    });
    const user = userEvent.setup();
    render(<VeEngineWorkspace />);

    await screen.findByText(PROJECT.name);
    const toggle = screen.getByRole('button', { name: 'Новый проект' });
    const panel = document.getElementById('ve-create-project-panel');

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(panel).toHaveClass('hidden');

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(panel).not.toHaveClass('hidden');
  });

  it('opens the creation form immediately for an empty workspace', async () => {
    mockEngineCall.mockResolvedValue({
      ok: true,
      status: 200,
      data: { projects: [] },
    });
    render(<VeEngineWorkspace />);

    await screen.findByText('Здесь появятся проекты');
    expect(screen.queryByRole('button', { name: 'Новый проект' })).not.toBeInTheDocument();
    expect(document.getElementById('ve-create-project-panel')).toHaveClass('block');
    expect(screen.getByText(/Добавьте сайт клиента в форме нового проекта/)).toBeInTheDocument();
  });
});

describe('<ProjectDetail />', () => {
  it('keeps the full project name available and returns content to the top on stage changes', async () => {
    mockEngineCall.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        project: PROJECT,
        hypotheses: [],
        verticals: [],
        chains: [],
        vocabs: [],
        bases: [],
        templates: [],
        jobs: [],
        dossiers: [],
        cases: [],
      },
    });
    const user = userEvent.setup();
    render(<ProjectDetail projectId={PROJECT.id} onBack={jest.fn()} />);

    const title = await screen.findByRole('heading', { name: PROJECT.name, level: 1 });
    expect(title).toHaveClass('line-clamp-2');
    expect(title).toHaveAttribute('title', PROJECT.name);

    scrollIntoView.mockClear();
    await user.click(screen.getByRole('button', { name: /Вертикали/ }));

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    });
  });
});
