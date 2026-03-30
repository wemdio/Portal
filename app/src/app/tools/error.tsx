'use client'

import Link from 'next/link'

export default function ToolsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <div className="w-full max-w-md rounded-xl bg-white p-10 text-center shadow-sm">
        <div className="mb-4 text-5xl">&#128736;</div>
        <h2 className="mb-2 text-lg font-semibold text-zinc-900">Ошибка инструмента</h2>
        <p className="mb-6 text-sm leading-relaxed text-zinc-500">
          Не удалось загрузить инструмент. Попробуйте ещё раз.
        </p>
        {error.digest && (
          <p className="mb-4 font-mono text-xs text-zinc-400">{error.digest}</p>
        )}
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800"
          >
            Попробовать снова
          </button>
          <Link
            href="/tools"
            className="rounded-lg border border-zinc-200 px-5 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            К инструментам
          </Link>
        </div>
      </div>
    </div>
  )
}
