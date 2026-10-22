import { AlertCircle } from 'lucide-react';
import type { ReplyFailure } from '@/lib/tgOutreach/types';

export function ReplyFailureIndicator({ failure }: { failure: ReplyFailure }) {
  const label = failure.delivery === 'unknown' ? 'Отправка не подтверждена' : 'Ответ не отправлен';
  const tooltip = `${label}. Причина: ${failure.reason}${failure.retrying ? '\nВыполняется повторная генерация.' : ''}`;
  return (
    <span title={tooltip} aria-label={tooltip} role="img" tabIndex={0}
      className="inline-flex shrink-0 cursor-help rounded text-red-600 focus-visible:outline-2 focus-visible:outline-red-500">
      <AlertCircle className="h-4 w-4" aria-hidden />
    </span>
  );
}

export function FailedReplyBubble({ failure }: { failure: ReplyFailure }) {
  const label = failure.delivery === 'unknown' ? 'Отправка не подтверждена' : 'Ответ не отправлен';
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-gray-800">
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 font-semibold text-red-700">
          {label}{failure.retrying ? ' · перегенерация…' : ''}
        </div>
        <div className="whitespace-pre-wrap break-words">{failure.text || 'Текст ответа не сформирован'}</div>
      </div>
      <ReplyFailureIndicator failure={failure} />
    </div>
  );
}
