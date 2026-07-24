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
  /** Источник, который засчитывается как этот отчёт. Инвертирующий флаг — для маркетинга. */
  amoSourceFilter:
    | { equals: string }
    | { notEquals: string };
  /** Список колонок в порядке слева-направо. Последняя всегда `amo_id` (служебная, для дедупа). */
  columns: ColumnSpec[];
  /** Логический источник для external_sync_runs. */
  syncSource: 'leads_report_marketing' | 'leads_report_outreach';
};

const AMO_ID_COLUMN: ColumnSpec = { header: 'AMO id', key: 'amo_id_raw' };

export const marketingConfig: LeadsReportConfig = {
  name: 'marketing',
  spreadsheetId: process.env.LEADS_REPORT_MARKETING_SHEET_ID ?? '',
  sheetName: 'Лиды маркетинг',
  amoSourceFilter: { notEquals: 'Email Outreach' },
  syncSource: 'leads_report_marketing',
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
  amoSourceFilter: { equals: 'Email Outreach' },
  syncSource: 'leads_report_outreach',
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
