'use client';

import { Mail } from 'lucide-react';
import { companyEmailStatusLabel, extraCompanyEmails } from '@/lib/outreachEmail/companyEmails';
import type { OutreachLetterView, OutreachRowTone } from './types';

const TONE_BADGE: Record<OutreachRowTone, string> = {
  ready: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  excluded: 'border-gray-200 bg-gray-100 text-gray-500',
  review: 'border-amber-200 bg-amber-50 text-amber-800',
  doubtful: 'border-orange-200 bg-orange-50 text-orange-800',
  failed: 'border-red-200 bg-red-50 text-red-700',
  processing: 'border-blue-200 bg-blue-50 text-blue-700',
};

export const TONE_ROW: Partial<Record<OutreachRowTone, string>> = {
  ready: 'bg-emerald-50/40',
  excluded: 'opacity-60',
  failed: 'bg-red-50/40',
};

export function StatusBadge({ tone, label }: { tone: OutreachRowTone; label: string }) {
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_BADGE[tone]}`}>
      {label}
    </span>
  );
}

/**
 * Почта компании: главный адрес и остальные (до трёх адресов со статусом OK,
 * с 29.09.2026) — каждый со своим статусом проверки.
 */
export function EmailsCell({ primary, verification, emails }: { primary: string | null; verification: string | null; emails: unknown }) {
  if (!primary) return <span className="text-gray-400">—</span>;
  const items = [{ email: primary, verification }, ...extraCompanyEmails(emails, primary)];
  return (
    <div className="flex max-w-[220px] flex-col gap-0.5">
      {items.map((item) => {
        const status = companyEmailStatusLabel(item.verification);
        return (
          <span key={item.email} className="inline-flex items-center gap-1 truncate text-gray-700" title={status ? `${item.email} — ${status}` : item.email}>
            <Mail className="h-3 w-3 shrink-0 text-gray-400" />
            <span className="truncate">{item.email}</span>
            {status && items.length > 1 ? <span className="shrink-0 text-[11px] text-gray-400">{status}</span> : null}
          </span>
        );
      })}
    </div>
  );
}

export function LettersBlock({ letters, subjectB }: { letters: OutreachLetterView[]; subjectB?: string | null }) {
  if (!letters.length) {
    return <div className="text-sm text-gray-400">Письма не собирались.</div>;
  }
  return (
    <div className="space-y-3">
      {letters.map((letter) => (
        <div key={letter.n} className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[11px] font-semibold text-violet-800">
              Письмо {letter.n}
            </span>
            {/* С 26.09.2026 тема только у письма 1: остальные уходят ответом в ту же ветку. */}
            {letter.subject ? (
              <span className="text-sm font-medium text-gray-800">{letter.subject}</span>
            ) : (
              <span className="text-xs text-gray-400">ответ в той же ветке</span>
            )}
            {letter.n === 1 && subjectB ? (
              <span className="text-xs text-gray-500">
                вариант Б: <span className="text-gray-800">{subjectB}</span>
              </span>
            ) : null}
          </div>
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-gray-700">{letter.body}</pre>
          {/* Среди адресов компании есть и личный, и общий ящик — второй вариант письма 1. */}
          {letter.alt_body ? (
            <div className="mt-3 border-t border-gray-200 pt-3">
              <div className="mb-1 text-xs font-medium text-gray-500">
                {letter.alt_routing ? 'Вариант для общего ящика' : 'Вариант для личного адреса'}
              </div>
              <pre className="whitespace-pre-wrap break-words font-sans text-sm text-gray-700">{letter.alt_body}</pre>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Синяя плашка доказательств — цитаты дословно из источника. */
export function EvidenceCard({ title, items }: { title: string; items: Array<{ label: string; quote: string }> }) {
  if (!items.length) return null;
  return (
    <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-blue-800">{title}</div>
      {items.map((item, i) => (
        <div key={i} className={i < items.length - 1 ? 'mb-2' : ''}>
          <div className="text-[11px] font-medium text-blue-700">{item.label}</div>
          <blockquote className="border-l-2 border-blue-300 pl-3 text-sm italic text-gray-700">«{item.quote}»</blockquote>
        </div>
      ))}
    </div>
  );
}

/** Сиреневая плашка оценки — почему компании пишем именно так. */
export function ScoreCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-violet-100 bg-violet-50/50 p-4 text-sm text-gray-800">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-violet-800">{title}</div>
      {children}
    </div>
  );
}

export function Chip({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return <span className={`rounded-full bg-white px-2 py-0.5 ${muted ? 'text-gray-500' : 'text-gray-700'}`}>{children}</span>;
}
