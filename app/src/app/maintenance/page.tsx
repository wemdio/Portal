import Link from 'next/link'

export default function MaintenancePage() {
  return (
    <section className="relative min-h-screen overflow-hidden bg-slate-950 text-slate-100">
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            'radial-gradient(circle at 20% 20%, rgba(56, 189, 248, 0.20), transparent 40%), radial-gradient(circle at 80% 15%, rgba(129, 140, 248, 0.18), transparent 35%), radial-gradient(circle at 50% 100%, rgba(14, 165, 233, 0.12), transparent 42%)',
        }}
      />
      <div className="relative mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6 py-16 text-center">
        <div className="mb-8 inline-flex h-16 w-16 items-center justify-center rounded-2xl border border-cyan-300/30 bg-cyan-400/10 shadow-[0_0_40px_rgba(34,211,238,0.2)]">
          <span className="text-3xl">⚙️</span>
        </div>
        <p className="mb-3 inline-flex rounded-full border border-cyan-300/30 bg-cyan-400/10 px-4 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200">
          Technical update
        </p>
        <h1 className="max-w-2xl text-4xl font-semibold leading-tight tracking-tight text-white md:text-5xl">
          Мы выкатываем обновление портала
        </h1>
        <p className="mt-6 max-w-xl text-base leading-relaxed text-slate-300 md:text-lg">
          Сейчас команда добавляет новые фичи и фиксит баги. Портал скоро снова будет доступен.
          Спасибо за терпение.
        </p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/"
            className="rounded-xl border border-cyan-200/50 bg-cyan-300/90 px-5 py-2 text-sm font-semibold text-slate-900 transition hover:bg-cyan-200"
          >
            Обновить страницу
          </Link>
          <span className="rounded-xl border border-slate-700 bg-slate-900/60 px-5 py-2 text-sm text-slate-300">
            Обычно это занимает 2-5 минут
          </span>
        </div>
      </div>
    </section>
  )
}
