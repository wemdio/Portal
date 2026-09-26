import { authFetch, authFetchJson } from '@/lib/authFetch';

const BASE = '/api/tools/sender';

export interface MailboxDto {
  id: string;
  provider: string;
  auth_type: 'password' | 'google_sa';
  /** Галочка «берём в рассылку». */
  enabled: boolean;
  /** Состояние ящика в самом Workspace на момент последней синхронизации. */
  google_state: 'active' | 'suspended' | 'missing' | null;
  /** Админ Workspace, из чьего каталога пришёл ящик. */
  google_account: string | null;
  /** Адрес отправки, за которым закреплён ящик; null — выдаётся автоматически. */
  egress_ip: string | null;
  email: string;
  display_name: string | null;
  username: string;
  smtp_host: string;
  smtp_port: number;
  imap_host: string | null;
  imap_port: number;
  status: 'pending' | 'verified' | 'failed' | 'disabled';
  daily_campaign_limit: number;
  last_verified_at: string | null;
  last_error: string | null;
  last_send_at: string | null;
  /** Тег ящика, он же категория. Один ящик — один тег. */
  tag: MailboxTagRef | null;
  /** Последняя проверочная отправка: не переписывает ли провайдер заголовки. */
  probe: MailboxProbeDto | null;
}

/** Сводка пробы в строке ящика; полный разбор — GET /probe. */
export interface MailboxProbeDto {
  status: 'pending' | 'sent' | 'done' | 'failed';
  passed: boolean | null;
  error: string | null;
  at: string;
}

/** Полный результат пробы: построчное сравнение заголовков. */
export interface ProbeResultDto {
  id: string;
  status: 'pending' | 'sent' | 'done' | 'failed';
  passed: boolean | null;
  error: string | null;
  sent_at: string | null;
  received_at: string | null;
  result: { check: string; expected: string | null; actual: string | null; ok: boolean; note: string | null }[];
}

/** Тег в строке ящика: только то, что нужно нарисовать чип. */
export interface MailboxTagRef {
  id: string;
  name: string;
}

/** Тег в окошке фильтра — со счётчиком ящиков. */
export interface MailboxTagDto extends MailboxTagRef {
  mailboxes: number;
}

export interface CampaignDto {
  id: string;
  name: string;
  /** Пул ящиков кампании — боковая колонка вкладки «Письма». */
  mailboxes: { id: string; email: string }[];
  status: 'draft' | 'running' | 'paused' | 'done';
  timezone: string;
  send_hour_from: number;
  send_hour_to: number;
  send_weekdays: number[];
  created_at: string;
  stats: CampaignStatsDto | null;
}

export interface CampaignStatsDto {
  recipients: number;
  replied: number;
  bounced: number;
  /** Кому реально ушло хотя бы одно письмо — знаменатель reply rate. */
  reached: number;
  replyRate: number | null;
  bounceRate: number | null;
  sent: number;
  scheduled: number;
  failed: number;
}

export interface ImportMailboxesResult {
  imported: number;
  /** Провайдер → сколько ящиков портал к нему отнёс. Ключи — значения колонки provider. */
  detected: Record<string, number>;
  errors: { line: number | null; email: string | null; message: string }[];
  /** Сколько строк с данными было в файле до обреза лимитом. */
  fileRows?: number;
  /** Сколько строк реально прочитано, если файл обрезан лимитом. */
  truncated?: number | null;
}

/** Строка представления sender_threads: одна переписка с получателем. */
export interface ThreadDto {
  recipient_id: string;
  campaign_id: string;
  campaign_name: string;
  recipient_email: string;
  recipient_name: string | null;
  status: string;
  replied_at: string | null;
  mailbox_id: string | null;
  mailbox_email: string | null;
  sent_count: number;
  last_sent_at: string | null;
  reply_count: number;
  last_reply_at: string | null;
  has_human_reply: boolean;
  last_activity_at: string;
}

/** Письмо переписки: наше исходящее или ответ получателя. */
export interface ThreadItemDto {
  id: string;
  direction: 'out' | 'in';
  subject: string | null;
  body: string | null;
  at: string | null;
  note: string | null;
  fromEmail: string | null;
}

export interface ImportRecipientsResult {
  imported: number;
  /** База была заменена, а не дополнена. */
  replaced?: boolean;
  /** Некорректный адрес. */
  skippedInvalid: number;
  /** Первое письмо у строки выходит пустым (пустая переменная в теме или тексте). */
  skippedEmptyLetter?: number;
  skippedDuplicates: number;
  skippedSuppressed: number;
  /** Сколько строк с данными было в файле до обреза лимитом. */
  fileRows?: number;
  /** Сколько строк реально прочитано, если файл обрезан лимитом. */
  truncated?: number | null;
}

/** Кампания целиком — то, с чем открывается форма редактирования. */
export interface CampaignDetailsDto {
  campaign: {
    id: string;
    name: string;
    status: CampaignDto['status'];
    timezone: string;
    send_hour_from: number;
    send_hour_to: number;
    send_weekdays: number[];
    gap_seconds: number;
    gap_jitter_seconds: number;
  };
  steps: { step_no: number; delay_hours: number; subject: string; body: string }[];
  mailboxes: { id: string; email: string }[];
  /** Ответили по шагам цепочки: на каком касании лид ответил (задача 6.4). */
  repliesByStep?: { step: number; replied: number }[];
  recipients: {
    total: number;
    /** Счётчики «заполнено у N» посчитаны по всей базе, а не по выборке. */
    exact: boolean;
    columns: RecipientColumnsDto;
  };
  /** Черновик и кампания на паузе правятся; идущая и завершённая — только чтение. */
  editable: boolean;
}

export interface StepInput {
  /** Задержка от предыдущего шага в часах; у первого письма игнорируется. */
  delayHours: number;
  subject: string;
  body: string;
}

async function upload<T>(url: string, file: File, fields?: Record<string, string>): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  for (const [key, value] of Object.entries(fields ?? {})) form.append(key, value);
  // Content-Type не ставим: браузер сам подставит boundary для multipart.
  const res = await authFetch(url, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error((data as { error?: string })?.error ?? `Ошибка ${res.status}`);
  return data as T;
}

export function fetchMailboxes(
  params: {
    page?: number;
    search?: string;
    pageSize?: number;
    /** Показывать только ящики этих тегов. Пусто — не фильтруем по тегу. */
    tagIds?: string[];
    /** Вдобавок к tagIds показывать ящики без тега. */
    noTag?: boolean;
    /** Только ящики этого адреса отправки; 'none' — ящики без адреса. */
    egressIp?: string;
  } = {},
) {
  const query = new URLSearchParams({ page: String(params.page ?? 1) });
  if (params.search) query.set('search', params.search);
  if (params.pageSize) query.set('pageSize', String(params.pageSize));
  if (params.tagIds?.length) query.set('tagIds', params.tagIds.join(','));
  if (params.noTag) query.set('noTag', '1');
  if (params.egressIp) query.set('egressIp', params.egressIp);
  return authFetchJson<{ mailboxes: MailboxDto[]; total: number }>(
    `${BASE}/mailboxes?${query.toString()}`,
  );
}

export function fetchMailboxTags() {
  return authFetchJson<{ tags: MailboxTagDto[]; untagged: number }>(`${BASE}/tags`);
}

export function createMailboxTag(name: string) {
  return authFetchJson<MailboxTagDto>(`${BASE}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function renameMailboxTag(id: string, name: string) {
  return authFetchJson<MailboxTagRef>(`${BASE}/tags/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function deleteMailboxTag(id: string) {
  return authFetchJson<{ ok: true }>(`${BASE}/tags/${id}`, { method: 'DELETE' });
}

export function importMailboxes(file: File) {
  return upload<ImportMailboxesResult>(`${BASE}/mailboxes`, file);
}

/** Итог загрузки ящиков напрямую из каталога Google Workspace. */
export interface GoogleSyncResult {
  added: number;
  updated: number;
  suspended: number;
  missing: number;
  total: number;
  /** Аккаунты, чей каталог Google не отдал. */
  failed: { account: string; error: string }[];
}

export function googleWorkspaceStatus() {
  return authFetchJson<{ configured: boolean }>(`${BASE}/mailboxes/google`);
}

/** Синхронизировать каталог прямо сейчас; раз в час это делает воркер сам. */
export function syncGoogleWorkspace() {
  return authFetchJson<GoogleSyncResult>(`${BASE}/mailboxes/google`, { method: 'POST' });
}

export function patchMailbox(id: string, body: Record<string, unknown>) {
  return authFetchJson<{ ok: true }>(`${BASE}/mailboxes/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function deleteMailbox(id: string) {
  return authFetchJson<{ ok: true }>(`${BASE}/mailboxes/${id}`, { method: 'DELETE' });
}

/** Завести проверочную отправку с ящика на контрольный адрес. */
export function startMailboxProbe(id: string) {
  return authFetchJson<{ ok: true }>(`${BASE}/mailboxes/${id}/probe`, { method: 'POST' });
}

/** Последняя проверочная отправка ящика с полным разбором заголовков. */
export function fetchMailboxProbe(id: string) {
  return authFetchJson<{ probe: ProbeResultDto | null }>(`${BASE}/mailboxes/${id}/probe`);
}

export type BulkMailboxAction = 'recheck' | 'enable' | 'disable' | 'delete' | 'tag';

/**
 * Действие над выборкой одним запросом: двести ящиков — это не двести запросов.
 * Для 'tag' в tagId приезжает тег или null — «снять тег».
 */
export function bulkMailboxes(ids: string[], action: BulkMailboxAction, tagId?: string | null) {
  return authFetchJson<{ ok: true; affected: number }>(`${BASE}/mailboxes`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, action, ...(action === 'tag' ? { tagId: tagId ?? null } : {}) }),
  });
}

/** Адрес отправки: с него выходит в интернет свой воркер. */
export interface EgressIpDto {
  ip: string;
  host: string;
  acceptsNew: boolean;
  /** online — воркер на связи; silent — давно не выходил; error — выходит в интернет не с того адреса. */
  state: 'online' | 'silent' | 'error';
  lastSeenAt: string | null;
  lastError: string | null;
  mailboxes: number;
  enabledMailboxes: number;
  sentToday: number;
}

export function fetchEgressIps() {
  return authFetchJson<{ ips: EgressIpDto[]; unassigned: number }>(`${BASE}/egress`);
}

export function setEgressAcceptsNew(ip: string, acceptsNew: boolean) {
  return authFetchJson<{ ok: true }>(`${BASE}/egress`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip, acceptsNew }),
  });
}

/** Перенести выбранные ящики на другой адрес отправки. */
export function moveMailboxes(ids: string[], egressIp: string) {
  return authFetchJson<{ ok: true; affected: number }>(`${BASE}/mailboxes`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, action: 'move', egressIp }),
  });
}

export function fetchCampaigns() {
  return authFetchJson<{ campaigns: CampaignDto[] }>(`${BASE}/campaigns`);
}

export function createCampaign(body: {
  name: string;
  mailboxIds: string[];
  steps: StepInput[];
  timezone: string;
  sendHourFrom: number;
  sendHourTo: number;
  /** Дни недели, когда кампании разрешено отправлять: 1 = понедельник … 7 = воскресенье. */
  sendWeekdays: number[];
  /** Пауза между письмами одного ящика: базовая и случайная добавка, секунды. */
  gapSeconds: number;
  gapJitterSeconds: number;
}) {
  return authFetchJson<{ id: string }>(`${BASE}/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function fetchThreads(params: {
  page?: number;
  campaignId?: string;
  mailboxId?: string;
  search?: string;
  onlyReplied?: boolean;
} = {}) {
  const query = new URLSearchParams({ page: String(params.page ?? 1) });
  if (params.campaignId) query.set('campaignId', params.campaignId);
  if (params.mailboxId) query.set('mailboxId', params.mailboxId);
  if (params.search) query.set('search', params.search);
  if (params.onlyReplied) query.set('onlyReplied', '1');
  return authFetchJson<{ threads: ThreadDto[]; total: number; pageSize: number }>(
    `${BASE}/threads?${query.toString()}`,
  );
}

export function fetchThread(recipientId: string) {
  return authFetchJson<{
    thread: {
      recipient_id: string;
      campaign_name: string;
      recipient_email: string;
      recipient_name: string | null;
      status: string;
      mailbox_email: string | null;
      reply_count: number;
    };
    items: ThreadItemDto[];
  }>(`${BASE}/threads/${recipientId}`);
}

/** Входящее письмо, которое не удалось связать с получателем кампании. */
export interface UnlinkedReplyDto {
  id: string;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  body: string | null;
  kind: string;
  at: string | null;
  mailboxEmail: string | null;
}

export function fetchUnlinkedReplies(page = 1) {
  return authFetchJson<{ replies: UnlinkedReplyDto[]; total: number; pageSize: number }>(
    `${BASE}/replies?page=${page}`,
  );
}

export function fetchCampaign(id: string) {
  return authFetchJson<CampaignDetailsDto>(`${BASE}/campaigns/${id}`);
}

/** Сохранить настройки кампании. Без action — сервер понимает это как правку. */
export function updateCampaign(
  id: string,
  body: {
    name: string;
    mailboxIds: string[];
    steps: StepInput[];
    timezone: string;
    sendHourFrom: number;
    sendHourTo: number;
    sendWeekdays: number[];
    gapSeconds: number;
    gapJitterSeconds: number;
  },
) {
  return authFetchJson<{ ok: true; unstuck: number }>(`${BASE}/campaigns/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function patchCampaign(id: string, action: 'start' | 'pause' | 'finish') {
  return authFetchJson<{ ok: true; status: string }>(`${BASE}/campaigns/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

export function deleteCampaign(id: string) {
  return authFetchJson<{ ok: true }>(`${BASE}/campaigns/${id}`, { method: 'DELETE' });
}

/** Что нашлось в базе получателей — ответ /recipients/preview. */
export interface RecipientVariableDto {
  key: string;
  header: string | null;
  filled: number;
  sample: string | null;
}

/** Предпросмотр письма на реальных строках (задача 5.6). */
export interface PreviewSampleDto {
  email: string;
  steps: { subject: string; body: string }[];
}

export interface RecipientColumnsDto {
  emailHeader: string | null;
  nameHeader: string | null;
  recipients: number;
  invalid: number;
  duplicates: number;
  variables: RecipientVariableDto[];
  /** Сколько строк с данными было в файле до обреза лимитом. */
  fileRows?: number;
  /** Сколько строк реально прочитано, если файл обрезан лимитом. */
  truncated?: number | null;
  /** Пришло, если форма передала шаги письма — рендер на реальных строках. */
  samples?: PreviewSampleDto[];
}

export function previewRecipients(file: File, steps?: { subject: string; body: string }[]) {
  return upload<RecipientColumnsDto>(
    `${BASE}/recipients/preview`,
    file,
    steps?.length ? { steps: JSON.stringify(steps) } : undefined,
  );
}

/** Предпросмотр шагов на реальных получателях уже загруженной базы кампании. */
export function previewCampaignSteps(campaignId: string, steps: { subject: string; body: string }[]) {
  return authFetchJson<{ samples: PreviewSampleDto[] }>(`${BASE}/campaigns/${campaignId}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ steps }),
  });
}

/** Строка базы кампании (экран получателей, задача 5.2). */
export interface CampaignRecipientDto {
  id: string;
  email: string;
  name: string | null;
  status: string;
  statusLabel: string;
  lastStepSent: number;
  repliedAt: string | null;
  updatedAt: string;
  mailboxEmail: string | null;
}

export function fetchCampaignRecipients(
  campaignId: string,
  params: { page?: number; search?: string; status?: string } = {},
) {
  const query = new URLSearchParams({ page: String(params.page ?? 1) });
  if (params.search) query.set('search', params.search);
  if (params.status) query.set('status', params.status);
  return authFetchJson<{ recipients: CampaignRecipientDto[]; total: number; pageSize: number }>(
    `${BASE}/campaigns/${campaignId}/recipients?${query.toString()}`,
  );
}

/** Ответить лиду из окна переписки (задача 4.1): уходит с закреплённого ящика. */
export function replyToThread(recipientId: string, text: string) {
  return authFetchJson<{ ok: true }>(`${BASE}/threads/${recipientId}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

/** Строка стоп-листа (задача 5.3). */
export interface SuppressionDto {
  email: string;
  reason: string;
  note: string | null;
  created_at: string;
}

export function fetchSuppressions(params: { page?: number; search?: string } = {}) {
  const query = new URLSearchParams({ page: String(params.page ?? 1) });
  if (params.search) query.set('search', params.search);
  return authFetchJson<{ suppressions: SuppressionDto[]; total: number; pageSize: number }>(
    `${BASE}/suppressions?${query.toString()}`,
  );
}

export function addSuppressions(input: string, note?: string) {
  const emails = input.split(/[\s,;]+/).filter(Boolean);
  return authFetchJson<{ imported: number; skippedExisting: number }>(`${BASE}/suppressions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails, note }),
  });
}

/**
 * Большой список (загрузка файла) — частями: один запрос на десятки тысяч
 * адресов упирается в размер тела и таймаут.
 */
export async function addSuppressionList(emails: string[], note?: string) {
  const CHUNK = 5000;
  let imported = 0;
  let skippedExisting = 0;
  for (let i = 0; i < emails.length; i += CHUNK) {
    const res = await authFetchJson<{ imported: number; skippedExisting: number }>(`${BASE}/suppressions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails: emails.slice(i, i + CHUNK), note }),
    });
    imported += res.imported;
    skippedExisting += res.skippedExisting;
  }
  return { imported, skippedExisting };
}

export function removeSuppression(email: string) {
  return authFetchJson<{ ok: true }>(`${BASE}/suppressions?email=${encodeURIComponent(email)}`, {
    method: 'DELETE',
  });
}

/** Статистика ответов по ящикам и доменам (задача 6.3). */
export interface MailboxStatRow {
  reached: number;
  replied: number;
  bounced: number;
  replyRate: number | null;
  bounceRate: number | null;
}

export interface MailboxStatsDto {
  mailboxes: (MailboxStatRow & { mailbox_id: string; email: string; domain: string; status: string; enabled: boolean; sent: number })[];
  domains: (MailboxStatRow & { domain: string; mailboxes: number; sent: number })[];
}

export function fetchMailboxStats() {
  return authFetchJson<MailboxStatsDto>(`${BASE}/mailbox-stats`);
}

/** mode 'replace' — заменить базу; по умолчанию новые адреса добавляются к старым. */
export function uploadRecipients(campaignId: string, file: File, mode: 'append' | 'replace' = 'append') {
  return upload<ImportRecipientsResult>(
    `${BASE}/campaigns/${campaignId}/recipients`,
    file,
    mode === 'replace' ? { mode } : undefined,
  );
}
