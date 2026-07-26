'use client';

/**
 * Просмотр цепочки писем вертикали: шаг, тема, тело, пауза в днях.
 */

import { AlertCircle, Mail } from 'lucide-react';
import type { HeChain } from '@/lib/hypothesisEngine/types';
import { Badge } from './ui';

const LANG_LABEL: Record<string, string> = { ru: 'RU', en: 'EN', pl: 'PL' };

export function ChainView({ chain, error }: { chain: HeChain; error?: string | null }) {
  const failed = chain.status === 'failed';
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-4">
      <div className="mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Mail className="h-4 w-4 text-gray-400" aria-hidden />
          <p className="text-sm font-semibold text-gray-800">Цепочка писем</p>
          <Badge tone="blue">{LANG_LABEL[chain.language] ?? chain.language.toUpperCase()}</Badge>
          {chain.status === 'ready' || chain.status === 'done' ? <Badge tone="emerald">Готово</Badge> : null}
          {failed ? <Badge tone="red">Ошибка</Badge> : null}
        </div>
        <p className="mt-1 text-xs text-gray-400">
          Мастер-черновик цепочки под вертикаль. В рассылку не идёт — служит основой для боевого
          шаблона под базу.
        </p>
      </div>

      {failed ? (
        <p className="flex items-start gap-2 text-sm text-red-600" role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {error || 'Генерация цепочки завершилась ошибкой. Попробуйте запустить ещё раз.'}
        </p>
      ) : chain.letters.length === 0 ? (
        <p className="text-xs text-gray-400">Писем пока нет.</p>
      ) : (
        <ol className="space-y-3">
          {chain.letters.map((letter, idx) => (
            <li key={idx} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 text-[11px] font-bold text-blue-700">
                  {idx + 1}
                </span>
                {letter.subject ? (
                  <p className="text-sm font-semibold text-gray-900">{letter.subject}</p>
                ) : (
                  <p className="text-sm italic text-gray-400">Без темы</p>
                )}
                {letter.wait_days > 0 ? (
                  <span className="text-[11px] text-gray-400">пауза {letter.wait_days} дн.</span>
                ) : null}
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{letter.body}</p>
              {letter.variants && letter.variants.length > 0 ? (
                <details className="group mt-2">
                  <summary className="cursor-pointer list-none text-xs font-medium text-gray-500 hover:text-gray-700">
                    Варианты ({letter.variants.length})
                  </summary>
                  <div className="mt-2 space-y-2 border-l-2 border-gray-100 pl-3">
                    {letter.variants.map((v, vi) => (
                      <p key={vi} className="whitespace-pre-wrap text-xs leading-relaxed text-gray-500">
                        {v}
                      </p>
                    ))}
                  </div>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
