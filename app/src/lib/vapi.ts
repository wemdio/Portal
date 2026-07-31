/* ──────────────────────────────────────────────
   Vapi.ai — серверный API-клиент
   Используется только в API routes (server-side)
   ────────────────────────────────────────────── */

const VAPI_BASE = 'https://api.vapi.ai';

function getApiKey(): string {
  const key = process.env.VAPI_API_KEY;
  if (!key) throw new Error('VAPI_API_KEY is not configured');
  return key;
}

async function vapiRequest<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${VAPI_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Vapi ${res.status}: ${text || res.statusText}`);
  }

  // DELETE returns 204 with no body
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

// ── Assistants ──

export function listAssistants() {
  return vapiRequest<Record<string, unknown>[]>('/assistant');
}

export function getAssistant(id: string) {
  return vapiRequest<Record<string, unknown>>(`/assistant/${id}`);
}

export function createAssistant(data: Record<string, unknown>) {
  return vapiRequest<Record<string, unknown>>('/assistant', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateAssistant(id: string, data: Record<string, unknown>) {
  return vapiRequest<Record<string, unknown>>(`/assistant/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function deleteAssistant(id: string) {
  return vapiRequest<void>(`/assistant/${id}`, { method: 'DELETE' });
}

// ── Phone Numbers ──

export function listPhoneNumbers() {
  return vapiRequest<Record<string, unknown>[]>('/phone-number');
}

// ── Calls ──

export function listCalls(params?: {
  assistantId?: string;
  limit?: number;
  createdAtGe?: string;
  createdAtLe?: string;
}) {
  const qs = new URLSearchParams();
  if (params?.assistantId) qs.set('assistantId', params.assistantId);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.createdAtGe) qs.set('createdAtGe', params.createdAtGe);
  if (params?.createdAtLe) qs.set('createdAtLe', params.createdAtLe);
  const query = qs.toString();
  return vapiRequest<Record<string, unknown>[]>(`/call${query ? `?${query}` : ''}`);
}

/**
 * Vapi's plain recordingUrl may point at a private R2 object and return
 * InvalidArgument/Authorization. The presigned artifact URLs are the browser-
 * usable variants and are refreshed whenever the call details are requested.
 */
export function pickRecordingUrl(
  call: Record<string, unknown> | null | undefined,
): string {
  const artifact = (call?.artifact ?? {}) as Record<string, unknown>;
  return (
    (artifact.presignedMonoUrl as string) ||
    (artifact.presignedStereoUrl as string) ||
    (call?.recordingUrl as string) ||
    (artifact.recordingUrl as string) ||
    ''
  );
}

export async function getCall(id: string) {
  const call = await vapiRequest<Record<string, unknown>>(`/call/${id}`);
  const recordingUrl = pickRecordingUrl(call);
  if (!recordingUrl) return call;

  const artifact = (call.artifact ?? {}) as Record<string, unknown>;
  return {
    ...call,
    recordingUrl,
    artifact: { ...artifact, recordingUrl },
  };
}

export function createCall(data: {
  assistantId: string;
  phoneNumberId: string;
  customer: { number: string };
  contactData?: {
    contactName?: string;
    companyName?: string;
    email?: string;
  };
}) {
  const payload: Record<string, unknown> = {
    assistantId: data.assistantId,
    phoneNumberId: data.phoneNumberId,
    customer: data.customer,
    assistantOverrides: {
      firstMessageMode: 'assistant-waits-for-user',
    },
  };

  if (data.contactData) {
    const parts: string[] = [];
    if (data.contactData.contactName) parts.push(`Имя контакта: ${data.contactData.contactName}`);
    if (data.contactData.companyName) parts.push(`Компания: ${data.contactData.companyName}`);
    if (data.contactData.email) parts.push(`Email: ${data.contactData.email}`);
    if (parts.length > 0) {
      payload.assistantOverrides = {
        ...(payload.assistantOverrides as Record<string, unknown>),
        variableValues: {
          contact_name: data.contactData.contactName ?? '',
          company_name: data.contactData.companyName ?? '',
          email: data.contactData.email ?? '',
          contact_greeting: data.contactData.contactName
            ? `, ${data.contactData.contactName}`
            : '',
        },
      };
    }
  }

  return vapiRequest<Record<string, unknown>>('/call/phone', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
