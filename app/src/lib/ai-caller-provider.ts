/* ──────────────────────────────────────────────
   AI Caller — провайдер-агностичная обёртка
   Переключает между Vapi и ElevenLabs через
   переменную окружения AI_CALLER_PROVIDER.
   ────────────────────────────────────────────── */

import * as vapi from './vapi';
import * as elevenlabs from './elevenlabs-convai';

export type AiCallerProvider = 'vapi' | 'elevenlabs';

export function getProvider(): AiCallerProvider {
  const val = process.env.AI_CALLER_PROVIDER?.toLowerCase();
  if (val === 'elevenlabs') return 'elevenlabs';
  return 'vapi';
}

export function parseProvider(value: string | null | undefined): AiCallerProvider | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'elevenlabs') return 'elevenlabs';
  if (normalized === 'vapi') return 'vapi';
  return undefined;
}

function backend(provider?: AiCallerProvider) {
  const resolved = provider ?? getProvider();
  if (resolved === 'elevenlabs') return elevenlabs;
  return vapi;
}

// ── Assistants (Agents) ──

export function listAssistants(provider?: AiCallerProvider) {
  return backend(provider).listAssistants();
}

export function getAssistant(id: string, provider?: AiCallerProvider) {
  return backend(provider).getAssistant(id);
}

export function createAssistant(data: Record<string, unknown>, provider?: AiCallerProvider) {
  return backend(provider).createAssistant(data);
}

export function updateAssistant(id: string, data: Record<string, unknown>, provider?: AiCallerProvider) {
  return backend(provider).updateAssistant(id, data);
}

export function deleteAssistant(id: string, provider?: AiCallerProvider) {
  return backend(provider).deleteAssistant(id);
}

// ── Phone Numbers ──

export function listPhoneNumbers(provider?: AiCallerProvider) {
  return backend(provider).listPhoneNumbers();
}

// ── Calls (Conversations) ──

export function listCalls(params?: {
  assistantId?: string;
  limit?: number;
  createdAtGe?: string;
  createdAtLe?: string;
}, provider?: AiCallerProvider) {
  return backend(provider).listCalls(params);
}

/**
 * `signal` последним параметром, после `provider`: порядок аргументов у всех
 * существующих вызовов не меняется. Нужен воркеру обзвона — он опрашивает исход
 * звонка в цикле и на остановке процесса обязан выйти сразу.
 */
export function getCall(id: string, provider?: AiCallerProvider, signal?: AbortSignal) {
  return backend(provider).getCall(id, signal);
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
}, provider?: AiCallerProvider) {
  return backend(provider).createCall(data);
}
