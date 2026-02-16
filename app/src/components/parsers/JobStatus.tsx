'use client';

import type { ParserJobStatus } from '@/types';
import { AlertCircle, CheckCircle2, Clock, Loader2 } from 'lucide-react';

export function isStoppedByUser(status: ParserJobStatus, errorMessage?: string | null) {
  if (status !== 'failed') return false;
  const msg = (errorMessage ?? '').trim().toLowerCase();
  return msg.includes('остановлено пользователем') || msg === 'остановлено';
}

export function JobStatus({ status, errorMessage }: { status: ParserJobStatus; errorMessage?: string | null }) {
  if (status === 'pending') {
    return (
      <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
        <Clock className="h-3.5 w-3.5 mr-1" />
        Ожидание
      </span>
    );
  }

  if (status === 'running') {
    return (
      <span className="inline-flex items-center rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-800">
        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
        Выполняется
      </span>
    );
  }

  if (status === 'completed') {
    return (
      <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-1 text-xs font-medium text-green-800">
        <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
        Завершено
      </span>
    );
  }

  if (isStoppedByUser(status, errorMessage)) {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
        <AlertCircle className="h-3.5 w-3.5 mr-1" />
        Остановлено
      </span>
    );
  }

  return (
    <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-1 text-xs font-medium text-red-800">
      <AlertCircle className="h-3.5 w-3.5 mr-1" />
      Ошибка
    </span>
  );
}

