import { Check, Sparkle, Crown, Headset, Users, Database, Link2, Mail, Zap } from 'lucide-react';
import { TARIFF_DEFAULTS, TARIFF_LABELS_RU } from '@/lib/tariffs';

const S = TARIFF_DEFAULTS.standard;
const P = TARIFF_DEFAULTS.pro;

function fmt(n: number) {
  return n.toLocaleString('ru-RU');
}

const tiers = [
  {
    id: 'standard',
    name: TARIFF_LABELS_RU.standard,
    price: '40 000',
    period: '/ мес',
    description: 'Для старта аутрич-кампаний и работы с базами',
    accent: 'blue',
    features: [
      { icon: Users, label: 'Контакты Instantly', value: fmt(S.max_contacts) },
      { icon: Database, label: 'Строки для сбора + конструктор баз', value: fmt(S.max_rows) },
      { icon: Zap, label: 'Генерация цепочек', value: `${S.max_chains_per_month} / мес` },
      { icon: Link2, label: 'Домены', value: String(S.max_domains) },
      { icon: Mail, label: 'Почты', value: String(S.max_emails) },
    ],
  },
  {
    id: 'pro',
    name: TARIFF_LABELS_RU.pro,
    price: '80 000',
    period: '/ мес',
    popular: true,
    description: 'Для масштабирования — все лимиты x2',
    accent: 'violet',
    features: [
      { icon: Users, label: 'Контакты Instantly', value: fmt(P.max_contacts) },
      { icon: Database, label: 'Строки для сбора + конструктор баз', value: fmt(P.max_rows) },
      { icon: Zap, label: 'Генерация цепочек', value: `${P.max_chains_per_month} / мес` },
      { icon: Link2, label: 'Домены', value: String(P.max_domains) },
      { icon: Mail, label: 'Почты', value: String(P.max_emails) },
    ],
  },
  {
    id: 'custom',
    name: TARIFF_LABELS_RU.custom,
    price: null,
    description: 'Индивидуальные лимиты под ваш объём',
    accent: 'zinc',
    features: [
      { icon: Users, label: 'Контакты Instantly', value: 'По запросу' },
      { icon: Database, label: 'Строки для сбора + конструктор баз', value: 'По запросу' },
      { icon: Zap, label: 'Генерация цепочек', value: 'По запросу' },
      { icon: Link2, label: 'Домены', value: 'По запросу' },
      { icon: Mail, label: 'Почты', value: 'По запросу' },
    ],
  },
] as const;

function accentClasses(accent: string, element: 'card' | 'badge' | 'icon' | 'value' | 'btn') {
  const map: Record<string, Record<string, string>> = {
    blue: {
      card: 'border-blue-200/60 hover:border-blue-300',
      badge: 'bg-blue-50 text-blue-600 ring-1 ring-blue-200/50',
      icon: 'text-blue-500',
      value: 'text-blue-700',
      btn: 'bg-zinc-900 text-white hover:bg-zinc-800',
    },
    violet: {
      card: 'border-violet-300/60 hover:border-violet-400 ring-1 ring-violet-200/40',
      badge: 'bg-violet-50 text-violet-600 ring-1 ring-violet-200/50',
      icon: 'text-violet-500',
      value: 'text-violet-700',
      btn: 'bg-violet-600 text-white hover:bg-violet-700 shadow-lg shadow-violet-200/50',
    },
    zinc: {
      card: 'border-zinc-200/80 hover:border-zinc-300',
      badge: 'bg-zinc-100 text-zinc-600 ring-1 ring-zinc-200/50',
      icon: 'text-zinc-400',
      value: 'text-zinc-700',
      btn: 'bg-white text-zinc-800 ring-1 ring-zinc-200 hover:bg-zinc-50',
    },
  };
  return map[accent]?.[element] ?? '';
}

export default function TariffsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 pb-16">
      <header className="text-center mb-10">
        <div className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-3 py-1 text-[11px] font-semibold text-violet-600 ring-1 ring-violet-200/50 mb-4">
          <Sparkle className="h-3 w-3" />
          Тарифы и лимиты
        </div>
        <h1 className="text-3xl font-extrabold tracking-tight text-zinc-900">
          Выберите подходящий план
        </h1>
        <p className="mt-3 text-sm text-zinc-500 max-w-lg mx-auto leading-relaxed">
          Каждый тариф включает полный доступ к инструментам портала.
          Разница — в объёме контактов, доменов и генераций.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-3 items-start">
        {tiers.map((tier) => (
          <article
            key={tier.id}
            className={`
              relative rounded-2xl border bg-white p-6 transition-all duration-200
              hover:shadow-lg hover:-translate-y-0.5
              ${accentClasses(tier.accent, 'card')}
              ${'popular' in tier && tier.popular ? 'lg:scale-[1.03] shadow-md' : 'shadow-sm'}
            `}
          >
            {'popular' in tier && tier.popular && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                <span className="inline-flex items-center gap-1 rounded-full bg-violet-600 px-3 py-1 text-[10px] font-bold text-white shadow-md shadow-violet-300/40 uppercase tracking-wider">
                  <Crown className="h-3 w-3" />
                  Популярный
                </span>
              </div>
            )}

            <div className={'popular' in tier && tier.popular ? 'mt-2' : ''}>
              <div className="flex items-center gap-2 mb-3">
                <span className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] font-semibold ${accentClasses(tier.accent, 'badge')}`}>
                  {tier.name}
                </span>
              </div>

              {tier.price ? (
                <div className="flex items-baseline gap-1 mb-1">
                  <span className="text-3xl font-extrabold tracking-tight text-zinc-900">
                    {tier.price}
                  </span>
                  <span className="text-sm font-medium text-zinc-400">₽{tier.period}</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 mb-1">
                  <Headset className="h-5 w-5 text-zinc-400" />
                  <span className="text-lg font-bold text-zinc-700">По запросу</span>
                </div>
              )}

              <p className="text-[13px] text-zinc-500 mb-5 leading-relaxed">{tier.description}</p>
            </div>

            <div className="space-y-0 rounded-xl border border-zinc-100 bg-zinc-50/50 overflow-hidden">
              {tier.features.map((feat, i) => (
                <div
                  key={feat.label}
                  className={`flex items-center gap-3 px-3.5 py-2.5 ${
                    i !== tier.features.length - 1 ? 'border-b border-zinc-100' : ''
                  }`}
                >
                  <feat.icon className={`h-4 w-4 flex-shrink-0 ${accentClasses(tier.accent, 'icon')}`} />
                  <span className="flex-1 text-[12.5px] text-zinc-600">{feat.label}</span>
                  <span className={`text-[13px] font-semibold tabular-nums ${accentClasses(tier.accent, 'value')}`}>
                    {feat.value}
                  </span>
                </div>
              ))}
            </div>

            <div className="mt-5 space-y-2.5">
              <button
                type="button"
                className={`
                  w-full rounded-xl px-4 py-2.5 text-[13px] font-semibold transition-all duration-150
                  ${accentClasses(tier.accent, 'btn')}
                `}
              >
                {tier.price ? 'Подключить' : 'Связаться'}
              </button>
            </div>

            {tier.price && (
              <ul className="mt-5 space-y-1.5">
                {[
                  'Все инструменты портала',
                  'Конструктор баз для чистки',
                  'Поддержка команды',
                ].map((line) => (
                  <li key={line} className="flex items-center gap-2 text-[12px] text-zinc-500">
                    <Check className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />
                    {line}
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </div>

      <section className="mt-12 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-bold text-zinc-900 mb-4">Сравнение тарифов</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-zinc-100">
                <th className="py-2.5 pr-4 text-left font-medium text-zinc-500 w-[200px]">Лимит</th>
                <th className="py-2.5 px-4 text-center font-medium text-blue-600">{TARIFF_LABELS_RU.standard}</th>
                <th className="py-2.5 px-4 text-center font-medium text-violet-600">{TARIFF_LABELS_RU.pro}</th>
                <th className="py-2.5 px-4 text-center font-medium text-zinc-500">{TARIFF_LABELS_RU.custom}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50">
              {[
                { label: 'Контакты Instantly', std: fmt(S.max_contacts), pro: fmt(P.max_contacts) },
                { label: 'Строки для сбора', std: fmt(S.max_rows), pro: fmt(P.max_rows) },
                { label: 'Генерация цепочек / мес', std: String(S.max_chains_per_month), pro: String(P.max_chains_per_month) },
                { label: 'Домены', std: String(S.max_domains), pro: String(P.max_domains) },
                { label: 'Почты', std: String(S.max_emails), pro: String(P.max_emails) },
                { label: 'Конструктор баз', std: '\u2713', pro: '\u2713' },
                { label: 'Все инструменты', std: '\u2713', pro: '\u2713' },
              ].map((row) => (
                <tr key={row.label} className="hover:bg-zinc-50/50 transition-colors">
                  <td className="py-2.5 pr-4 text-zinc-700 font-medium">{row.label}</td>
                  <td className="py-2.5 px-4 text-center tabular-nums text-zinc-800 font-semibold">{row.std}</td>
                  <td className="py-2.5 px-4 text-center tabular-nums text-violet-700 font-semibold">{row.pro}</td>
                  <td className="py-2.5 px-4 text-center text-zinc-400">Под вас</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
