'use client';

/**
 * Шаг 3 «Letters»: генерация цепочки писем по вертикали (дефолтный язык
 * кабинета — EN) и просмотр/инлайн-редактирование писем по шагам.
 * Сохранение — полная замена letters (PATCH /api/client/eng/chains/[id],
 * сервер клампит wait_days и валидирует тем же контрактом, что staff).
 */

import { useMemo, useState } from 'react';
import { Mail, Save } from 'lucide-react';
import type { HeVertical } from '@/lib/hypothesisEngine/types';
import {
  generateEngChain,
  patchEngChain,
  type HeChainDto,
  type HeChainLetterDto,
  type HeJobSummary,
} from './api-client';
import { EngBadge, EngCard, EngSpinner } from './ui';
import type { EngDetail } from './EngProjectWizard';

/** Активная (pending/running) chain-джоба вертикали — кнопка генерации крутится. */
function chainJobFor(jobs: HeJobSummary[], verticalId: string): HeJobSummary | undefined {
  return jobs.find(
    (j) =>
      j.stage === 'chain' &&
      (j.status === 'pending' || j.status === 'running') &&
      j.payload?.vertical_id === verticalId,
  );
}

/** Инлайн-редактор писем цепочки; переиспользуется шагом 5 «Review & Launch». */
export function ChainEditor({
  chain,
  onSaved,
}: {
  chain: HeChainDto;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<HeChainLetterDto[]>(chain.letters);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Пересеяваем черновик, когда цепочка обновилась на сервере (полл/сохранение) —
  // «правка state при смене пропа во время рендера», без set-state-in-effect.
  const chainKey = `${chain.id}:${chain.updated_at}`;
  const [prevChainKey, setPrevChainKey] = useState(chainKey);
  if (chainKey !== prevChainKey) {
    setPrevChainKey(chainKey);
    setDraft(chain.letters);
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(chain.letters);

  const updateLetter = (index: number, patch: Partial<HeChainLetterDto>) => {
    setDraft((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };

  const onSave = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setError('');
    try {
      await patchEngChain(chain.id, draft);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the letters');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <EngBadge label={`language: ${chain.language}`} tone="neutral" />
        <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
          {draft.length} step{draft.length === 1 ? '' : 's'}
        </span>
        {dirty && (
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={saving}
            className="neu-pill active ml-auto px-3 py-1 text-[11px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
            style={{ color: 'var(--cp-paper)' }}
          >
            {saving ? <EngSpinner className="h-3 w-3" /> : <Save className="h-3 w-3" />}
            Save changes
          </button>
        )}
      </div>

      {draft.map((letter, i) => (
        <div
          key={i}
          className="rounded-lg p-3 flex flex-col gap-2"
          style={{ background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)' }}
        >
          <div className="flex items-center gap-2">
            <span className="ds-mono text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
              Step {i + 1}
            </span>
            {i > 0 && (
              <label className="ml-auto inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                wait
                <input
                  type="number"
                  min={0}
                  max={90}
                  value={letter.wait_days ?? 0}
                  onChange={(e) => updateLetter(i, { wait_days: Number(e.target.value) })}
                  className="neu-pill w-16 px-2 py-0.5 text-[11px] bg-transparent outline-none ds-mono"
                  style={{ color: 'var(--cp-paper)' }}
                />
                days
              </label>
            )}
          </div>
          <input
            type="text"
            value={letter.subject ?? ''}
            onChange={(e) => updateLetter(i, { subject: e.target.value })}
            placeholder={i === 0 ? 'Subject' : 'Subject (usually empty — same thread)'}
            className="neu-pill w-full px-3 py-1.5 text-xs bg-transparent outline-none"
            style={{ color: 'var(--cp-paper)' }}
          />
          <textarea
            value={letter.body}
            onChange={(e) => updateLetter(i, { body: e.target.value })}
            rows={6}
            className="neu-pill w-full px-3 py-2 text-xs bg-transparent outline-none resize-y"
            style={{ color: 'var(--cp-paper)' }}
          />
          {(letter.variants?.length ?? 0) > 0 && (
            <span className="text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
              {letter.variants!.length} A/B variant{letter.variants!.length === 1 ? '' : 's'} attached (kept as-is on save)
            </span>
          )}
        </div>
      ))}

      {error && (
        <div className="text-xs" style={{ color: 'var(--cp-red)' }}>
          {error}
        </div>
      )}
    </div>
  );
}

export function EngStepLetters({ detail, onChanged }: { detail: EngDetail; onChanged: () => void }) {
  const verticals = useMemo(() => (detail.verticals ?? []) as HeVertical[], [detail]);
  const chains = useMemo(() => (detail.chains ?? []) as HeChainDto[], [detail]);
  const jobs = useMemo(() => detail.jobs ?? [], [detail]);
  const [busyVerticalId, setBusyVerticalId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const onGenerate = async (verticalId: string) => {
    if (busyVerticalId) return;
    setBusyVerticalId(verticalId);
    setError('');
    try {
      await generateEngChain(verticalId);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start letter generation');
    } finally {
      setBusyVerticalId(null);
    }
  };

  if (verticals.length === 0) {
    return (
      <EngCard>
        <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
          No verticals yet — finish the research and review verticals on step 2 first.
        </p>
      </EngCard>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {verticals.map((v) => {
        // Деталка отдаёт цепочки свежие-первыми — берём последнюю по вертикали.
        const chain = chains.find((c) => c.vertical_id === v.id);
        const activeJob = chainJobFor(jobs, v.id);
        const busy = busyVerticalId === v.id || !!activeJob;
        return (
          <EngCard key={v.id}>
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 shrink-0" style={{ color: 'var(--cp-text-l)' }} />
              <h4 className="text-sm font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
                {v.name}
              </h4>
              <button
                type="button"
                onClick={() => void onGenerate(v.id)}
                disabled={busy}
                className="neu-pill ml-auto px-3 py-1.5 text-[11px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
                style={{ color: 'var(--cp-paper)' }}
              >
                {busy && <EngSpinner className="h-3 w-3" />}
                {chain ? 'Regenerate letters (EN)' : 'Generate letters (EN)'}
              </button>
            </div>

            {activeJob && (
              <p className="mt-2 text-[11px] inline-flex items-center gap-1.5" style={{ color: 'var(--cp-amber)' }}>
                <EngSpinner className="h-3 w-3" /> generation in progress…
              </p>
            )}

            {chain ? (
              <ChainEditor chain={chain} onSaved={onChanged} />
            ) : (
              !activeJob && (
                <p className="mt-2 text-xs" style={{ color: 'var(--cp-text-l)' }}>
                  No letters yet for this vertical.
                </p>
              )
            )}
          </EngCard>
        );
      })}

      {error && (
        <div className="text-sm" style={{ color: 'var(--cp-red)' }}>
          {error}
        </div>
      )}
    </div>
  );
}
