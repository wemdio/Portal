'use client';

/**
 * Read-only «пример готовой цепочки» для демо-портала — страница «Цепочки
 * писем» (/client/sequences). Живой инструмент (EmailSequenceV2View) под демо не
 * рендерится: его tools-API демо-аккаунту недоступен, а проспекту важно другое —
 * увидеть, ЧТО инструмент берёт на входе и ЧТО отдаёт на выходе.
 *
 * Зеркалит три шага мастера: 1) Продукт (бриф → выделенные ценности),
 * 2) Аудитория (кому пишем + пожелания), 3) Письма (итоговая цепочка,
 * каждое письмо разворачивается целиком через DemoLetterCard).
 *
 * Контент консистентен с демо-вселенной «Орбиты»: бриф из fixtures
 * (DEMO_BRIEF_RESPONSE), письма 1–2 — из цепочки кампании «Орбита — розничные
 * сети», третье — финальный заход про бесплатный пилот (из special_offer брифа).
 * НЕ делать третье письмо «прощальным» («это последнее письмо», «ответьте не
 * нужно») — это маркер массового спама, клиент прямо флагал такое как антипаттерн.
 * Паттерн компонента — как DemoLaunchPreview: самодостаточная разметка на cp-токенах.
 */
import { FileText, Users, Mail, Sparkles, Send } from 'lucide-react';
import { promptDemoRegister } from '@/lib/clientDemo/registerPrompt';
import { DemoLetterCard, type DemoLetter } from '@/components/client/DemoLetterCard';

const EXTRACTED_VALUES = [
  'Пересорт: с 15% до 5% за 3 месяца',
  'Инвентаризация: 4 часа вместо 2 дней',
  'Онлайн-остатки + ТСД',
  'Без замены 1С',
  'Внедрение 2–3 недели, без остановки склада',
  'Интеграции Wildberries / Ozon',
];

const CHAIN: DemoLetter[] = [
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
  {
    when: 'через 4 дня',
    subject: 'Пилот на одном складе — без замены 1С',
    body:
      'Здравствуйте, {{firstName}}!\n\n' +
      'Короткая мысль напоследок: менять учёт на всех складах сразу и не нужно. Обычно начинают с бесплатного пилота на одном складе — за 14 дней видно эффект на пересорте и скорости инвентаризации, 1С остаётся как есть.\n\n' +
      'Если интересно прикинуть эффект для вашей сети — 15 минут созвона на этой неделе хватит. Когда удобно?',
  },
];

function StepHeader({ icon, step, title }: { icon: React.ReactNode; step: string; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      {icon}
      <span className="ds-mono text-[10px] shrink-0" style={{ color: 'var(--cp-paper-faint)' }}>
        Шаг {step}
      </span>
      <span className="text-xs sm:text-sm font-semibold" style={{ color: 'var(--cp-paper)' }}>
        {title}
      </span>
    </div>
  );
}

const chipStyle = {
  color: 'var(--cp-paper-mute)',
  background: 'rgba(255,255,255,0.05)',
} as const;

export function DemoSequenceExample() {
  return (
    <div className="neu-sm p-4 sm:p-6">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles size={16} style={{ color: 'var(--cp-paper-faint)' }} />
        <p className="ds-eyebrow m-0">Пример готовой цепочки</p>
      </div>
      <p className="text-xs sm:text-sm mb-5" style={{ color: 'var(--cp-paper-mute)' }}>
        Так инструмент собирает цепочку: бриф на входе → выделенные ценности → аудитория → письма.
        В демо — просмотр; в рабочем аккаунте цепочка пишется по вашему брифу.
      </p>

      <div className="space-y-5">
        <section>
          <StepHeader
            icon={<FileText size={14} style={{ color: 'var(--cp-paper-mute)' }} />}
            step="01"
            title="Продукт — что дали на входе"
          />
          <p className="text-xs sm:text-sm m-0" style={{ color: 'var(--cp-paper-mute)' }}>
            <span className="ds-mono">Источник: бриф из портала.</span> Орбита — облачная WMS для
            управления складом: онлайн-остатки, ТСД, интеграции с 1С и маркетплейсами. Кейсы:
            «ТоргДом» (12 складов), Fulfillment Pro, ПромЗавод.
          </p>
          <p className="text-[11px] mt-2 mb-1 font-semibold" style={{ color: 'var(--cp-paper-faint)' }}>
            Что мы выделили из брифа:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {EXTRACTED_VALUES.map((v) => (
              <span key={v} className="ds-mono text-[10px] px-2 py-1 rounded" style={chipStyle}>
                {v}
              </span>
            ))}
          </div>
        </section>

        <section>
          <StepHeader
            icon={<Users size={14} style={{ color: 'var(--cp-paper-mute)' }} />}
            step="02"
            title="Аудитория — кому пишем"
          />
          <p className="text-xs sm:text-sm m-0" style={{ color: 'var(--cp-paper-mute)' }}>
            Розничные сети с 3+ складами (РФ) · ЛПР: операционный/логистический директор,
            руководитель склада.
          </p>
          <p className="text-xs sm:text-sm mt-1 m-0" style={{ color: 'var(--cp-paper-mute)' }}>
            Пожелания: коротко, деловым тоном, без канцелярита; один CTA — 15-минутное демо.
          </p>
        </section>

        <section>
          <StepHeader
            icon={<Mail size={14} style={{ color: 'var(--cp-paper-mute)' }} />}
            step="03"
            title="Письма — что получилось"
          />
          <div className="space-y-2">
            {CHAIN.map((s, i) => (
              <DemoLetterCard key={i} letter={s} index={i} idPrefix="seq-example" defaultOpen={i === 0} />
            ))}
          </div>
        </section>
      </div>

      <div className="mt-5 flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => promptDemoRegister('написать цепочку под ваш продукт')}
          className="neu-pill inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold"
          style={{ background: 'var(--cp-amber)', color: 'var(--cp-ink)' }}
        >
          <Send size={15} /> Написать свою цепочку
        </button>
        <span className="text-xs" style={{ color: 'var(--cp-paper-faint)' }}>
          В демо — только просмотр. Регистрация откроет генератор.
        </span>
      </div>
    </div>
  );
}
