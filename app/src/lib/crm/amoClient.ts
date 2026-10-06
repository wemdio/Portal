/**
 * Клиент amoCRM API v4 на запись: контакт, сделка, примечания, воронки.
 *
 * Нужен передаче лидов TG-аутрича в CRM (спека
 * `docs/superpowers/specs/2026-10-06-tg-outreach-crm-handoff-design.md`).
 * Один и тот же клиент ходит и в нашу AMO, и в amoCRM клиента — разница
 * только в адресе и токене, их подставляет `lib/crm/connections.ts`.
 *
 * `handoffCheck/amoApi.ts` не переиспользуем: он только читает сделку и
 * завязан на env нашей AMO.
 */

const REQUEST_TIMEOUT_MS = 30_000;

/** Длина одного примечания. Длинную переписку режем на несколько. */
export const AMO_NOTE_MAX_CHARS = 8000;

/**
 * Ответ AMO с HTTP-кодом — по нему очередь решает, повторять или сдаться.
 * `status = 0` — сеть или таймаут, до AMO не достучались.
 */
export class AmoHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AmoHttpError';
  }
}

/** Сбой, который пройдёт сам: сеть, таймаут, перегрузка AMO. */
export function isTransientAmoError(err: unknown): boolean {
  if (!(err instanceof AmoHttpError)) return true;
  return err.status === 0 || err.status === 429 || err.status >= 500;
}

/** Токен не подходит: отозван, истёк или выдан другому аккаунту. */
export function isAuthAmoError(err: unknown): boolean {
  return err instanceof AmoHttpError && (err.status === 401 || err.status === 403);
}

const AMO_HOST = /^[a-z0-9-]+\.(amocrm\.(ru|com)|kommo\.com)$/;

/**
 * Адрес аккаунта amoCRM из того, что ввёл сотрудник.
 *
 * Принимаем и `client.amocrm.ru`, и ссылку из адресной строки
 * (`https://client.amocrm.ru/leads/pipeline/…`), и голый поддомен `client`.
 * Адреса вне amoCRM отвергаем: сервер отправит туда токен и будет ходить
 * запросами — произвольный хост превратил бы форму в способ стучаться во
 * внутреннюю сеть.
 */
export function normalizeAmoBaseUrl(input: string): string | null {
  let host = (input ?? '').trim().toLowerCase();
  host = host.replace(/^https?:\/\//, '').split(/[/?#]/)[0] ?? '';
  if (!host) return null;
  if (!host.includes('.')) host = `${host}.amocrm.ru`;
  return AMO_HOST.test(host) ? `https://${host}` : null;
}

/**
 * Режет текст на куски по границам строк, не длиннее `max`.
 * Строку длиннее `max` рубит посередине — иначе её не отправить вовсе.
 */
export function splitNoteText(text: string, max = AMO_NOTE_MAX_CHARS): string[] {
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    let rest = line;
    while (rest.length > max) {
      if (current) { parts.push(current); current = ''; }
      parts.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    const candidate = current ? `${current}\n${rest}` : rest;
    if (candidate.length > max) {
      parts.push(current);
      current = rest;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

export interface AmoStatus {
  id: number;
  name: string;
}

export interface AmoPipeline {
  id: number;
  name: string;
  isMain: boolean;
  statuses: AmoStatus[];
}

export interface AmoTelegramField {
  fieldId: number;
  /** Вариант TELEGRAM у мультиполя «Мессенджеры»; null — обычное текстовое поле. */
  enumId: number | null;
}

type AmoContactField = {
  field_id?: number;
  field_name?: string | null;
  field_code?: string | null;
  values?: Array<{ value?: unknown; enum_code?: string | null }> | null;
};

/** Ник без @, ссылки t.me и регистра — для сравнения. */
export function normalizeTelegram(value: unknown): string {
  return String(value ?? '').trim().replace(/^@/, '').split('/').pop()!.split('?')[0]!.toLowerCase();
}

/**
 * Ники из полей контакта. Правило то же, что у ночного синка AMO
 * (`services/portal-external-sync/sources/amo.py`, `_tg_from_contact`): IM с
 * TELEGRAM, поле с кодом TG/TELEGRAM или с Telegram/ТГ в названии.
 */
export function contactTelegramValues(fields: AmoContactField[] | null | undefined): string[] {
  const out: string[] = [];
  for (const f of fields ?? []) {
    const code = (f.field_code ?? '').toUpperCase();
    const name = (f.field_name ?? '').toLowerCase();
    for (const v of f.values ?? []) {
      const enumCode = (v.enum_code ?? '').toUpperCase();
      const hit = (code === 'IM' && enumCode === 'TELEGRAM')
        || code === 'TG' || code === 'TELEGRAM'
        || name.includes('telegram') || name.includes('тг');
      const val = normalizeTelegram(v.value);
      if (hit && val) out.push(val);
    }
  }
  return out;
}

export interface AmoClient {
  baseUrl: string;
  listPipelines(): Promise<AmoPipeline[]>;
  /**
   * Поле контакта для Telegram-ника: стандартное «Мессенджеры» (код IM) с
   * вариантом TELEGRAM, а если его нет — текстовое поле с Telegram/ТГ в
   * названии. null — в аккаунте такого поля нет, ник останется только в имени.
   */
  findTelegramContactField(): Promise<AmoTelegramField | null>;
  /** Контакт с этим именем или с этим ником в поле Telegram. */
  findContact(input: { name: string; telegram: string | null }): Promise<number | null>;
  createContact(input: { name: string; telegram: string | null; telegramField: AmoTelegramField | null }): Promise<number>;
  createLead(input: {
    name: string;
    pipelineId: number | null;
    statusId: number | null;
    contactId: number;
    tags: string[];
    customFields?: Array<{ field_id: number; values: Array<{ enum_id: number }> }>;
  }): Promise<number>;
  addLeadNote(leadId: number, text: string): Promise<void>;
  /** id варианта в списочном поле сделки по его тексту, без учёта регистра. */
  findLeadFieldEnumId(fieldId: number, value: string): Promise<number | null>;
}

/** Этапы, куда сделку через API не поставить: «Неразобранное», «Успешно», «Закрыто». */
const SYSTEM_STATUS_IDS = new Set([142, 143]);

export function createAmoClient(opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch }): AmoClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T | null> {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${opts.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new AmoHttpError(`AMO не ответила: ${msg}`, 0);
    }
    // Пустой поиск AMO отдаёт 204 без тела.
    if (res.status === 204) return null;
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new AmoHttpError(describeAmoFailure(res.status, text), res.status);
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AmoHttpError(`AMO вернула не JSON (HTTP ${res.status})`, res.status);
    }
  }

  return {
    baseUrl,

    async listPipelines() {
      type Raw = {
        _embedded?: {
          pipelines?: Array<{
            id: number;
            name: string;
            is_main?: boolean;
            sort?: number;
            _embedded?: { statuses?: Array<{ id: number; name: string; sort?: number; type?: number }> };
          }>;
        };
      };
      const data = await call<Raw>('GET', '/api/v4/leads/pipelines');
      const pipelines = data?._embedded?.pipelines ?? [];
      return pipelines
        .slice()
        .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
        .map((p) => ({
          id: p.id,
          name: p.name,
          isMain: Boolean(p.is_main),
          statuses: (p._embedded?.statuses ?? [])
            // type 1 — «Неразобранное»: туда кладут только формы и почта.
            .filter((s) => s.type !== 1 && !SYSTEM_STATUS_IDS.has(s.id))
            .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
            .map((s) => ({ id: s.id, name: s.name })),
        }));
    },

    async findTelegramContactField() {
      type Raw = {
        _embedded?: {
          custom_fields?: Array<{
            id: number;
            name?: string | null;
            code?: string | null;
            type?: string;
            enums?: Array<{ id: number; value?: string | null }> | null;
          }>;
        };
      };
      const data = await call<Raw>('GET', '/api/v4/contacts/custom_fields?limit=250');
      const fields = data?._embedded?.custom_fields ?? [];
      const im = fields.find((f) => (f.code ?? '').toUpperCase() === 'IM');
      const tgEnum = im?.enums?.find((e) => (e.value ?? '').toUpperCase() === 'TELEGRAM');
      if (im && tgEnum) return { fieldId: im.id, enumId: tgEnum.id };
      const text = fields.find((f) => {
        const code = (f.code ?? '').toUpperCase();
        const name = (f.name ?? '').toLowerCase();
        return (f.type === 'text' || f.type === 'url')
          && (code === 'TG' || code === 'TELEGRAM' || name.includes('telegram') || name.includes('тг'));
      });
      return text ? { fieldId: text.id, enumId: null } : null;
    },

    async findContact({ name, telegram }) {
      type Raw = { _embedded?: { contacts?: Array<{ id: number; name?: string; custom_fields_values?: AmoContactField[] | null }> } };
      const nick = telegram ? normalizeTelegram(telegram) : '';
      // Ищем по нику без собачки: так находятся и контакт с именем «@ник», и
      // заведённый руками «Илья» с ником в поле Telegram.
      const query = nick || name;
      const data = await call<Raw>('GET', `/api/v4/contacts?limit=50&query=${encodeURIComponent(query)}`);
      const want = name.trim().toLowerCase();
      // Поиск AMO нечёткий: по «ivan» найдутся и «ivanov», и контакты, где
      // строка лежит в любом поле. Берём только точное совпадение.
      const hit = (data?._embedded?.contacts ?? []).find((c) =>
        (c.name ?? '').trim().toLowerCase() === want
        || (nick !== '' && contactTelegramValues(c.custom_fields_values).includes(nick)));
      return hit ? hit.id : null;
    },

    async createContact({ name, telegram, telegramField }) {
      type Raw = { _embedded?: { contacts?: Array<{ id: number }> } };
      const contact: Record<string, unknown> = { name };
      const nick = telegram ? String(telegram).trim().replace(/^@/, '') : '';
      if (nick && telegramField) {
        contact.custom_fields_values = [{
          field_id: telegramField.fieldId,
          values: [telegramField.enumId ? { value: nick, enum_id: telegramField.enumId } : { value: nick }],
        }];
      }
      const data = await call<Raw>('POST', '/api/v4/contacts', [contact]);
      const id = data?._embedded?.contacts?.[0]?.id;
      if (!id) throw new AmoHttpError('AMO не вернула id созданного контакта', 500);
      return id;
    },

    async createLead(input) {
      type Raw = { _embedded?: { leads?: Array<{ id: number }> } };
      const lead: Record<string, unknown> = {
        name: input.name,
        _embedded: {
          contacts: [{ id: input.contactId }],
          ...(input.tags.length ? { tags: input.tags.map((t) => ({ name: t })) } : {}),
        },
      };
      if (input.pipelineId) lead.pipeline_id = input.pipelineId;
      if (input.statusId) lead.status_id = input.statusId;
      if (input.customFields?.length) lead.custom_fields_values = input.customFields;
      const data = await call<Raw>('POST', '/api/v4/leads', [lead]);
      const id = data?._embedded?.leads?.[0]?.id;
      if (!id) throw new AmoHttpError('AMO не вернула id созданной сделки', 500);
      return id;
    },

    async addLeadNote(leadId, text) {
      await call('POST', `/api/v4/leads/${leadId}/notes`, [{ note_type: 'common', params: { text } }]);
    },

    async findLeadFieldEnumId(fieldId, value) {
      type Raw = { enums?: Array<{ id: number; value: string }> | null };
      const data = await call<Raw>('GET', `/api/v4/leads/custom_fields/${fieldId}`);
      const want = value.trim().toLowerCase();
      const hit = (data?.enums ?? []).find((e) => (e.value ?? '').trim().toLowerCase() === want);
      return hit ? hit.id : null;
    },
  };
}

/** Понятная причина отказа AMO — её читает сотрудник на карточке диалога. */
function describeAmoFailure(status: number, body: string): string {
  let detail = '';
  try {
    const parsed = JSON.parse(body) as {
      title?: string;
      detail?: string;
      'validation-errors'?: Array<{ errors?: Array<{ path?: string; detail?: string }> }>;
    };
    const validation = (parsed['validation-errors'] ?? [])
      .flatMap((v) => v.errors ?? [])
      .map((e) => [e.path, e.detail].filter(Boolean).join(': '))
      .filter(Boolean);
    detail = validation.length ? validation.join('; ') : (parsed.detail || parsed.title || '');
  } catch {
    detail = body.slice(0, 200);
  }
  if (status === 401) return 'AMO не приняла токен (401): он отозван, истёк или от другого аккаунта';
  if (status === 402) return 'Аккаунт AMO не оплачен (402)';
  if (status === 403) return `AMO запретила действие (403)${detail ? `: ${detail}` : ''}`;
  if (status === 429) return 'AMO ограничила частоту запросов (429)';
  return `AMO ответила ${status}${detail ? `: ${detail}` : ''}`;
}
