/* ──────────────────────────────────────────────
   AI Caller – типы для интеграции с Vapi.ai
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

export interface VoicePreset {
  id: string;
  label: string;
  voiceId: string;
  model: string;
  stability: number;
  similarityBoost: number;
  style: number;
  speed: number;
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
  {
    id: 'kate',
    label: 'Kate — Спокойная и дружелюбная',
    voiceId: 'tOo2BJ74frmnPadsDNIi',
    model: 'eleven_multilingual_v2',
    stability: 0.55,
    similarityBoost: 0.8,
    style: 0.35,
    speed: 0.88,
  },
  {
    id: 'mariia',
    label: 'Mariia_R — Тёплая и мягкая',
    voiceId: 'RxZqkSWQzJ6HCRFMiyqe',
    model: 'eleven_multilingual_v2',
    stability: 0.5,
    similarityBoost: 0.75,
    style: 0.3,
    speed: 0.88,
  },
  {
    id: 'nadia',
    label: 'Nadia — Молодая и энергичная',
    voiceId: 'GBv7mTt0atIp3Br8iCZE',
    model: 'eleven_multilingual_v2',
    stability: 0.5,
    similarityBoost: 0.75,
    style: 0.4,
    speed: 0.9,
  },
  {
    id: 'ekaterina',
    label: 'Ekaterina — Деловая и уверенная',
    voiceId: 'UhKFMrGGBHcGHwwt3X1R',
    model: 'eleven_multilingual_v2',
    stability: 0.55,
    similarityBoost: 0.8,
    style: 0.25,
    speed: 0.88,
  },
];

export const LLM_PRESETS: LlmPreset[] = [
  {
    id: 'gpt41',
    label: 'GPT-4.1',
    provider: 'openai',
    model: 'gpt-4.1',
    description: 'Быстрый и качественный — рекомендуется',
  },
  {
    id: 'gpt4o',
    label: 'GPT-4o',
    provider: 'openai',
    model: 'gpt-4o',
    description: 'Мультимодальный, хороший баланс',
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
