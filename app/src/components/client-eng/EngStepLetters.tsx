'use client';

/**
 * Шаг 3 «Letters» — ВИТРИНА писем (без ручных кнопок генерации): цепочки
 * генерирует автопилот («Start outreach», шаг 2), здесь клиент смотрит и
 * инлайн-правит письма по шагам (ChainEditor, сохранение — полная замена
 * letters через PATCH /api/client/eng/chains/[id], сервер клампит wait_days
 * и валидирует тем же контрактом, что staff).
 *
 * Цепочка — ЧЕРНОВИК: в кампанию уходят письма шаблона (he_templates.letters,
 * их показывает шаг 5), а шаблон пишется из цепочки один раз и её больше не
 * перечитывает. Редактор так и подписан (engChainDraftText) — по тому, есть
 * ли у вертикали шаблон.
 *
 * Правила кабинета поверх общего контракта (heClientChainLettersProblem,
 * chainTiming.ts; та же проверка и тот же текст у клиентского роута): не
 * меньше 3 писем и у письма 2+ пауза целым числом 1..90 дней.
 */

import { useMemo, useState } from 'react';
import { Mail, Save } from 'lucide-react';
import type { HeVertical } from '@/lib/hypothesisEngine/types';
import { heClientChainLettersProblem } from '@/lib/hypothesisEngine/chainTiming';
import { patchEngChain, type HeChainDto, type HeChainLetterDto, type HeJobSummary } from './api-client';
import { EngBadge, EngCard, EngSpinner } from './ui';
import { engChainDraftText } from './engText';
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

/**
 * Инлайн-редактор писем цепочки; переиспользуется шагом 5 «Review & Launch».
 * `draftNote` — подпись «это черновик» (engChainDraftText), её выбирает
 * вызывающий: только он знает, есть ли у вертикали шаблон и где редактор стоит.
 */
export function ChainEditor({
  chain,
  draftNote,
  onSaved,
}: {
  chain: HeChainDto;
  draftNote: string;
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
  // Почему черновик не сохранить (null — можно). Показывается всегда, а не
  // только после правки: 0 или пустая пауза, пришедшие с сервера, в шаблон не
  // попадут (там будет лесенка), и клиент должен видеть, что поле не годится.
  // Писем редактор не добавляет и не удаляет — их число всегда то, что пришло
  // с сервера, так что меньше трёх бывает только у цепочки, укороченной вне
  // кабинета, и тогда сохранить её отсюда нельзя (роут ответит тем же 400).
  const problem = heClientChainLettersProblem(draft);

  const updateLetter = (index: number, patch: Partial<HeChainLetterDto>) => {
    setDraft((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };

  const onSave = async () => {
    if (saving || !dirty || problem) return;
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
      <p className="m-0 text-[11px]" style={{ color: 'var(--cp-text-m)' }}>
        {draftNote}
      </p>
      <div className="flex items-center gap-2">
        {/* Не голое «draft»: EngBadge переводит его как статус проекта («idle»). */}
        <EngBadge label="draft letters" tone="neutral" />
        <EngBadge label={`language: ${chain.language}`} tone="neutral" />
        <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
          {draft.length} step{draft.length === 1 ? '' : 's'}
        </span>
        {dirty && (
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={saving || problem !== null}
            className="ds-btn-primary ml-auto inline-flex items-center gap-1.5 text-[11px]"
          >
            {saving ? <EngSpinner className="h-3 w-3" /> : <Save className="h-3 w-3" />}
            Save changes
          </button>
        )}
      </div>
      {problem && (
        <p className="m-0 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
          {problem}
        </p>
      )}

      {draft.map((letter, i) => (
        <div
          key={i}
          className="rounded-md p-3 flex flex-col gap-2"
          style={{ border: '1px solid var(--cp-divider)' }}
        >
          <div className="flex items-center gap-2">
            <span className="ds-mono text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
              Step {i + 1}
            </span>
            {i > 0 && (
              <label className="ml-auto inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                wait
                {/* Пустое поле — NaN, а не Number('') = 0: пустоту редактор
                    отказывается сохранять (problem выше), а не шлёт нулём. */}
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={typeof letter.wait_days === 'number' && Number.isFinite(letter.wait_days) ? letter.wait_days : ''}
                  onChange={(e) =>
                    updateLetter(i, { wait_days: e.target.value === '' ? Number.NaN : Number(e.target.value) })
                  }
                  className="ds-input w-16 text-[11px] ds-mono"
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
            className="ds-input w-full text-xs"
          />
          <textarea
            value={letter.body}
            onChange={(e) => updateLetter(i, { body: e.target.value })}
            rows={6}
            className="ds-input w-full text-xs resize-y"
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
  // Вертикали, у которых шаблон уже написан (любой статус: строка шаблона есть
  // только у написанных писем) — их черновик на шаблон больше не влияет.
  const templatedVerticals = useMemo(
    () => new Set((detail.templates ?? []).map((t) => t.vertical_id)),
    [detail],
  );

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
        return (
          <EngCard key={v.id}>
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 shrink-0" style={{ color: 'var(--cp-text-l)' }} />
              <h4 className="text-sm font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
                {v.name}
              </h4>
              {activeJob && (
                <span className="ml-auto inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
                  <EngSpinner className="h-3 w-3" /> generation in progress…
                </span>
              )}
            </div>

            {chain ? (
              <ChainEditor
                chain={chain}
                draftNote={engChainDraftText(templatedVerticals.has(v.id), 'letters')}
                onSaved={onChanged}
              />
            ) : (
              !activeJob && (
                <p className="mt-2 text-xs" style={{ color: 'var(--cp-text-l)' }}>
                  No letters yet — the autopilot generates them after «Start outreach» on step 2.
                </p>
              )
            )}
          </EngCard>
        );
      })}
    </div>
  );
}
