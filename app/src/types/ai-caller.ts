/* ──────────────────────────────────────────────
   AI Caller – провайдер-агностичные типы
   (совместимы с Vapi и ElevenLabs ConvAI)
   ────────────────────────────────────────────── */

// ── Vapi Assistant ──

export interface VapiVoice {
  provider: string;
  voiceId: string;
  model?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  speed?: number;
}

export interface VapiModel {
  provider: string;
  model: string;
  messages?: { role: string; content: string }[];
  temperature?: number;
}

export interface VapiAssistant {
  id: string;
  orgId?: string;
  name?: string;
  model?: VapiModel;
  voice?: VapiVoice;
  firstMessage?: string;
  firstMessageMode?: string;
  language?: string;
  createdAt?: string;
  updatedAt?: string;
  // pipeline
  transcriber?: { provider: string; model: string; language?: string };
  startSpeakingPlan?: Record<string, unknown>;
  stopSpeakingPlan?: Record<string, unknown>;
  // call control
  endCallFunctionEnabled?: boolean;
  endCallPhrases?: string[];
  endCallMessage?: string;
  silenceTimeoutSeconds?: number;
  maxDurationSeconds?: number;
  backgroundSound?: string;
  backgroundDenoisingEnabled?: boolean;
  backchannelingEnabled?: boolean;
}

// ── Vapi Phone Number ──

export interface VapiPhoneNumber {
  id: string;
  orgId?: string;
  number?: string;
  name?: string;
  provider?: string;
  createdAt?: string;
}

// ── Vapi Call ──

export type CallStatus =
  | 'queued'
  | 'ringing'
  | 'in-progress'
  | 'forwarding'
  | 'ended';

export interface VapiCallMessage {
  role: 'assistant' | 'user' | 'system' | 'bot' | 'tool_calls' | 'tool_call_result';
  message?: string;
  content?: string;
  time?: number;
  endTime?: number;
  secondsFromStart?: number;
  duration?: number;
}

export interface VapiCall {
  id: string;
  orgId?: string;
  assistantId?: string;
  phoneNumberId?: string;
  customer?: { number?: string };
  type?: string;
  status?: CallStatus;
  endedReason?: string;
  transcript?: string;
  messages?: VapiCallMessage[];
  startedAt?: string;
  endedAt?: string;
  createdAt?: string;
  cost?: number;
  costBreakdown?: Record<string, number>;
  // assistant snapshot at call time
  assistant?: VapiAssistant;
}

// ── UI types ──

export type AiCallerTab = 'test-call' | 'assistants' | 'campaigns' | 'analytics' | 'history';

export type VoiceProvider = '11labs' | 'playht' | 'cartesia';

export type VoiceScope = 'vapi' | 'elevenlabs' | 'any';

// Voximplant-only provider type is no longer needed (v3 removed)

export interface VoicePreset {
  id: string;
  label: string;
  provider: VoiceProvider;
  voiceId: string;
  group: string;
  scope: VoiceScope;
  // ElevenLabs
  model?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speed?: number;
  // PlayHT
  playhtModel?: string;
  temperature?: number;
  emotion?: string;
  language?: string;
  // Cartesia
  cartesiaModel?: string;
  cartesiaLanguage?: string;
  experimentalEmotion?: string;
}

export interface LlmPreset {
  id: string;
  label: string;
  provider: string;
  model: string;
  description: string;
}

// ── Presets (constant data) ──

export const VOICE_PRESETS: VoicePreset[] = [
  // ── Vapi: ElevenLabs Turbo 2.5 (рекомендован для ConvAI) ──
  {
    id: 'kate-turbo',
    label: 'Kate Turbo — Быстрый, естественный (рекомендуется)',
    provider: '11labs',
    group: 'ElevenLabs',
    scope: 'vapi',
    voiceId: 'tOo2BJ74frmnPadsDNIi',
    model: 'eleven_turbo_v2_5',
    stability: 0.62,
    similarityBoost: 0.78,
    style: 0.18,
    speed: 0.95,
  },
  {
    id: 'kate-expressive',
    label: 'Kate Expressive — Эмоциональный, живой',
    provider: '11labs',
    group: 'ElevenLabs',
    scope: 'vapi',
    voiceId: 'tOo2BJ74frmnPadsDNIi',
    model: 'eleven_turbo_v2_5',
    stability: 0.58,
    similarityBoost: 0.72,
    style: 0.25,
    speed: 0.95,
  },
  {
    id: 'kate-v2',
    label: 'Kate Multilingual v2 — Богатая интонация (медленнее)',
    provider: '11labs',
    group: 'ElevenLabs',
    scope: 'vapi',
    voiceId: 'tOo2BJ74frmnPadsDNIi',
    model: 'eleven_multilingual_v2',
    stability: 0.5,
    similarityBoost: 0.75,
    speed: 0.95,
  },
  // ── Vapi: Cartesia ──
  {
    id: 'cartesia-ru-1',
    label: 'Cartesia Русский 1',
    provider: 'cartesia',
    group: 'Cartesia',
    scope: 'vapi',
    voiceId: '779673f3-895f-4935-b6b5-b031dc78b319',
    cartesiaModel: 'sonic-2',
    cartesiaLanguage: 'ru',
  },
  {
    id: 'cartesia-ru-4',
    label: 'Cartesia Русский 2',
    provider: 'cartesia',
    group: 'Cartesia',
    scope: 'vapi',
    voiceId: '642014de-c0e3-4133-adc0-36b5309c23e6',
    cartesiaModel: 'sonic-2',
    cartesiaLanguage: 'ru',
  },
  {
    id: 'cartesia-ru-1-s3',
    label: 'Cartesia Русский 1 (sonic-3)',
    provider: 'cartesia',
    group: 'Cartesia sonic-3',
    scope: 'vapi',
    voiceId: '779673f3-895f-4935-b6b5-b031dc78b319',
    cartesiaModel: 'sonic-3',
    cartesiaLanguage: 'ru',
  },
  {
    id: 'cartesia-ru-4-s3',
    label: 'Cartesia Русский 2 (sonic-3)',
    provider: 'cartesia',
    group: 'Cartesia sonic-3',
    scope: 'vapi',
    voiceId: '642014de-c0e3-4133-adc0-36b5309c23e6',
    cartesiaModel: 'sonic-3',
    cartesiaLanguage: 'ru',
  },
  // ── ElevenLabs ConvAI: Turbo 2.5 рекомендован для ConvAI (3x быстрее для русского) ──
  {
    id: 'el-kate-turbo',
    label: 'Kate Turbo — Стабильный, ровный (рекомендуется)',
    provider: '11labs',
    group: 'Женские',
    scope: 'elevenlabs',
    voiceId: '7G0NvIkWRnU0Dqjgz13p',
    model: 'eleven_turbo_v2_5',
    stability: 0.55,
    similarityBoost: 0.75,
    speed: 0.95,
  },
  {
    id: 'el-kate-expressive',
    label: 'Kate Expressive — Чуть живее',
    provider: '11labs',
    group: 'Женские',
    scope: 'elevenlabs',
    voiceId: '7G0NvIkWRnU0Dqjgz13p',
    model: 'eleven_turbo_v2_5',
    stability: 0.5,
    similarityBoost: 0.7,
    speed: 0.95,
  },
  {
    id: 'el-kate-v2',
    label: 'Kate Multilingual v2 — Богатая интонация (медленнее)',
    provider: '11labs',
    group: 'Женские',
    scope: 'elevenlabs',
    voiceId: '7G0NvIkWRnU0Dqjgz13p',
    model: 'eleven_multilingual_v2',
    stability: 0.5,
    similarityBoost: 0.75,
    speed: 0.95,
  },
];

export const LLM_PRESETS: LlmPreset[] = [
  {
    id: 'gpt4o-mini',
    label: 'GPT-4o mini',
    provider: 'openai',
    model: 'gpt-4o-mini',
    description: 'Быстрый и дешёвый — для обзвонов',
  },
  {
    id: 'gpt4o',
    label: 'GPT-4o',
    provider: 'openai',
    model: 'gpt-4o',
    description: 'Мультимодальный, хороший баланс',
  },
  {
    id: 'gpt41',
    label: 'GPT-4.1',
    provider: 'openai',
    model: 'gpt-4.1',
    description: 'Быстрый и качественный',
  },
  {
    id: 'claude-sonnet',
    label: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    description: 'Отличный для диалогов, чуть медленнее',
  },
  {
    id: 'gemini-pro',
    label: 'Gemini 2.5 Pro',
    provider: 'google',
    model: 'gemini-2.5-pro',
    description: 'Мощная модель Google',
  },
];

// ── Provider-agnostic aliases ──

export type AiAssistant = VapiAssistant;
export type AiPhoneNumber = VapiPhoneNumber;
export type AiCall = VapiCall;
export type AiCallMessage = VapiCallMessage;

export const DEFAULT_PIPELINE_SETTINGS = {
  transcriber: {
    provider: 'deepgram',
    model: 'nova-3',
    language: 'ru',
  },
  startSpeakingPlan: {
    transcriptionEndpointingPlan: {
      onPunctuationSeconds: 0.1,
      onNoPunctuationSeconds: 1.2,
      onNumberSeconds: 0.4,
    },
    waitSeconds: 0.25,
  },
  stopSpeakingPlan: {
    numWords: 0,
    voiceSeconds: 0.2,
    backoffSeconds: 0.6,
  },
  language: 'ru',
  firstMessageMode: 'assistant-waits-for-user',
  backgroundSound: 'off',
  endCallFunctionEnabled: true,
  endCallPhrases: [
    'до свидания',
    'всего доброго',
    'хорошего дня',
    'спасибо, пока',
    'нет, спасибо',
    'не интересует',
    'не интересно',
    'не звоните',
    'не надо',
    'отстаньте',
  ],
  endCallMessage: 'Хорошо, спасибо за ваше время! Всего доброго!',
  silenceTimeoutSeconds: 10,
  maxDurationSeconds: 180,
  backgroundDenoisingEnabled: true,
  backchannelingEnabled: true,
};
