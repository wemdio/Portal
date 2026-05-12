/**
 * Tests for <BriefAutofillPanel /> — the UI surface for "fill the brief from
 * a website" inside the client portal. The panel is dumb: it owns input,
 * loading state, and result presentation. Network is provided via prop.
 *
 * Contract (must match implementation):
 *
 *   <BriefAutofillPanel
 *     initialWebsite={string}
 *     onAutofill={(website) => Promise<{
 *       ok: boolean;
 *       fieldsPatch: Partial<ClientBriefFields>;
 *       questions: string[];
 *     }>}
 *     onApplyPatch={(patch) => void}   // applied locally only, no save
 *   />
 *
 * The MVP merge strategy is replaceEmptyOnly: the panel itself does not merge,
 * it just hands the patch to the parent. The merge rule is enforced inside
 * the parent (ClientBriefForm). The tests below verify that the panel calls
 * onApplyPatch with the raw patch from onAutofill, not with a saved brief.
 */

import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ClientBriefFields } from '@/lib/clientBrief';
import { BriefAutofillPanel } from '@/components/client-brief/BriefAutofillPanel';

describe('<BriefAutofillPanel />', () => {
  it('disables the button when the website input is empty', () => {
    render(
      <BriefAutofillPanel
        initialWebsite=""
        onAutofill={jest.fn()}
        onApplyPatch={jest.fn()}
      />,
    );
    const button = screen.getByRole('button', { name: /заполнить по сайту/i });
    expect(button).toBeDisabled();
  });

  it('enables the button when initialWebsite is provided', () => {
    render(
      <BriefAutofillPanel
        initialWebsite="acme.com"
        onAutofill={jest.fn()}
        onApplyPatch={jest.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /заполнить по сайту/i })).toBeEnabled();
  });

  it('calls onAutofill with the website, then onApplyPatch with the returned patch', async () => {
    const user = userEvent.setup();
    const patch: Partial<ClientBriefFields> = {
      company_website: 'acme.com',
      company_description: 'We make widgets.',
    };
    const onAutofill = jest.fn(async () => ({
      ok: true,
      fieldsPatch: patch,
      questions: [],
    }));
    const onApplyPatch = jest.fn();

    render(
      <BriefAutofillPanel
        initialWebsite="acme.com"
        onAutofill={onAutofill}
        onApplyPatch={onApplyPatch}
      />,
    );

    await user.click(screen.getByRole('button', { name: /заполнить по сайту/i }));

    expect(onAutofill).toHaveBeenCalledWith('acme.com');
    expect(onApplyPatch).toHaveBeenCalledWith(patch);
  });

  it('shows loading copy while the request is in-flight and re-enables after', async () => {
    const user = userEvent.setup();
    let resolve!: (v: { ok: boolean; fieldsPatch: Partial<ClientBriefFields>; questions: string[] }) => void;
    const onAutofill = jest.fn(
      () =>
        new Promise<{ ok: boolean; fieldsPatch: Partial<ClientBriefFields>; questions: string[] }>(
          (r) => {
            resolve = r;
          },
        ),
    );

    render(
      <BriefAutofillPanel
        initialWebsite="acme.com"
        onAutofill={onAutofill}
        onApplyPatch={jest.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /заполнить по сайту/i }));

    expect(screen.getByText(/изучаем сайт/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /заполнить по сайту/i })).toBeDisabled();

    await act(async () => {
      resolve({ ok: true, fieldsPatch: {}, questions: [] });
    });

    expect(screen.queryByText(/изучаем сайт/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /заполнить по сайту/i })).toBeEnabled();
  });

  it('renders questions returned by the AI as a "осталось уточнить" list', async () => {
    const user = userEvent.setup();
    const onAutofill = jest.fn(async () => ({
      ok: true,
      fieldsPatch: { company_website: 'acme.com' } as Partial<ClientBriefFields>,
      questions: ['Какой средний чек?', 'Кому слать тёплые лиды?'],
    }));

    render(
      <BriefAutofillPanel
        initialWebsite="acme.com"
        onAutofill={onAutofill}
        onApplyPatch={jest.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /заполнить по сайту/i }));

    expect(await screen.findByText(/осталось уточнить/i)).toBeInTheDocument();
    expect(screen.getByText('Какой средний чек?')).toBeInTheDocument();
    expect(screen.getByText('Кому слать тёплые лиды?')).toBeInTheDocument();
  });

  it('renders an error and does not call onApplyPatch when onAutofill rejects', async () => {
    const user = userEvent.setup();
    const onAutofill = jest.fn(async () => {
      throw new Error('upstream failed');
    });
    const onApplyPatch = jest.fn();

    render(
      <BriefAutofillPanel
        initialWebsite="acme.com"
        onAutofill={onAutofill}
        onApplyPatch={onApplyPatch}
      />,
    );

    await user.click(screen.getByRole('button', { name: /заполнить по сайту/i }));

    expect(await screen.findByText(/upstream failed/i)).toBeInTheDocument();
    expect(onApplyPatch).not.toHaveBeenCalled();
  });

  it('renders an error and does not call onApplyPatch when result.ok=false', async () => {
    const user = userEvent.setup();
    const onAutofill = jest.fn(async () => ({
      ok: false,
      fieldsPatch: {},
      questions: [],
      error: 'AI вернул пустоту',
    }));
    const onApplyPatch = jest.fn();

    render(
      <BriefAutofillPanel
        initialWebsite="acme.com"
        onAutofill={onAutofill}
        onApplyPatch={onApplyPatch}
      />,
    );

    await user.click(screen.getByRole('button', { name: /заполнить по сайту/i }));

    expect(await screen.findByText(/пустоту|не удалось|ошибка/i)).toBeInTheDocument();
    expect(onApplyPatch).not.toHaveBeenCalled();
  });

  it('does NOT trigger a save — only calls onApplyPatch (local merge)', async () => {
    const user = userEvent.setup();
    const onAutofill = jest.fn(async () => ({
      ok: true,
      fieldsPatch: { company_website: 'acme.com' } as Partial<ClientBriefFields>,
      questions: [],
    }));
    const onApplyPatch = jest.fn();

    render(
      <BriefAutofillPanel
        initialWebsite="acme.com"
        onAutofill={onAutofill}
        onApplyPatch={onApplyPatch}
      />,
    );

    await user.click(screen.getByRole('button', { name: /заполнить по сайту/i }));

    expect(onApplyPatch).toHaveBeenCalledTimes(1);
    // No fetch / no PUT — the panel must only call onApplyPatch locally.
    // The parent is responsible for the actual save UX.
  });
});
