'use client';

import { useState } from 'react';
import { authFetch, getAccessToken } from '@/lib/authFetch';
import {
  Plus,
  Loader2,
  Trash2,
  Edit3,
  Upload,
  ChevronDown,
  ChevronUp,
  Bot,
  Mic,
  Brain,
  X,
} from 'lucide-react';
import type { VapiAssistant, VoicePreset } from '@/types/ai-caller';
import {
  VOICE_PRESETS,
  LLM_PRESETS,
  DEFAULT_PIPELINE_SETTINGS,
} from '@/types/ai-caller';
import { CAMPAIGN_PRESETS } from '@/lib/ai-caller-prompts';
import { Pagination, usePagination } from '@/components/ai-caller/Pagination';

interface Props {
  assistants: VapiAssistant[];
  loading: boolean;
  onRefresh: () => void;
  apiBase?: string;
  provider?: 'vapi' | 'elevenlabs';
}

type FormData = {
  name: string;
  firstMessage: string;
  systemPrompt: string;
  voicePreset: string;
  llmPreset: string;
};

function defaultVoice(provider: string): string {
  return provider === 'elevenlabs' ? 'el-kate-turbo' : 'kate-turbo';
}

export function AssistantsTab({ assistants, loading, onRefresh, apiBase = '/api/ai-caller', provider = 'vapi' }: Props) {
  const voicePresets: VoicePreset[] = VOICE_PRESETS.filter(
    (v) => v.scope === provider || v.scope === 'any',
  );
  const initialForm: FormData = {
    name: '',
    firstMessage: '',
    systemPrompt: '',
    voicePreset: defaultVoice(provider),
    llmPreset: 'gpt4o-mini',
  };
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(initialForm);
  const [selectedPreset, setSelectedPreset] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { page, setPage, pageItems: pagedAssistants, totalPages, total } =
    usePagination(assistants);

  // ── Brief Upload ──

  async function handleBriefUpload(file: File) {
    setParsing(true);
    setError('');

    try {
      const token = await getAccessToken();
      const providerQuery = `?provider=${encodeURIComponent(provider)}`;
      const formData = new FormData();
      formData.append('file', file);
      if (selectedPreset) formData.append('presetId', selectedPreset);

      const res = await fetch(`${apiBase}/briefs/parse${providerQuery}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        setError('Сервер вернул некорректный ответ. Попробуйте TXT-файл или повторите позже.');
        setParsing(false);
        return;
      }

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Ошибка при парсинге брифа');
        setParsing(false);
        return;
      }

      setForm((prev) => ({
        ...prev,
        name: data.companyName
          ? `${data.personaName} - ${data.companyName}`
          : prev.name || data.personaName || '',
        systemPrompt: data.systemPrompt || prev.systemPrompt,
        firstMessage: data.firstMessage || prev.firstMessage,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setParsing(false);
    }
  }

  // ── CRUD ──

  async function saveAssistant() {
    const voice = voicePresets.find((v) => v.id === form.voicePreset) ?? voicePresets[0];
    const llm = LLM_PRESETS.find((l) => l.id === form.llmPreset) ?? LLM_PRESETS[0];

    let voiceConfig: Record<string, unknown>;

    if (voice.provider === 'playht') {
      voiceConfig = {
        provider: 'playht',
        voiceId: voice.voiceId,
        model: voice.playhtModel ?? 'Play3.0-mini',
        language: voice.language ?? 'russian',
        speed: voice.speed ?? 1.0,
        temperature: voice.temperature ?? 0.5,
        ...(voice.emotion ? { emotion: voice.emotion } : {}),
      };
    } else if (voice.provider === 'cartesia') {
      voiceConfig = {
        provider: 'cartesia',
        voiceId: voice.voiceId,
        model: voice.cartesiaModel ?? 'sonic-2',
        language: voice.cartesiaLanguage ?? 'ru',
        ...(voice.experimentalEmotion
          ? { experimentalControls: { emotion: voice.experimentalEmotion } }
          : {}),
      };
    } else {
      const isVapiElevenLabs = provider === 'vapi';
      voiceConfig = {
        provider: '11labs',
        voiceId: voice.voiceId,
        model: voice.model ?? 'eleven_turbo_v2_5',
        stability: voice.stability ?? (isVapiElevenLabs ? 0.62 : 0.55),
        similarityBoost: voice.similarityBoost ?? 0.78,
        ...(
          voice.style !== undefined
            ? { style: voice.style }
            : isVapiElevenLabs
              ? { style: 0.18 }
              : {}
        ),
        useSpeakerBoost: true,
        speed: voice.speed ?? (isVapiElevenLabs ? 0.95 : 0.95),
        ...(isVapiElevenLabs
          ? {
            cachingEnabled: false,
            language: 'ru',
            optimizeStreamingLatency: 0,
            chunkPlan: {
              enabled: true,
              minCharacters: 70,
              punctuationBoundaries: ['?', '!'],
            },
          }
          : {}),
      };
    }

    const payload: Record<string, unknown> = {
      name: form.name,
      firstMessage: form.firstMessage,
      model: {
        provider: llm.provider,
        model: llm.model,
        messages: [{ role: 'system', content: form.systemPrompt }],
        temperature: provider === 'vapi' ? 0.35 : 0.7,
      },
      voice: voiceConfig,
      language: 'ru',
      ...(provider === 'vapi' ? DEFAULT_PIPELINE_SETTINGS : {}),
    };

    setSaving(true);
    setError('');

    try {
      const url = editingId
        ? `${apiBase}/assistants/${editingId}`
        : `${apiBase}/assistants`;

      const res = await authFetch(url, {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Ошибка при сохранении');
        setSaving(false);
        return;
      }

      setShowForm(false);
      setEditingId(null);
      setForm(initialForm);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    }

    setSaving(false);
  }

  async function deleteAssistantById(id: string) {
    if (!confirm('Удалить ассистента? Это действие необратимо.')) return;

    setDeleting(id);
    try {
      await authFetch(`${apiBase}/assistants/${id}`, {
        method: 'DELETE',
      });
      onRefresh();
    } catch {
      // ignore
    }
    setDeleting(null);
  }

  async function startEdit(a: VapiAssistant) {
    setError('');
    setEditingId(a.id);
    setShowForm(true);

    let full = a;
    try {
      const res = await authFetch(`${apiBase}/assistants/${a.id}`);
      if (res.ok) {
        const data = await res.json();
        if (data.assistant) full = data.assistant as VapiAssistant;
      }
    } catch { /* use partial data */ }

    const voiceId = full.voice?.voiceId;
    const voiceProvider = full.voice?.provider;
    const voicePreset = voicePresets.find(
      (v) => v.voiceId === voiceId && (!voiceProvider || v.provider === voiceProvider),
    )?.id ?? defaultVoice(provider);
    const modelName = full.model?.model;
    const llmPreset = LLM_PRESETS.find((l) => l.model === modelName)?.id ?? 'gpt4o-mini';
    const systemPrompt =
      full.model?.messages?.find((m) => m.role === 'system')?.content ?? '';

    setForm({
      name: full.name || '',
      firstMessage: full.firstMessage || '',
      systemPrompt,
      voicePreset,
      llmPreset,
    });
  }

  function cancelForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(initialForm);
    setError('');
  }

  // ── Render ──

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        <span className="ml-2 text-gray-500">Загрузка...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          {assistants.length} {assistants.length === 1 ? 'ассистент' : 'ассистентов'}
        </p>
        <button
          onClick={() => {
            setForm(initialForm);
            setEditingId(null);
            setShowForm(true);
            setError('');
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Создать ассистента
        </button>
      </div>

      {/* Create / Edit Form */}
      {showForm && (
        <div className="rounded-2xl border border-blue-200 bg-blue-50/30 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">
              {editingId ? 'Редактировать' : 'Новый ассистент'}
            </h3>
            <button onClick={cancelForm} className="text-gray-400 hover:text-gray-600">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Preset + Brief Upload */}
          {!editingId && (
            <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
              <label className="block text-sm font-medium text-gray-700">
                Сценарий звонка (опционально)
              </label>
              <p className="text-xs text-gray-400">
                Выберите готовый сценарий + загрузите бриф — AI автоматически создаст промпт. Или пропустите и напишите промпт вручную.
              </p>
              <div className="space-y-2">
                {CAMPAIGN_PRESETS.map((p) => (
                  <label
                    key={p.id}
                    className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                      selectedPreset === p.id
                        ? 'border-blue-400 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="assistantPreset"
                      checked={selectedPreset === p.id}
                      onChange={() => setSelectedPreset(p.id)}
                      className="mt-0.5"
                    />
                    <div>
                      <span className="text-sm font-medium text-gray-900">{p.label}</span>
                      <p className="text-xs text-gray-500 mt-0.5">{p.description}</p>
                    </div>
                  </label>
                ))}
                <label
                  className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                    selectedPreset === ''
                      ? 'border-blue-400 bg-blue-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="assistantPreset"
                    checked={selectedPreset === ''}
                    onChange={() => setSelectedPreset('')}
                    className="mt-0.5"
                  />
                  <div>
                    <span className="text-sm font-medium text-gray-900">Без сценария</span>
                    <p className="text-xs text-gray-500 mt-0.5">Загрузить бриф для свободной генерации или написать промпт вручную</p>
                  </div>
                </label>
              </div>

              <div className="flex items-center gap-3 pt-1">
                <label className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 cursor-pointer transition-colors">
                  <Upload className="h-4 w-4" />
                  {parsing ? 'Обработка...' : 'Загрузить бриф (PDF/TXT/DOCX)'}
                  <input
                    type="file"
                    accept=".pdf,.txt,.md,.docx"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleBriefUpload(file);
                      e.target.value = '';
                    }}
                    disabled={parsing}
                  />
                </label>
                {parsing && <Loader2 className="h-4 w-4 animate-spin text-blue-500" />}
              </div>
            </div>
          )}

          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Название ассистента
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value.slice(0, 40) }))}
              maxLength={40}
              placeholder="Евгения - Хлеб.online"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
            <span className="text-xs text-gray-400 mt-0.5">{form.name.length}/40</span>
          </div>

          {/* First Message */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Первое сообщение (при звонке)
            </label>
            <textarea
              value={form.firstMessage}
              onChange={(e) =>
                setForm((f) => ({ ...f, firstMessage: e.target.value }))
              }
              rows={2}
              placeholder="Здравствуйте! Меня зовут Евгения, компания Хлеб-онлайн..."
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* System Prompt */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Системный промпт
            </label>
            <textarea
              value={form.systemPrompt}
              onChange={(e) =>
                setForm((f) => ({ ...f, systemPrompt: e.target.value }))
              }
              rows={10}
              placeholder="Ты — Евгения Перминова, менеджер компании..."
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* Voice & LLM row */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Голос
              </label>
              <select
                value={form.voicePreset}
                onChange={(e) =>
                  setForm((f) => ({ ...f, voicePreset: e.target.value }))
                }
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              >
                {Array.from(new Set(voicePresets.map((v) => v.group))).map((group) => (
                  <optgroup key={group} label={group}>
                    {voicePresets.filter((v) => v.group === group).map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Модель AI
              </label>
              <select
                value={form.llmPreset}
                onChange={(e) =>
                  setForm((f) => ({ ...f, llmPreset: e.target.value }))
                }
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              >
                {LLM_PRESETS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label} — {l.description}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={saveAssistant}
              disabled={saving || !form.name.trim() || !form.systemPrompt.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {editingId ? 'Сохранить' : 'Создать'}
            </button>
            <button
              onClick={cancelForm}
              className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"
            >
              Отмена
            </button>
          </div>
        </div>
      )}

      {/* Assistants List */}
      {assistants.length === 0 && !showForm ? (
        <div className="text-center py-16 text-gray-400">
          <Bot className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p className="text-sm">Нет ассистентов. Создайте первого.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {pagedAssistants.map((a) => {
            const isExpanded = expandedId === a.id;
            const matchedVoice = voicePresets.find(
              (v) => v.voiceId === a.voice?.voiceId && (!a.voice?.provider || v.provider === a.voice.provider),
            );
            const llmPreset = LLM_PRESETS.find(
              (l) => l.model === a.model?.model,
            );
            const systemPrompt =
              a.model?.messages?.find((m) => m.role === 'system')?.content ?? '';

            return (
              <div
                key={a.id}
                className="rounded-2xl border border-gray-200 bg-white overflow-hidden"
              >
                {/* Header */}
                <div
                  className="flex items-center justify-between px-6 py-4 cursor-pointer hover:bg-gray-50 transition-colors"
                  onClick={() => setExpandedId(isExpanded ? null : a.id)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Bot className="h-5 w-5 text-blue-500 flex-shrink-0" />
                    <div className="min-w-0">
                      <h4 className="font-medium text-gray-900 truncate">
                        {a.name || 'Без имени'}
                      </h4>
                      <div className="flex items-center gap-3 text-xs text-gray-400 mt-0.5">
                        <span className="inline-flex items-center gap-1">
                          <Mic className="h-3 w-3" />
                          {matchedVoice?.label.split(' —')[0] || a.voice?.voiceId || '—'}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Brain className="h-3 w-3" />
                          {llmPreset?.label || a.model?.model || '—'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        startEdit(a);
                      }}
                      className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                      title="Редактировать"
                    >
                      <Edit3 className="h-4 w-4" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteAssistantById(a.id);
                      }}
                      disabled={deleting === a.id}
                      className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                      title="Удалить"
                    >
                      {deleting === a.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </button>
                    {isExpanded ? (
                      <ChevronUp className="h-4 w-4 text-gray-400" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-gray-400" />
                    )}
                  </div>
                </div>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="border-t border-gray-100 px-6 py-4 bg-gray-50/50 space-y-3">
                    <div>
                      <span className="text-xs font-medium text-gray-500 uppercase">
                        Первое сообщение
                      </span>
                      <p className="text-sm text-gray-700 mt-0.5">
                        {a.firstMessage || '—'}
                      </p>
                    </div>
                    {systemPrompt && (
                      <div>
                        <span className="text-xs font-medium text-gray-500 uppercase">
                          Системный промпт
                        </span>
                        <pre className="text-xs text-gray-600 mt-1 whitespace-pre-wrap max-h-40 overflow-y-auto bg-white rounded-lg border border-gray-200 p-3">
                          {systemPrompt.length > 800
                            ? systemPrompt.slice(0, 800) + '...'
                            : systemPrompt}
                        </pre>
                      </div>
                    )}
                    <div className="flex gap-6 text-xs text-gray-400">
                      <span>ID: {a.id}</span>
                      {a.createdAt && (
                        <span>
                          Создан:{' '}
                          {new Date(a.createdAt).toLocaleDateString('ru-RU')}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <Pagination
            page={page}
            totalPages={totalPages}
            total={total}
            onPageChange={setPage}
            unit="ассистентов"
          />
        </div>
      )}
    </div>
  );
}
