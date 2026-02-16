'use client';

import { useState, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
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
import type { VapiAssistant } from '@/types/ai-caller';
import {
  VOICE_PRESETS,
  LLM_PRESETS,
  DEFAULT_PIPELINE_SETTINGS,
} from '@/types/ai-caller';

interface Props {
  assistants: VapiAssistant[];
  loading: boolean;
  onRefresh: () => void;
}

type FormData = {
  name: string;
  firstMessage: string;
  systemPrompt: string;
  voicePreset: string;
  llmPreset: string;
};

const INITIAL_FORM: FormData = {
  name: '',
  firstMessage: '',
  systemPrompt: '',
  voicePreset: 'kate',
  llmPreset: 'gpt41',
};

export function AssistantsTab({ assistants, loading, onRefresh }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(INITIAL_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? '';
  }, []);

  // ── Brief Upload ──

  async function handleBriefUpload(file: File) {
    setParsing(true);
    setError('');

    try {
      const token = await getToken();
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/ai-caller/briefs/parse', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

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
    }

    setParsing(false);
  }

  // ── CRUD ──

  async function saveAssistant() {
    const voice = VOICE_PRESETS.find((v) => v.id === form.voicePreset) ?? VOICE_PRESETS[0];
    const llm = LLM_PRESETS.find((l) => l.id === form.llmPreset) ?? LLM_PRESETS[0];

    const payload: Record<string, unknown> = {
      name: form.name,
      firstMessage: form.firstMessage,
      model: {
        provider: llm.provider,
        model: llm.model,
        messages: [{ role: 'system', content: form.systemPrompt }],
        temperature: 0.7,
      },
      voice: {
        provider: '11labs',
        voiceId: voice.voiceId,
        model: voice.model,
        stability: voice.stability,
        similarityBoost: voice.similarityBoost,
        style: voice.style,
        useSpeakerBoost: true,
        speed: voice.speed,
      },
      ...DEFAULT_PIPELINE_SETTINGS,
    };

    setSaving(true);
    setError('');

    try {
      const token = await getToken();
      const url = editingId
        ? `/api/ai-caller/assistants/${editingId}`
        : '/api/ai-caller/assistants';

      const res = await fetch(url, {
        method: editingId ? 'PATCH' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
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
      setForm(INITIAL_FORM);
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
      const token = await getToken();
      await fetch(`/api/ai-caller/assistants/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      onRefresh();
    } catch {
      // ignore
    }
    setDeleting(null);
  }

  function startEdit(a: VapiAssistant) {
    const voiceId = a.voice?.voiceId;
    const voicePreset = VOICE_PRESETS.find((v) => v.voiceId === voiceId)?.id ?? 'kate';
    const modelName = a.model?.model;
    const llmPreset = LLM_PRESETS.find((l) => l.model === modelName)?.id ?? 'gpt41';
    const systemPrompt =
      a.model?.messages?.find((m) => m.role === 'system')?.content ?? '';

    setForm({
      name: a.name || '',
      firstMessage: a.firstMessage || '',
      systemPrompt,
      voicePreset,
      llmPreset,
    });
    setEditingId(a.id);
    setShowForm(true);
    setError('');
  }

  function cancelForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(INITIAL_FORM);
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
            setForm(INITIAL_FORM);
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

          {/* Brief Upload */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Загрузить бриф (PDF/TXT) — AI создаст промпт
            </label>
            <div className="flex items-center gap-3">
              <label className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 cursor-pointer transition-colors">
                <Upload className="h-4 w-4" />
                {parsing ? 'Обработка...' : 'Выбрать файл'}
                <input
                  type="file"
                  accept=".pdf,.txt,.md,.doc,.docx"
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
                {VOICE_PRESETS.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
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
          {assistants.map((a) => {
            const isExpanded = expandedId === a.id;
            const voicePreset = VOICE_PRESETS.find(
              (v) => v.voiceId === a.voice?.voiceId,
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
                          {voicePreset?.label.split(' —')[0] || a.voice?.voiceId || '—'}
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
        </div>
      )}
    </div>
  );
}
