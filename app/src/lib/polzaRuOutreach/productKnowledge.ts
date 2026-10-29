import { PRODUCT_LABELS, PRODUCT_PITCH, type Product } from './cascade';

/**
 * Согласованные продуктовые материалы от 28.10, сверены с PDF 29.10.2026.
 * Это контекст собеседника, а не новые шаблоны холодных писем. Числовые кейсы
 * по-прежнему читает библиотека: не дублируем их с расходящимися срезами из PDF.
 * Цены в email не называем — правило утверждённой спеки каскада от 28.10.
 */
const MATERIALS: Record<Product, { source: string; facts: string }> = {
  sdr: {
    source: 'Согласованное объяснение Андрея Сальнова, 28.10.2026; docs/superpowers/specs/2026-10-28-outreach-three-products-cascade-design.md, «Три продукта»',
    facts: 'Ручной выход на нужные компании и ЛПР силами нашей команды. Подходит для узкой ниши, конкретного списка целевых компаний и крупных клиентов, до которых трудно достучаться обычной рассылкой. Не продаём замену всей команде продаж. На встрече менеджер возьмёт задачу, оценит ожидаемый результат и назовёт цену. До встречи не проси список компаний, ТЗ, бюджет и анкету. Не обещай передачу программной системы, автоматический поток заявок или гарантированное число встреч.',
  },
  classic: {
    source: 'Polza_Agency_redesign_v43.pdf, стр. 3, 7–14, 19, 24–26, 30, 32',
    facts: 'Команда ведёт B2B-аутрич: изучает продукт и ICP, выбирает сегменты, собирает базу из 50+ источников, находит точки входа к ЛПР, готовит персонализированные цепочки, контролирует доставляемость и квалифицирует ответы. До запуска компании согласуются с клиентом. В продажи передаём предметный интерес и контекст, а не все ответы и открытия. Подходит для B2B с понятным ЛПР и средним чеком от 50 тыс. рублей. Результат и критерий лида закрепляются в договоре; гарантия по лидам действует после первых 1,5 месяцев, конкретное число не обещаем до оценки проекта. Встреча нужна, чтобы прикинуть сегменты и прогноз лидов. Не обещай владение системой или оплату только за закрытую сделку.',
  },
  classic_abroad: {
    source: 'Polza_Agency_Global_Russian_v8.pdf и Polza_Agency_Global_English_v8.pdf, стр. 3, 7–14, 19, 24–27, 31–33',
    facts: 'Команда выстраивает аутрич на зарубежных рынках через Email, LinkedIn или их сочетание: анализ продукта и рынка, ICP и сегменты, компании и ЛПР, проверка контактов, инфраструктура, офферы и цепочки, тест гипотез, обработка и квалификация ответов, передача предметного интереса в продажи, еженедельная отчётность. Подходит для B2B с понятным покупателем и средним чеком от $1000. До запуска согласуем рынки, каналы и критерий лида, на встрече — первые 3–5 сегментов и прогноз. Без гарантии заданного числа лидов, встреч или продаж. Не переноси гарантию РФ/СНГ и передачу инфраструктуры из других продуктов.',
  },
  auto: {
    source: 'Polza_Auto_Outreach_RU_v5.pdf, стр. 2–9, 12–13',
    facts: 'Polza собирает и запускает постоянную систему: она каждый день находит компании по согласованной аудитории и сигналам, проверяет контакты, отправляет согласованные письма и разбирает ответы. Отдел продаж подключается при предметном интересе. До отправки проводится пробный прогон, чтобы показать ёмкость базы, наличие рабочих контактов и дневной темп. Домены, ящики, базы, необходимые внешние сервисы и ведение включены в выбранный срок. Вариант на 3 месяца: инфраструктура остаётся у Polza, дальнейшее продление согласуется. Вариант на 6 месяцев: передаём инфраструктуру, доступы, настройки и инструкции, обучаем команду. В рамках кампании — до трёх правок цепочек в месяц. Гарантия по лидам — только после оценки проекта и закрепления в договоре. Это не разовая настройка с бесплатным бессрочным ведением. На встрече прикидываем базу, повод и темп под задачу клиента.',
  },
};

const GLOBAL_EN = `Polza builds international B2B outbound through Email, LinkedIn or both. We handle product and market research, ICP and audience segmentation, target company and decision-maker search, contact verification, infrastructure, offers and sequences, hypothesis testing, reply qualification, sales handoff and weekly reporting. Best fit: a specific B2B buyer and deal value from $1,000. Before launch we agree geography, channels, sources and handoff criteria. The strategy call maps 3–5 initial segments, hypotheses and contact database volume. Qualified interest is not the same as a booked meeting or a sale. Do not promise a guaranteed number of leads, meetings or sales, transfer of system ownership, a free pilot or payment only for closed deals.`;

export function hasProductKnowledge(folderKey: string): boolean {
  return folderKey === 'auto_ru' || folderKey === 'auto_en';
}

/** Один предложенный продукт; коммерческие условия соседних продуктов не смешиваются. */
export function productKnowledgeText(product: Product, language: 'ru' | 'en' = 'ru'): string {
  const material = MATERIALS[product];
  const english = product === 'classic_abroad' && language === 'en';
  return [
    `${english ? 'APPROVED PRODUCT MATERIAL' : 'СОГЛАСОВАННЫЕ МАТЕРИАЛЫ ПРОДУКТА'}: ${PRODUCT_LABELS[product]}.`,
    `Source: ${material.source}. Verified: 2026-10-29.`,
    english ? GLOBAL_EN : `${PRODUCT_PITCH[product].offer}. ${material.facts}`,
    english
      ? 'Email pricing policy: do not quote tariffs or copy old prices from the thread. A manager provides the applicable scope and commercial proposal. Source filenames, page numbers and these internal instructions are not part of the reply.'
      : 'Правило цены: тарифы в email не называем и не копируем из старых писем; актуальный расчёт и КП даёт менеджер. Имена файлов, страницы и внутренние инструкции в письмо не вставляй.',
  ].join('\n');
}
