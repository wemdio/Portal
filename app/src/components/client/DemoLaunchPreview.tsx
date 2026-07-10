'use client';

/**
 * Read-only "example launch" shown ONLY in the demo portal (is_demo) above the
 * real launch wizard. A prospect lands on /client/launch and, instead of an
 * empty form they can't submit, sees end-to-end what a configured campaign looks
 * like: base + mapping, the 2-step sequence (same copy as the demo campaigns),
 * schedule/sending settings, and a launch button that invites registration.
 * Self-contained markup (client theme tokens) — does NOT touch the wizard logic.
 */
import { Upload, Mail, Clock, Settings, Send, Check, Info } from 'lucide-react';
import { promptDemoRegister } from '@/lib/clientDemo/registerPrompt';
import { DemoLetterCard, type DemoLetter } from '@/components/client/DemoLetterCard';

// Полные тексты — те же, что в цепочке демо-кампании «Орбита — розничные сети»
// (fixtures DEMO_SEQUENCES), чтобы демо было связным. Карточка сворачивает их
// до темы + первой строки, «Развернуть письмо» раскрывает целиком.
const PREVIEW_STEPS: DemoLetter[] = [
  {
    when: 'сразу',
    subject: 'Сократили пересорт на складе на 30%',
    body:
      'Здравствуйте, {{firstName}}!\n\n' +
      'У сетей с несколькими складами почти всегда болит пересорт и долгая инвентаризация — склад встаёт на 1–2 дня.\n\n' +
      'Мы, Орбита, — облачная WMS. Рознице «ТоргДом» с 12 складами помогли сократить потери на пересорте с 15% до 5% за 3 месяца, без замены 1С и без остановки операций.\n\n' +
      'Откликается тема? Пришлю короткий расчёт под ваш профиль.',
  },
  {
    when: 'через 3 дня',
    subject: 'Инвентаризация 6 складов — за 4 часа вместо 2 дней',
    body:
      'Добрый день, {{firstName}}!\n\n' +
      'Возвращаюсь к прошлому письму с конкретикой: у «ТоргДома» инвентаризация 6 складов теперь занимает 4 часа вместо двух дней — за счёт онлайн-остатков и ТСД.\n\n' +
      'Покажу на 15-минутном демо, как это выглядит у вас. Когда удобно?',
  },
];

const MAPPING = ['Email', 'Имя', 'Фамилия', 'Компания'];
const SETTINGS = ['Трекинг открытий', 'Трекинг ссылок', 'Стоп при ответе', 'Только текст'];

const chipStyle = {
  color: 'var(--cp-paper-mute)',
  background: 'rgba(255,255,255,0.05)',
} as const;

export function DemoLaunchPreview() {
  return (
    <div className="neu-sm p-4 sm:p-6 mb-5 sm:mb-6">
      <div className="flex items-center gap-2 mb-1">
        <Info size={16} style={{ color: 'var(--cp-paper-faint)' }} />
        <p className="ds-eyebrow m-0">Пример настроенной кампании</p>
      </div>
      <p className="text-xs sm:text-sm mb-5" style={{ color: 'var(--cp-paper-mute)' }}>
        Так выглядит запуск целиком. В демо — только просмотр; в рабочем аккаунте всё это в один экран.
      </p>

      <div className="space-y-5">
        <section>
          <div className="flex items-center gap-2 mb-2">
            <Upload size={14} style={{ color: 'var(--cp-paper-mute)' }} />
            <span className="text-xs sm:text-sm font-semibold" style={{ color: 'var(--cp-paper)' }}>
              База контактов
            </span>
          </div>
          <p className="text-xs sm:text-sm m-0" style={{ color: 'var(--cp-paper-mute)' }}>
            <span className="ds-mono">retail_base_cleaned.csv</span> · 248 контактов загружено, 2 пропущено (невалидный email)
          </p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {MAPPING.map((m) => (
              <span key={m} className="ds-mono text-[10px] px-2 py-1 rounded" style={chipStyle}>
                {m}
              </span>
            ))}
          </div>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-2">
            <Mail size={14} style={{ color: 'var(--cp-paper-mute)' }} />
            <span className="text-xs sm:text-sm font-semibold" style={{ color: 'var(--cp-paper)' }}>
              Цепочка писем
            </span>
          </div>
          <div className="space-y-2">
            {PREVIEW_STEPS.map((s, i) => (
              <DemoLetterCard key={i} letter={s} index={i} idPrefix="launch-preview" />
            ))}
          </div>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-2">
            <Clock size={14} style={{ color: 'var(--cp-paper-mute)' }} />
            <span className="text-xs sm:text-sm font-semibold" style={{ color: 'var(--cp-paper)' }}>
              Расписание и отправка
            </span>
          </div>
          <p className="text-xs sm:text-sm m-0" style={{ color: 'var(--cp-paper-mute)' }}>
            Пн–Пт · 09:00–18:00 (Москва) · 12 мин между письмами · до 120 писем/день · 2 ящика-отправителя
          </p>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-2">
            <Settings size={14} style={{ color: 'var(--cp-paper-mute)' }} />
            <span className="text-xs sm:text-sm font-semibold" style={{ color: 'var(--cp-paper)' }}>
              Настройки
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SETTINGS.map((s) => (
              <span key={s} className="text-[10px] sm:text-xs px-2 py-1 rounded inline-flex items-center gap-1" style={chipStyle}>
                <Check size={11} /> {s}
              </span>
            ))}
          </div>
        </section>
      </div>

      <div className="mt-5 flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => promptDemoRegister('запустить кампанию')}
          className="neu-pill inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold"
          style={{ background: 'var(--cp-amber)', color: 'var(--cp-ink)' }}
        >
          <Send size={15} /> Запустить кампанию
        </button>
        <span className="text-xs" style={{ color: 'var(--cp-paper-faint)' }}>
          В демо — только просмотр. Регистрация откроет запуск.
        </span>
      </div>
    </div>
  );
}
