/* ──────────────────────────────────────────────
   ElevenLabs Conversational AI — серверный API-клиент
   Нормализует ответы к формату, совместимому с Vapi,
   чтобы фронтенд не зависел от провайдера.
   ────────────────────────────────────────────── */

const EL_BASE = 'https://api.elevenlabs.io/v1/convai';

function getApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY is not configured');
  return key;
}

function getDispatcher(): import('undici').Dispatcher | undefined {
  const proxyUrl = process.env.ELEVENLABS_PROXY_URL;
  if (!proxyUrl) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ProxyAgent } = require('undici') as typeof import('undici');
    return new ProxyAgent(proxyUrl);
  } catch {
    return undefined;
  }
}

async function elRequest<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${EL_BASE}${path}`;
  const dispatcher = getDispatcher();
  const fetchOptions: Record<string, unknown> = {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': getApiKey(),
      ...(options.headers ?? {}),
    },
  };
  if (dispatcher) fetchOptions.dispatcher = dispatcher;

  const res = await fetch(url, fetchOptions as RequestInit);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ElevenLabs ${res.status}: ${text || res.statusText}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ── Helpers: ElevenLabs <-> Vapi-compatible shape ──

type R = Record<string, unknown>;

const LLM_NAME_MAP: Record<string, string> = {
  'gpt-4.1': 'gpt-4.1',
  'gpt-4o': 'gpt-4o',
  'gpt-4o-mini': 'gpt-4o-mini',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5',
  'claude-sonnet-4-5': 'claude-sonnet-4-5',
  'gemini-2.5-pro': 'gemini-2.5-flash',
  'gemini-2.5-flash': 'gemini-2.5-flash',
};

function vapiLlmToEl(provider: string, model: string): string {
  return LLM_NAME_MAP[model] ?? model;
}

function unixToIso(secs?: number): string | undefined {
  if (!secs) return undefined;
  return new Date(secs * 1000).toISOString();
}

function elAgentToVapiShape(agent: R): R {
  const config = (agent.conversation_config ?? {}) as R;
  const agentCfg = (config.agent ?? {}) as R;
  const tts = (config.tts ?? {}) as R;
  const prompt = (agentCfg.prompt ?? {}) as R;
  const meta = (agent.metadata ?? {}) as R;

  return {
    id: agent.agent_id,
    name: agent.name,
    firstMessage: agentCfg.first_message,
    language: agentCfg.language,
    model: {
      provider: 'elevenlabs',
      model: prompt.llm ?? '',
      messages: prompt.prompt
        ? [{ role: 'system', content: prompt.prompt }]
        : [],
      temperature: prompt.temperature ?? 0.7,
    },
    voice: {
      provider: '11labs',
      voiceId: tts.voice_id ?? '',
      model: tts.model_id ?? '',
      stability: tts.stability,
      similarityBoost: tts.similarity_boost,
      style: tts.style,
      speed: tts.speed,
    },
    createdAt: unixToIso(meta.created_at_unix_secs as number),
    updatedAt: unixToIso(meta.updated_at_unix_secs as number),
    _provider: 'elevenlabs',
  };
}

function vapiPayloadToElAgent(data: R): R {
  const model = (data.model ?? {}) as R;
  const voice = (data.voice ?? {}) as R;
  const messages = (model.messages ?? []) as { role: string; content: string }[];
  const systemMsg = messages.find((m) => m.role === 'system');

  const result: R = {};
  if (data.name !== undefined) result.name = data.name;

  const conversationConfig: R = {};

  const agentConfig: R = {};
  if (data.firstMessage !== undefined) agentConfig.first_message = data.firstMessage;
  if (data.language !== undefined) agentConfig.language = data.language;

  const promptConfig: R = {};
  if (systemMsg) promptConfig.prompt = systemMsg.content;
  if (model.model) promptConfig.llm = vapiLlmToEl(model.provider as string ?? '', model.model as string);
  if (model.temperature !== undefined) promptConfig.temperature = model.temperature;
  if (Object.keys(promptConfig).length > 0) agentConfig.prompt = promptConfig;

  agentConfig.tools = [
    {
      type: 'end_call',
      description: 'Заверши звонок. Вызывай ВСЕГДА когда: 1) ты попрощалась ("Всего доброго", "До свидания" и т.д.), 2) собеседник попрощался, 3) собеседник молчит после прощания, 4) обнаружен автоответчик.',
    },
  ];

  if (Object.keys(agentConfig).length > 0) conversationConfig.agent = agentConfig;

  conversationConfig.turn = {
    turn_timeout: 8,
    silence_end_call_timeout: 25,
    mode: 'turn',
  };

  conversationConfig.conversation = {
    max_duration_seconds: 180,
  };

  const ttsConfig: R = {};
  if (voice.voiceId) ttsConfig.voice_id = voice.voiceId;
  if (voice.model) ttsConfig.model_id = voice.model;
  if (voice.stability !== undefined) ttsConfig.stability = voice.stability;
  if (voice.similarityBoost !== undefined) ttsConfig.similarity_boost = voice.similarityBoost;
  if (voice.style !== undefined) ttsConfig.style = voice.style;
  if (voice.speed !== undefined) ttsConfig.speed = voice.speed;
  if (Object.keys(ttsConfig).length > 0) conversationConfig.tts = ttsConfig;

  if (Object.keys(conversationConfig).length > 0) {
    result.conversation_config = conversationConfig;
  }

  return result;
}

const STATUS_MAP: Record<string, string> = {
  initiated: 'queued',
  'in-progress': 'in-progress',
  processing: 'in-progress',
  done: 'ended',
  failed: 'ended',
};

function elConversationToVapiShape(conv: R): R {
  const meta = (conv.metadata ?? {}) as R;
  const startUnix = meta.start_time_unix_secs as number | undefined;
  const durationSecs = meta.call_duration_secs as number | undefined;
  const rawStatus = (conv.status ?? 'done') as string;
  const status = STATUS_MAP[rawStatus] ?? 'ended';

  const startedAt = startUnix ? new Date(startUnix * 1000).toISOString() : undefined;
  const endedAt =
    startUnix && durationSecs
      ? new Date((startUnix + durationSecs) * 1000).toISOString()
      : undefined;

  const rawTranscript = (conv.transcript ?? []) as { role: string; message: string; time_in_call_secs?: number }[];
  const messages = rawTranscript.map((t) => ({
    role: t.role === 'agent' ? 'bot' : t.role,
    message: t.message,
    secondsFromStart: t.time_in_call_secs,
  }));

  const transcript = rawTranscript
    .map((t) => `${t.role === 'agent' ? 'assistant' : t.role}: ${t.message}`)
    .join('\n');

  let endedReason: string | undefined;
  if (status === 'ended') {
    const callSuccessful = conv.call_successful as string | undefined;
    endedReason = callSuccessful === 'failure' ? 'error' : 'assistant-ended-call';
  }

  return {
    id: conv.conversation_id,
    assistantId: conv.agent_id,
    status,
    endedReason,
    startedAt,
    endedAt,
    createdAt: startedAt,
    transcript,
    messages,
    customer: {},
    _provider: 'elevenlabs',
    artifact: conv.has_audio
      ? { recordingUrl: `/api/ai-caller/calls/${conv.conversation_id}/recording` }
      : undefined,
  };
}

function elPhoneToVapiShape(phone: R): R {
  return {
    id: phone.phone_number_id ?? phone.id,
    number: phone.phone_number,
    name: phone.label ?? phone.phone_number,
    provider: phone.provider ?? 'sip_trunk',
    _provider: 'elevenlabs',
  };
}

// ── Public API (same signature as vapi.ts) ──

export function listAssistants() {
  return elRequest<R>('/agents').then((data) => {
    const agents = (data.agents ?? data) as R[];
    return (Array.isArray(agents) ? agents : []).map(elAgentToVapiShape);
  });
}

export function getAssistant(id: string) {
  return elRequest<R>(`/agents/${id}`).then(elAgentToVapiShape);
}

export function createAssistant(data: R) {
  const body = vapiPayloadToElAgent(data);
  return elRequest<R>('/agents/create', {
    method: 'POST',
    body: JSON.stringify(body),
  }).then(elAgentToVapiShape);
}

export function updateAssistant(id: string, data: R) {
  const body = vapiPayloadToElAgent(data);
  return elRequest<R>(`/agents/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  }).then(elAgentToVapiShape);
}

export function deleteAssistant(id: string) {
  return elRequest<void>(`/agents/${id}`, { method: 'DELETE' });
}

// ── Phone Numbers ──

export function listPhoneNumbers() {
  return elRequest<R[] | R>('/phone-numbers').then((data) => {
    const phones = Array.isArray(data) ? data : ((data as R).phone_numbers as R[]) ?? [];
    return phones.map(elPhoneToVapiShape);
  });
}

// ── Calls (Conversations) ──

export function listCalls(params?: {
  assistantId?: string;
  limit?: number;
  createdAtGe?: string;
  createdAtLe?: string;
}) {
  const qs = new URLSearchParams();
  if (params?.assistantId) qs.set('agent_id', params.assistantId);
  if (params?.limit) qs.set('page_size', String(Math.min(params.limit, 100)));
  if (params?.createdAtGe) {
    qs.set('call_start_after_unix', String(Math.floor(new Date(params.createdAtGe).getTime() / 1000)));
  }
  if (params?.createdAtLe) {
    qs.set('call_start_before_unix', String(Math.floor(new Date(params.createdAtLe).getTime() / 1000)));
  }
  const query = qs.toString();
  return elRequest<R>(`/conversations${query ? `?${query}` : ''}`).then((data) => {
    const convos = (data.conversations ?? []) as R[];
    return convos.map((c) => {
      const startUnix = c.start_time_unix_secs as number | undefined;
      const durationSecs = c.call_duration_secs as number | undefined;
      const rawStatus = (c.status ?? 'done') as string;
      return {
        id: c.conversation_id,
        assistantId: c.agent_id,
        status: STATUS_MAP[rawStatus] ?? 'ended',
        startedAt: startUnix ? new Date(startUnix * 1000).toISOString() : undefined,
        endedAt:
          startUnix && durationSecs
            ? new Date((startUnix + durationSecs) * 1000).toISOString()
            : undefined,
        createdAt: startUnix ? new Date(startUnix * 1000).toISOString() : undefined,
        endedReason: rawStatus === 'done' ? 'assistant-ended-call' : undefined,
        customer: {},
        _provider: 'elevenlabs',
      } as R;
    });
  });
}

/** `signal` — см. одноимённый параметр в lib/vapi.ts. */
export function getCall(id: string, signal?: AbortSignal) {
  return elRequest<R>(`/conversations/${id}`, { signal }).then(elConversationToVapiShape);
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
  const dynamicVars: Record<string, string> = {};
  if (data.contactData?.contactName) dynamicVars.contact_name = data.contactData.contactName;
  if (data.contactData?.companyName) dynamicVars.company_name = data.contactData.companyName;
  if (data.contactData?.email) dynamicVars.email = data.contactData.email;
  dynamicVars.contact_greeting = data.contactData?.contactName
    ? `, ${data.contactData.contactName}`
    : '';

  const body: R = {
    agent_id: data.assistantId,
    agent_phone_number_id: data.phoneNumberId,
    to_number: data.customer.number,
  };

  if (Object.keys(dynamicVars).length > 0) {
    body.conversation_initiation_client_data = {
      dynamic_variables: dynamicVars,
    };
  }

  return elRequest<R>('/sip-trunk/outbound-call', {
    method: 'POST',
    body: JSON.stringify(body),
  }).then((resp) => ({
    id: resp.conversation_id ?? resp.sip_call_id ?? '',
    status: 'queued',
    _provider: 'elevenlabs',
  }));
}
