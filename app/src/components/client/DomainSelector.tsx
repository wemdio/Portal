'use client';

/**
 * Inline domain picker for the onboarding checklist "domains" step.
 *
 * Rendered INSIDE the checklist card (no dedicated page): the step row
 * expands in place when it is the next action, and collapses to a compact
 * confirmed list once the client has picked their N domains.
 *
 * Flow: GET /api/client/domains/suggestions → (brand from the brief website
 * or manual input) → checkboxes capped at required_count → PUT
 * /api/client/domains/selection. The manager then buys and configures the
 * domains manually — nothing is purchased here.
 */

import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, RefreshCw } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';
import { mergePickedDomains } from '@/lib/clientDomains/mergePicks';

interface SuggestedDomain {
  domain: string;
  tld: string;
  available: boolean;
  checked_at: string;
}

interface DomainsState {
  brand: string | null;
  suggested: SuggestedDomain[];
  selected: string[];
  required_count: number;
  status: string;
}

const TLD_ORDER = ['ru', 'online', 'tech', 'site'];

function tldRank(tld: string): number {
  const idx = TLD_ORDER.indexOf(tld);
  return idx === -1 ? TLD_ORDER.length : idx;
}

function normalizeState(raw: DomainsState): DomainsState {
  return {
    brand: raw.brand ?? null,
    suggested: Array.isArray(raw.suggested) ? raw.suggested : [],
    selected: Array.isArray(raw.selected) ? raw.selected : [],
    required_count: Number(raw.required_count) || 0,
    status: raw.status ?? 'suggested',
  };
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function DomainSelector({
  done,
  onChanged,
}: {
  done: boolean;
  onChanged?: () => void;
}) {
  const [state, setState] = useState<DomainsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [brandInput, setBrandInput] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await clientApiFetch<DomainsState>('/domains/suggestions');
      const next = normalizeState(res);
      setState(next);
      setPicked(new Set(next.selected));
    } catch (err) {
      setError(errorMessage(err, 'Не удалось загрузить варианты доменов.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const regenerate = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await clientApiFetch<DomainsState>('/domains/suggestions', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const next = normalizeState(res);
        setState(next);
        // Мержим, а не заменяем: локальные (ещё не подтверждённые) галочки
        // переживают «Показать ещё варианты», если домен есть в новой
        // подборке и свободен.
        setPicked((prev) => mergePickedDomains(prev, next.selected, next.suggested));
      } catch (err) {
        setError(errorMessage(err, 'Не удалось подобрать домены. Попробуйте ещё раз.'));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const confirm = useCallback(async () => {
    if (!state) return;
    setBusy(true);
    setError(null);
    try {
      const res = await clientApiFetch<DomainsState>('/domains/selection', {
        method: 'PUT',
        body: JSON.stringify({ selected: [...picked] }),
      });
      const next = normalizeState(res);
      setState(next);
      setPicked(new Set(next.selected));
      setEditing(false);
      onChanged?.();
    } catch (err) {
      setError(errorMessage(err, 'Не удалось сохранить выбор. Попробуйте ещё раз.'));
    } finally {
      setBusy(false);
    }
  }, [state, picked, onChanged]);

  if (loading && !state) {
    return (
      <div className="flex items-center gap-2 mt-3">
        <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: 'var(--cp-text-l)' }} />
        <p className="text-xs" style={{ color: 'var(--cp-text-m)' }}>
          Подбираем свободные домены…
        </p>
      </div>
    );
  }

  if (error && !state) {
    return (
      <div className="mt-3 flex items-center gap-2" role="alert">
        <p className="text-xs flex-1" style={{ color: 'var(--cp-danger)' }}>
          {error}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="neu-pill inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold"
          style={{ color: 'var(--cp-text)' }}
        >
          <RefreshCw className="h-3 w-3" aria-hidden />
          Повторить
        </button>
      </div>
    );
  }

  if (!state) return null;

  const required = state.required_count;
  const isConfirmed =
    state.status === 'selected' && state.selected.length === required && required > 0;

  // ── Нет бренда: в брифе нет сайта — просим ввести вручную ────────────
  if (!state.brand) {
    return (
      <div className="mt-3">
        <label
          htmlFor="domain-brand-input"
          className="block text-xs font-semibold mb-1.5"
          style={{ color: 'var(--cp-text-m)' }}
        >
          Домен вашего сайта или название компании (латиницей)
        </label>
        <div className="flex items-center gap-2">
          <input
            id="domain-brand-input"
            type="text"
            value={brandInput}
            onChange={(e) => setBrandInput(e.target.value)}
            placeholder="mycompany"
            disabled={busy}
            className="neu-inset rounded-xl px-3 py-2 text-sm flex-1 min-w-0"
            style={{ color: 'var(--cp-text)' }}
          />
          <button
            type="button"
            disabled={busy || !brandInput.trim()}
            onClick={() => void regenerate({ brand: brandInput.trim() })}
            className="neu-pill inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold shrink-0"
            style={{ color: 'var(--cp-accent)' }}
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
            Подобрать домены
          </button>
        </div>
        {error && (
          <p className="text-xs mt-2" style={{ color: 'var(--cp-danger)' }} role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  // ── Подтверждённый выбор: компактный список + «Изменить выбор» ───────
  if (isConfirmed && !editing) {
    return (
      <div className="mt-3">
        <div className="flex flex-wrap gap-1.5">
          {state.selected.map((domain) => (
            <span
              key={domain}
              className="neu-pill inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold ds-mono"
              style={{ color: 'var(--cp-text)' }}
            >
              <Check className="h-3 w-3" style={{ color: 'var(--cp-success, #4ade80)' }} aria-hidden />
              {domain}
            </span>
          ))}
        </div>
        <p className="text-[11px] mt-2" style={{ color: 'var(--cp-text-m)' }}>
          Менеджер уведомлён — он купит и настроит эти домены для ваших почтовых ящиков.
        </p>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="neu-pill inline-flex items-center gap-1.5 px-3 py-1 mt-2 text-xs font-semibold"
          style={{ color: 'var(--cp-text)' }}
        >
          Изменить выбор
        </button>
      </div>
    );
  }

  // ── Режим выбора: чекбоксы по предложенным вариантам ─────────────────
  const sorted = [...state.suggested].sort((a, b) => tldRank(a.tld) - tldRank(b.tld));

  const toggle = (domain: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) {
        next.delete(domain);
      } else if (next.size < required) {
        next.add(domain);
      }
      return next;
    });
  };

  return (
    <div className="mt-3">
      <p className="text-[11px] mb-2" style={{ color: 'var(--cp-text-m)' }}>
        Менеджер купит и настроит эти домены для ваших почтовых ящиков. Рекомендуем
        взять побольше .ru — они стабильнее и дешевле.
      </p>

      {sorted.length === 0 ? (
        <p className="text-xs mb-2" style={{ color: 'var(--cp-text-m)' }}>
          Свободных вариантов в этой подборке не нашлось — попробуйте ещё.
        </p>
      ) : (
        <div className="space-y-1.5 mb-3">
          {sorted.map((s) => {
            const isPicked = picked.has(s.domain);
            const capped = !isPicked && picked.size >= required;
            return (
              <label
                key={s.domain}
                className={`neu-row flex items-center gap-2.5 px-3 py-2 rounded-xl ${
                  capped ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                }`}
              >
                <input
                  type="checkbox"
                  checked={isPicked}
                  disabled={capped || busy}
                  onChange={() => toggle(s.domain)}
                  className="shrink-0"
                />
                <span
                  className="neu-pill px-1.5 py-0.5 text-[10px] font-bold shrink-0 ds-mono"
                  style={{ color: s.tld === 'ru' ? 'var(--cp-accent)' : 'var(--cp-text-l)' }}
                >
                  .{s.tld}
                </span>
                <span className="text-sm ds-mono truncate" style={{ color: 'var(--cp-text)' }}>
                  {s.domain}
                </span>
                <span className="text-[10px] ml-auto shrink-0" style={{ color: 'var(--cp-success, #4ade80)' }}>
                  свободен
                </span>
              </label>
            );
          })}
        </div>
      )}

      {error && (
        <p className="text-xs mb-2" style={{ color: 'var(--cp-danger)' }} role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold" style={{ color: 'var(--cp-text-m)' }}>
          Выбрано {picked.size} из {required}
        </span>
        <button
          type="button"
          disabled={busy || picked.size !== required}
          onClick={() => void confirm()}
          className="neu-pill inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold"
          style={{ color: picked.size === required ? 'var(--cp-amber)' : 'var(--cp-text-l)' }}
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
          Подтвердить выбор
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const nextOffset = offset + 1;
            setOffset(nextOffset);
            void regenerate({ brand: state.brand, offset: nextOffset });
          }}
          className="neu-pill inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold"
          style={{ color: 'var(--cp-text)' }}
        >
          Показать ещё варианты
        </button>
      </div>
      {done && (
        <p className="text-[11px] mt-2" style={{ color: 'var(--cp-text-m)' }}>
          После подтверждения менеджер получит уведомление.
        </p>
      )}
    </div>
  );
}
