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
  | 'status_name';

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
  sheetName: 'Лиды',
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
  columns: [
    { header: 'Имя', key: 'name' },
    { header: 'Контакт', key: 'phone' },
    { header: 'Email', key: 'email' },
    { header: 'Организация', key: 'company_name' },
    { header: 'Сайт', key: 'company_website' },
    { header: 'Дата передачи лида', key: 'created_at_short' },
    { header: 'Статус', key: 'status_name' },
    AMO_ID_COLUMN,
  ],
};

export const ALL_CONFIGS: LeadsReportConfig[] = [
  marketingConfig,
  outreachConfig,
];
