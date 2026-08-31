import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VerticalEngineV2View } from '@/components/vertical-engine-v2/VerticalEngineV2View';

const mockVeCall = jest.fn();

jest.mock('@/components/vertical-engine-v2/api', () => ({
  VE_API: '/api/tools/vertical-engine-v2',
  veCall: (...args: unknown[]) => mockVeCall(...args),
  veDelete: jest.fn(),
  vePost: jest.fn(),
}));

jest.mock('@/components/vertical-engine-v2/engine/HypothesisEngineView', () => ({
  VeEngineWorkspace: ({
    view,
    onProjectOpenChange,
  }: {
    view?: string;
    onProjectOpenChange?: (open: boolean) => void;
  }) => {
    const React = jest.requireActual<typeof import('react')>('react');
    const [draft, setDraft] = React.useState('');
    const [projectOpen, setProjectOpen] = React.useState(false);

    if (projectOpen) {
      return (
        <div>
          Project detail
          <button
            type="button"
            onClick={() => {
              setProjectOpen(false);
              onProjectOpenChange?.(false);
            }}
          >
            Close project
          </button>
        </div>
      );
    }

    return (
      <div>
        <div>{view === 'launch-queue' ? 'Queue view' : 'Projects view'}</div>
        <label>
          Draft project
          <input value={draft} onChange={(event) => setDraft(event.target.value)} />
        </label>
        <button
          type="button"
          onClick={() => {
            setProjectOpen(true);
            onProjectOpenChange?.(true);
          }}
        >
          Open project
        </button>
      </div>
    );
  },
}));

jest.mock('@/components/vertical-engine-v2/LegacyArchivePanel', () => ({
  LegacyArchivePanel: () => <div>Archive view</div>,
}));

jest.mock('@/components/vertical-engine-v2/LegacyReviewPanel', () => ({
  LegacyReviewPanel: () => <div>Review view</div>,
}));

beforeEach(() => {
  mockVeCall.mockImplementation(async (url: string) => {
    if (url.endsWith('/projects')) {
      return {
        ok: true,
        status: 200,
        data: {
          projects: [],
          permissions: { can_manage_legacy_links: false },
        },
      };
    }
    if (url.endsWith('/legacy/projects')) {
      return { ok: true, status: 200, data: { projects: [] } };
    }
    throw new Error(`Unexpected GET ${url}`);
  });
});

describe('<VerticalEngineV2View /> shell tabs', () => {
  it('uses a complete keyboard-operated ARIA tabs pattern', async () => {
    const user = userEvent.setup();
    render(<VerticalEngineV2View />);

    const projects = await screen.findByRole('tab', { name: /Проекты/i });
    const queue = screen.getByRole('tab', { name: /Очередь запусков/i });
    const archive = screen.getByRole('tab', { name: /Архив/i });

    expect(projects).toHaveAttribute('tabindex', '0');
    expect(queue).toHaveAttribute('tabindex', '-1');
    expect(projects).toHaveAttribute('aria-controls', 've2-root-panel-projects');
    for (const item of [projects, queue, archive]) {
      expect(document.getElementById(item.getAttribute('aria-controls') ?? '')).not.toBeNull();
    }
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', projects.id);

    projects.focus();
    await user.keyboard('{ArrowRight}');
    expect(queue).toHaveFocus();
    expect(queue).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Queue view');

    await user.keyboard('{End}');
    expect(archive).toHaveFocus();
    expect(archive).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Home}');
    expect(projects).toHaveFocus();
    expect(projects).toHaveAttribute('aria-selected', 'true');
  });

  it('preserves workspace state between projects and queue', async () => {
    const user = userEvent.setup();
    render(<VerticalEngineV2View />);

    const draft = await screen.findByRole('textbox', { name: 'Draft project' });
    await user.type(draft, 'Acme');
    await user.click(screen.getByRole('tab', { name: /Очередь запусков/i }));

    expect(screen.getByText('Queue view')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Draft project' })).toHaveValue('Acme');

    await user.click(screen.getByRole('tab', { name: /Проекты/i }));
    expect(screen.getByText('Projects view')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Draft project' })).toHaveValue('Acme');
  });

  it('keeps project detail mounted while shell chrome is hidden', async () => {
    const user = userEvent.setup();
    render(<VerticalEngineV2View />);

    await user.click(await screen.findByRole('button', { name: 'Open project' }));

    expect(screen.getByText('Project detail')).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Разделы движка' })).not.toBeInTheDocument();
    expect(screen.getByText('Project detail').closest('[role="tabpanel"]')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Close project' }));
    expect(await screen.findByRole('tablist', { name: 'Разделы движка' })).toBeInTheDocument();
    expect(screen.getByText('Projects view')).toBeInTheDocument();
  });
});
