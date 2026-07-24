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
  columns: [
    { header: 'Ссылка на лид в амо', key: 'amo_url' },
    { header: 'UTM', key: 'utm_block' },
    { header: 'Площадка', key: 'platform' },
    { header: 'Дата', key: 'created_at_short' },
    { header: 'Телефон', key: 'phone' },
    { header: 'email', key: 'email' },
    { header: 'Имя', key: 'name' },
    { header: 'Кто обрабатывает лид', key: 'responsible_name' },
    { header: 'источник для...', key: 'category' },
    AMO_ID_COLUMN,
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
