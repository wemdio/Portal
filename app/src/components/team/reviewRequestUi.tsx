import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import type { TeamReviewRequestState } from './teamApi';

export const REVIEW_REQUEST_STATE_META: Record<
  TeamReviewRequestState,
  { heading: string; label: string; dot: string }
> = {
  new: { heading: 'Новые', label: 'Новый', dot: 'bg-blue-500' },
  in_progress: { heading: 'В работе', label: 'В работе', dot: 'bg-amber-500' },
  converted: { heading: 'Ревью запланировано', label: 'Ревью запланировано', dot: 'bg-emerald-500' },
  declined: { heading: 'Не требуется', label: 'Не требуется', dot: 'bg-gray-400' },
};

export const REVIEW_REQUEST_STATES: readonly TeamReviewRequestState[] = [
  'new',
  'in_progress',
  'converted',
  'declined',
];

export function reviewRequestNewCountLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} новый`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} новых`;
  return `${count} новых`;
}

export function ReviewRequestExamples({ value }: { value: string }) {
  const links = Array.from(value.matchAll(/https?:\/\/[^\s,]+/gi))
    .map((match) => match[0].replace(/[.;!?)]*$/, ''))
    .filter(Boolean);

  if (!links.length) return <p className="whitespace-pre-wrap break-words text-gray-800">{value}</p>;

  return (
    <div className="min-w-0 space-y-2">
      <p className="whitespace-pre-wrap break-words text-gray-800">{value}</p>
      <div className="flex min-w-0 flex-col items-start gap-2">
        {links.map((href, index) => (
          <a
            key={`${href}-${index}`}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-full items-center gap-1 break-all font-medium text-gray-900 underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Открыть обсуждение {links.length > 1 ? index + 1 : ''}
            <ExternalLink aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          </a>
        ))}
      </div>
    </div>
  );
}

export function ReviewRequestDetail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <div className="mt-1 break-words text-sm text-gray-800">{children}</div>
    </div>
  );
}
