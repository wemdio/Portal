'use client';

import { useEffect, useRef, useState } from 'react';
import { extractTextFromFile, fetchKnowledgeBase, saveKnowledgeBase } from './api';

const ACCEPT = '.pdf,.docx,.txt,.md';

type UploadField = 'brief' | 'productFacts' | 'exampleCase';

/**
 * Поле базы знаний с опциональной кнопкой загрузки файла: текст извлекается
 * на сервере и заменяет содержимое textarea — дальше сотрудник правит
 * и сохраняет штатной кнопкой.
 */
function KbField({
  label,
  value,
  onChange,
  rows,
  placeholder,
  uploadField,
  uploadingField,
  onUpload,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
  placeholder: string;
  uploadField: UploadField;
  uploadingField: UploadField | null;
  onUpload: (field: UploadField, file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const uploading = uploadingField === uploadField;

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-zinc-700">{label}</label>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="text-xs text-blue-600 hover:text-blue-500 disabled:opacity-50"
        >
          {uploading ? 'Читаю файл...' : 'Загрузить файлом'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onUpload(uploadField, file);
            e.target.value = '';
          }}
        />
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="mt-1 w-full rounded-lg border border-zinc-300 p-2 text-sm"
        placeholder={placeholder}
      />
    </div>
  );
}

export function KnowledgeBaseForm({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [brief, setBrief] = useState('');
  const [productFacts, setProductFacts] = useState('');
  const [toneNotes, setToneNotes] = useState('');
  const [exampleCase, setExampleCase] = useState('');
  const [instantlyAccountId, setInstantlyAccountId] = useState('main');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploadingField, setUploadingField] = useState<UploadField | null>(null);
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

  const handleUpload = async (field: UploadField, file: File) => {
    setUploadingField(field);
    setError(null);
    try {
      const text = await extractTextFromFile(file);
      if (field === 'brief') setBrief(text);
      if (field === 'productFacts') setProductFacts(text);
      if (field === 'exampleCase') setExampleCase(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось прочитать файл');
    } finally {
      setUploadingField(null);
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

      <p className="mt-1 text-xs text-zinc-400">Файлы: PDF, DOCX, TXT, MD до 20 МБ. Текст из файла заменяет поле — проверьте и сохраните.</p>

      <KbField
        label="Бриф"
        value={brief}
        onChange={setBrief}
        rows={4}
        placeholder="О чём продукт, для кого, чем полезен"
        uploadField="brief"
        uploadingField={uploadingField}
        onUpload={handleUpload}
      />

      <KbField
        label="Факты о продукте"
        value={productFacts}
        onChange={setProductFacts}
        rows={5}
        placeholder="Возможности продукта и кейсы, которые можно упоминать в письмах"
        uploadField="productFacts"
        uploadingField={uploadingField}
        onUpload={handleUpload}
      />

      <label className="block text-sm font-medium text-zinc-700 mt-4">Тон и ограничения</label>
      <textarea
        value={toneNotes}
        onChange={(e) => setToneNotes(e.target.value)}
        rows={3}
        className="mt-1 w-full rounded-lg border border-zinc-300 p-2 text-sm"
        placeholder="Как обращаться, чего избегать, стиль подписи"
      />

      <KbField
        label="Пример хорошего письма"
        value={exampleCase}
        onChange={setExampleCase}
        rows={5}
        placeholder="Один реальный пример письма как ориентир по стилю"
        uploadField="exampleCase"
        uploadingField={uploadingField}
        onUpload={handleUpload}
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
