'use client';

import { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import type { ClientBriefFields } from '@/lib/clientBrief/types';
import { BRIEF_SECTIONS, briefSectionsFilled, briefFilledCount } from '@/lib/clientBrief/sectionProgress';

interface BriefSectionNavProps {
  fields: ClientBriefFields;
  savedAt: string | null;
  saving: boolean;
  clearing: boolean;
  onSave: () => void;
  onClear: () => void;
}

const TOTAL = BRIEF_SECTIONS.length;
// Кольцо прогресса.
const R = 26;
const CIRC = 2 * Math.PI * R;

/**
 * Правый липкий навигатор брифа: кольцо прогресса + карта из 7 разделов со
 * скролл-спаем (активный раздел подсвечивается) и плавным переходом по клику.
 * Рендерится только на xl+ (на мобилке навигация не нужна, сейв — нижним баром).
 */
export function BriefSectionNav({ fields, savedAt, saving, clearing, onSave, onClear }: BriefSectionNavProps) {
  const filledMap = briefSectionsFilled(fields);
  const filled = briefFilledCount(fields);
  const pct = Math.round((filled / TOTAL) * 100);
  const done = filled === TOTAL;

  const [activeId, setActiveId] = useState<string>(BRIEF_SECTIONS[0]?.anchorId ?? '');

  // Скролл-спай: активен раздел, попавший в верхнюю ленту вьюпорта.
  useEffect(() => {
    const els = BRIEF_SECTIONS
      .map((s) => document.getElementById(s.anchorId))
      .filter((el): el is HTMLElement => el != null);
    if (els.length === 0) return;

    const visible = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        // Активен самый верхний (наименьший номер) из видимых.
        const top = BRIEF_SECTIONS.find((s) => visible.has(s.anchorId));
        if (top) setActiveId(top.anchorId);
      },
      { rootMargin: '-15% 0px -70% 0px', threshold: 0 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const goTo = (anchorId: string) => {
    const el = document.getElementById(anchorId);
    if (!el) return;
    setActiveId(anchorId);
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const offset = CIRC * (1 - filled / TOTAL);

  return (
    <div className="sticky top-4 space-y-4">
      {/* Кольцо прогресса */}
      <div
        className="rounded-xl p-4 flex items-center gap-4"
        style={{ background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)' }}
      >
        <div className="relative shrink-0" style={{ width: 64, height: 64 }}>
          <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
            <circle cx="32" cy="32" r={R} fill="none" stroke="var(--cp-divider)" strokeWidth="5" />
            <circle
              cx="32"
              cy="32"
              r={R}
              fill="none"
              stroke={done ? 'var(--cp-green)' : 'var(--cp-paper)'}
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray={CIRC}
              strokeDashoffset={offset}
              transform="rotate(-90 32 32)"
              style={{ transition: 'stroke-dashoffset 400ms ease, stroke 200ms ease' }}
            />
          </svg>
          <span
            className="absolute inset-0 flex items-center justify-center text-xs font-bold"
            style={{ color: 'var(--cp-paper)' }}
          >
            {pct}%
          </span>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold m-0" style={{ color: 'var(--cp-paper)' }}>
            {done ? 'Бриф заполнен' : 'Заполнение брифа'}
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--cp-paper-mute)' }}>
            {filled} из {TOTAL} разделов заполнено
          </p>
        </div>
      </div>

      {/* Карта разделов */}
      <nav
        aria-label="Разделы брифа"
        className="rounded-xl p-2 overflow-hidden"
        style={{ background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)' }}
      >
        <p className="px-2 pt-1 pb-2 text-[11px] font-semibold tracking-wider uppercase" style={{ color: 'var(--cp-paper-faint)' }}>
          Разделы
        </p>
        <ul className="space-y-0.5 m-0 p-0 list-none">
          {BRIEF_SECTIONS.map((s) => {
            const active = s.anchorId === activeId;
            const isFilled = filledMap[s.num];
            return (
              <li key={s.anchorId}>
                <button
                  type="button"
                  onClick={() => goTo(s.anchorId)}
                  aria-current={active ? 'true' : undefined}
                  className="w-full flex items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors"
                  style={{ background: active ? 'var(--cp-surface-elev)' : 'transparent' }}
                >
                  <span
                    className="shrink-0 inline-flex items-center justify-center rounded-full text-[10px] font-bold"
                    style={{
                      width: 18,
                      height: 18,
                      background: isFilled ? 'var(--cp-green)' : 'var(--cp-surface-elev)',
                      color: isFilled ? '#fff' : 'var(--cp-paper-faint)',
                      border: isFilled ? 'none' : '1px solid var(--cp-divider)',
                    }}
                  >
                    {isFilled ? <Check className="h-3 w-3" aria-hidden /> : String(s.num).padStart(2, '0')}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-sm"
                    style={{ color: active ? 'var(--cp-paper)' : 'var(--cp-paper-mute)', fontWeight: active ? 600 : 400 }}
                  >
                    {s.title}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Действия */}
      <div
        className="rounded-xl p-3 space-y-2"
        style={{ background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider)' }}
      >
        <button
          type="button"
          onClick={onSave}
          disabled={saving || clearing}
          className="ds-btn-primary w-full inline-flex h-10 items-center justify-center gap-2 px-4 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {saving ? 'Сохранение…' : 'Сохранить бриф'}
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={saving || clearing}
          className="w-full inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-sm transition-colors disabled:opacity-50"
          style={{ color: 'var(--cp-paper-mute)', border: '1px solid var(--cp-divider)' }}
        >
          {clearing && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {clearing ? 'Очистка…' : 'Очистить бриф'}
        </button>
        <p className="text-[11px] flex items-center gap-1.5 pt-0.5" style={{ color: 'var(--cp-paper-faint)' }}>
          {savedAt && !saving ? (
            <>
              <Check className="h-3.5 w-3.5" style={{ color: 'var(--cp-green)' }} aria-hidden /> Все поля опциональны · сохранено
            </>
          ) : (
            'Все поля опциональны — можно сохранить как черновик'
          )}
        </p>
      </div>
    </div>
  );
}
