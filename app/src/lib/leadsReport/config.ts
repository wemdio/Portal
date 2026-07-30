export type ColumnKey =
  | 'amo_url'
  | 'amo_id_raw'
  | 'utm_block'
  | 'platform'
  | 'category'
  | 'created_at_short'
  | 'phone'
  | 'email'
  | 'name'
  | 'responsible_name'
  | 'company_name'
  | 'company_website'
  | 'status_name'
  | 'empty';

/** Спецификация одной колонки таблицы отчёта. */
export type ColumnSpec = {
  /** Заголовок колонки (для документации/логов, в Sheet не пишется). */
  header: string;
  /** Ключ данных из AmoLead (см. report.ts) — как извлечь значение. */
  key: ColumnKey;
};

export type LeadsReportConfig = {
  name: 'marketing' | 'outreach';
  spreadsheetId: string;
  /** Имя вкладки, куда пишем поток лидов. */
  sheetName: string;
  /**
   * Фильтр сделок по кастомному полю AMO.
   * Например: fieldName='Контур' + equals='Маркетинг' — только сделки,
   * которые команда явно пометила как маркетинговые.
   */
  amoFieldFilter: {
    fieldName: string;
    match: { equals: string } | { notEquals: string };
  };
  /** Список колонок в порядке слева-направо. Последняя всегда `amo_id` (служебная, для дедупа). */
  columns: ColumnSpec[];
  /** Логический источник для external_sync_runs. */
  syncSource: 'leads_report_marketing' | 'leads_report_outreach';
  /**
   * Буква колонки, в которую скрипт пишет дату лида в формате DD.MM.YYYY
   * (для outreach — `I` «Дата передачи лида», для marketing — `D` «Дата»).
   *
   * Используется для инкрементального дедупа при первом переключении на
   * боевую таблицу: перед запросом в AMO скрипт читает эту колонку, находит
   * max-дату и тянет из `amo_leads` только сделки с `created_at >= max`.
   * Это позволяет не полагаться на amo_id-дедуп по существующим ручным
   * строкам (у них amo_id пустой), но при этом не терять сделки. Дубликаты
   * за граничную дату отсекает уже дедуп по amo_id ниже.
   *
   * Если колонка пустая (свежий лист без единой записи) — fallback на
   * `sinceDays * DAY` от «сейчас».
   */
  dateColumnLetter: string;
};

const AMO_ID_COLUMN: ColumnSpec = { header: 'AMO id', key: 'amo_id_raw' };

export const marketingConfig: LeadsReportConfig = {
  name: 'marketing',
  spreadsheetId: process.env.LEADS_REPORT_MARKETING_SHEET_ID ?? '',
  sheetName: 'Лиды маркетинг',
  // Маркетинговая сделка — та, что команда явно отметила в AMO полем
  // «Контур» = «Маркетинг». Раньше правило было notEquals «Email Outreach»,
  // из-за чего в маркетинг падали 1399 сделок без явного источника и весь
  // «мусор». С 2026-07-24 маркетинг помечается вручную и попадает в отчёт
  // только по явному маркеру.
  amoFieldFilter: {
    fieldName: 'Контур',
    match: { equals: 'Маркетинг' },
  },
  syncSource: 'leads_report_marketing',
  dateColumnLetter: 'D',
  // Порядок колонок 1:1 с боевой таблицей «Учет проектов внутреннее» → лист «Лиды маркетинг».
  // Ручные колонки менеджера (Дата последнего контакта, Качество лида, На чем остановились,
  // и числовая метрика в L) — оставляем пустыми: заполнит менеджер вручную. AMO id пишется
  // в служебный столбец N (пустой в шапке), скрипт использует его для дедупа.
  columns: [
    { header: 'Ссылка на лид в амо', key: 'amo_url' },                    // A
    { header: 'UTM', key: 'utm_block' },                                   // B
    { header: 'Площадка', key: 'platform' },                               // C
    { header: 'Дата', key: 'created_at_short' },                           // D
    { header: 'Телефон', key: 'phone' },                                   // E
    { header: 'email', key: 'email' },                                     // F
    { header: 'Имя', key: 'name' },                                        // G
    { header: 'Дата последнего контакта', key: 'empty' },                  // H
    { header: 'Качество лида', key: 'empty' },                             // I
    { header: 'Кто обрабатывает лид', key: 'responsible_name' },           // J
    { header: 'На чем остановились', key: 'empty' },                       // K
    { header: 'метрика', key: 'empty' },                                   // L
    { header: 'источник для отчета по маркетингу', key: 'category' },      // M
    AMO_ID_COLUMN,                                                          // N
  ],
};

export const outreachConfig: LeadsReportConfig = {
  name: 'outreach',
  spreadsheetId: process.env.LEADS_REPORT_OUTREACH_SHEET_ID ?? '',
  sheetName: 'Лиды',
  amoFieldFilter: {
    fieldName: 'Источник',
    match: { equals: 'Email Outreach' },
  },
  syncSource: 'leads_report_outreach',
  dateColumnLetter: 'I',
  // Порядок и позиции колонок 1:1 соответствуют боевому листу «Лиды»
  // (см. образец «Polza Ru Outreach.xlsx»): ручные колонки менеджера
  // (Оффер / Сфера деятельности / Ком-й / Из какой кампании / Статус /
  // Дата последнего контакта / Качество лида / Кто обрабатывает лид)
  // скрипт оставляет пустыми — заполнит менеджер вручную. AMO id
  // пишется в служебный столбец P (сейчас пустой) и используется для
  // дедупа при следующих запусках cron.
  columns: [
    { header: 'Оффер', key: 'empty' },                    // A
    { header: 'Сфера деятельности', key: 'empty' },       // B
    { header: 'Имя', key: 'name' },                       // C
    { header: 'Контакт', key: 'phone' },                  // D
    { header: 'Ком-й', key: 'empty' },                    // E
    { header: 'Email', key: 'email' },                    // F
    { header: 'Организация', key: 'company_name' },       // G
    { header: 'Сайт', key: 'company_website' },           // H
    { header: 'Дата передачи лида', key: 'created_at_short' }, // I
    { header: 'Из какой кампании', key: 'empty' },        // J
    { header: '@dropdown', key: 'empty' },                // K
    { header: 'Статус', key: 'empty' },                   // L
    { header: 'Дата последнего контакта', key: 'empty' }, // M
    { header: 'Качество лида', key: 'empty' },            // N
    { header: 'Кто обрабатывает лид', key: 'empty' },     // O
    AMO_ID_COLUMN,                                         // P
  ],
};

export const ALL_CONFIGS: LeadsReportConfig[] = [
  marketingConfig,
  outreachConfig,
];
