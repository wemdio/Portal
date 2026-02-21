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
  // ── Vapi: ElevenLabs (Vapi-specific voice IDs) ──
  {
    id: 'kate',
    label: 'Kate — Спокойная и дружелюбная',
    provider: '11labs',
    group: 'ElevenLabs',
    scope: 'vapi',
    voiceId: 'tOo2BJ74frmnPadsDNIi',
    model: 'eleven_multilingual_v2',
    stability: 0.55,
    similarityBoost: 0.8,
    style: 0.35,
    speed: 0.88,
  },
  {
    id: 'kate-turbo',
    label: 'Kate Turbo — Быстрый ответ',
    provider: '11labs',
    group: 'ElevenLabs',
    scope: 'vapi',
    voiceId: 'tOo2BJ74frmnPadsDNIi',
    model: 'eleven_turbo_v2_5',
    stability: 0.5,
    similarityBoost: 0.78,
    style: 0.3,
    speed: 0.92,
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
  // ── ElevenLabs ConvAI: Женские русские голоса ──
  {
    id: 'el-kate',
    label: 'Kate — Спокойная, естественная',
    provider: '11labs',
    group: 'Женские',
    scope: 'elevenlabs',
    voiceId: '7G0NvIkWRnU0Dqjgz13p',
    model: 'eleven_multilingual_v2',
    stability: 0.48,
    similarityBoost: 0.82,
    speed: 1.0,
  },
  {
    id: 'el-rina',
    label: 'Rina — Мягкая, выразительная',
    provider: '11labs',
    group: 'Женские',
    scope: 'elevenlabs',
    voiceId: 'ycbyWsnf4hqZgdpKHqiU',
    model: 'eleven_multilingual_v2',
    stability: 0.5,
    similarityBoost: 0.8,
    speed: 1.0,
  },
  {
    id: 'el-natalia',
    label: 'Natalia — Нежная и тёплая',
    provider: '11labs',
    group: 'Женские',
    scope: 'elevenlabs',
    voiceId: 'dHAwRJVaEPhU907QLTPW',
    model: 'eleven_multilingual_v2',
    stability: 0.5,
    similarityBoost: 0.8,
    speed: 1.0,
  },
  {
    id: 'el-victoria',
    label: 'Victoria — Энергичная, деловая',
    provider: '11labs',
    group: 'Женские',
    scope: 'elevenlabs',
    voiceId: 'FZGeNF7bE3syeQOynDKC',
    model: 'eleven_multilingual_v2',
    stability: 0.5,
    similarityBoost: 0.8,
    speed: 1.0,
  },
  {
    id: 'el-kari',
    label: 'Kari — Дружелюбная, тёплая',
    provider: '11labs',
    group: 'Женские',
    scope: 'elevenlabs',
    voiceId: 'Jbte7ht1CqapnZvc4KpK',
    model: 'eleven_multilingual_v2',
    stability: 0.5,
    similarityBoost: 0.8,
    speed: 1.0,
  },
  {
    id: 'el-alina',
    label: 'Alina — Молодая, динамичная',
    provider: '11labs',
    group: 'Женские',
    scope: 'elevenlabs',
    voiceId: 'dVRDrbP5ULGXB94se4KZ',
    model: 'eleven_multilingual_v2',
    stability: 0.5,
    similarityBoost: 0.8,
    speed: 1.0,
  },
  // ── ElevenLabs ConvAI: Мужские русские голоса ──
  {
    id: 'el-maxim',
    label: 'Maxim — Спокойный, нейтральный',
    provider: '11labs',
    group: 'Мужские',
    scope: 'elevenlabs',
    voiceId: 'HcaxAsrhw4ByUo4CBCBN',
    model: 'eleven_multilingual_v2',
    stability: 0.5,
    similarityBoost: 0.8,
    speed: 1.0,
  },
  {
    id: 'el-dmitry',
    label: 'Dmitry — Чёткий, энергичный',
    provider: '11labs',
    group: 'Мужские',
    scope: 'elevenlabs',
    voiceId: 'kwajW3Xh5svCeKU5ky2S',
    model: 'eleven_multilingual_v2',
    stability: 0.5,
    similarityBoost: 0.8,
    speed: 1.0,
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
      onNoPunctuationSeconds: 1.5,
      onNumberSeconds: 0.5,
    },
    waitSeconds: 0.3,
  },
  stopSpeakingPlan: {
    numWords: 0,
    voiceSeconds: 0.2,
    backoffSeconds: 0.8,
  },
  language: 'ru',
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
  ],
  endCallMessage: 'Спасибо за время, хорошего дня!',
  silenceTimeoutSeconds: 10,
  maxDurationSeconds: 180,
  backgroundDenoisingEnabled: true,
  backchannelingEnabled: true,
};
