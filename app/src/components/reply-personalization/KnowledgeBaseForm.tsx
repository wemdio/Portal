'use client';

import { useEffect, useState } from 'react';
import { fetchKnowledgeBase, saveKnowledgeBase } from './api';

export function KnowledgeBaseForm({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [brief, setBrief] = useState('');
  const [productFacts, setProductFacts] = useState('');
  const [toneNotes, setToneNotes] = useState('');
  const [exampleCase, setExampleCase] = useState('');
  const [instantlyAccountId, setInstantlyAccountId] = useState('main');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchKnowledgeBase(projectId)
      .then(({ kb }) => {
        if (!kb) return;
        setBrief(kb.brief);
        setProductFacts(kb.productFacts);
        setToneNotes(kb.toneNotes);
        setExampleCase(kb.exampleCase);
        setInstantlyAccountId(kb.instantlyAccountId);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить'))
      .finally(() => setLoading(false));
  }, [projectId]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveKnowledgeBase(projectId, { brief, productFacts, toneNotes, exampleCase, instantlyAccountId });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-6 text-sm text-zinc-500">Загрузка...</div>;

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-zinc-900">База знаний проекта</h2>
        <button type="button" onClick={onClose} className="text-sm text-zinc-500 hover:text-zinc-700">
          Назад к письмам
        </button>
      </div>

      <label className="block text-sm font-medium text-zinc-700 mt-4">Бриф</label>
      <textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        rows={4}
        className="mt-1 w-full rounded-lg border border-zinc-300 p-2 text-sm"
        placeholder="О чём продукт, для кого, чем полезен"
      />

      <label className="block text-sm font-medium text-zinc-700 mt-4">Факты о продукте</label>
      <textarea
        value={productFacts}
        onChange={(e) => setProductFacts(e.target.value)}
        rows={5}
        className="mt-1 w-full rounded-lg border border-zinc-300 p-2 text-sm"
        placeholder="Возможности продукта и кейсы, которые можно упоминать в письмах"
      />

      <label className="block text-sm font-medium text-zinc-700 mt-4">Тон и ограничения</label>
      <textarea
        value={toneNotes}
        onChange={(e) => setToneNotes(e.target.value)}
        rows={3}
        className="mt-1 w-full rounded-lg border border-zinc-300 p-2 text-sm"
        placeholder="Как обращаться, чего избегать, стиль подписи"
      />

      <label className="block text-sm font-medium text-zinc-700 mt-4">Пример хорошего письма</label>
      <textarea
        value={exampleCase}
        onChange={(e) => setExampleCase(e.target.value)}
        rows={5}
        className="mt-1 w-full rounded-lg border border-zinc-300 p-2 text-sm"
        placeholder="Один реальный пример письма как ориентир по стилю"
      />

      <label className="block text-sm font-medium text-zinc-700 mt-4">Instantly-аккаунт проекта</label>
      <input
        value={instantlyAccountId}
        onChange={(e) => setInstantlyAccountId(e.target.value)}
        className="mt-1 w-full rounded-lg border border-zinc-300 p-2 text-sm"
        placeholder="main"
      />
      <p className="mt-1 text-xs text-zinc-500">
        Оставьте «main», если проект на основном Instantly-аккаунте. Для проекта на отдельном
        аккаунте (например Okdesk) — id из конфигурации INSTANTLY_ACCOUNTS_JSON.
      </p>

      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {saving ? 'Сохранение...' : 'Сохранить'}
        </button>
        {saved ? <span className="text-sm text-green-600">Сохранено</span> : null}
      </div>
    </div>
  );
}
