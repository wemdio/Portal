'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2, Upload, X } from 'lucide-react';
import {
  extractTextFromFile,
  fetchKnowledgeBase,
  saveKnowledgeBase,
  type GlobalKnowledgeBaseDto,
} from './api';

const ACCEPT = '.pdf,.docx,.txt,.md';

const CONTROL_CLASS =
  'w-full rounded-lg border border-zinc-300 bg-white px-3.5 py-2.5 text-sm leading-relaxed text-zinc-900 transition-colors focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20';

type UploadField = 'productFacts' | 'exampleCase' | 'localBrief';

/** Сколько символов брифа/глобальной настройки показывать до «Показать полностью». */
const PREVIEW_CHARS = 600;

/**
 * Поле базы знаний с опциональной кнопкой загрузки файла: текст извлекается
 * на сервере и заменяет содержимое textarea — дальше сотрудник правит
 * и сохраняет штатной кнопкой.
 */
function KbField({
  label,
  hint,
  value,
  onChange,
  rows,
  placeholder,
  uploadField,
  uploadingField,
  onUpload,
  belowLabel,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
  placeholder: string;
  uploadField?: UploadField;
  uploadingField?: UploadField | null;
  onUpload?: (field: UploadField, file: File) => void;
  /** Пометка между заголовком и полем — про глобальную настройку студии. */
  belowLabel?: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const uploading = uploadField != null && uploadingField === uploadField;

  return (
    <div>
      <div className="mb-2 flex items-end justify-between gap-3">
        <div>
          <label className="block text-sm font-medium text-zinc-900">{label}</label>
          {hint ? <p className="mt-0.5 text-xs text-zinc-500">{hint}</p> : null}
        </div>
        {uploadField && onUpload ? (
          <>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-blue-600 transition-colors hover:bg-zinc-100 disabled:opacity-50"
            >
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {uploading ? 'Читаю файл…' : 'Из файла'}
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
          </>
        ) : null}
      </div>
      {belowLabel}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className={`${CONTROL_CLASS} resize-y`}
        placeholder={placeholder}
      />
    </div>
  );
}

/**
 * Пометка у поля с глобальной настройкой студии: пока поле проекта пусто —
 * показывает глобальное значение (оно и используется), после заполнения —
 * предупреждает, что приоритет у значения проекта.
 */
function GlobalOverrideNote({ globalValue, projectValue }: { globalValue: string; projectValue: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!globalValue.trim()) return null;

  if (projectValue.trim()) {
    return (
      <p className="mb-2 text-xs text-zinc-500">
        Глобальная настройка студии переопределена — используется это значение проекта.
      </p>
    );
  }

  return (
    <div className="mb-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2">
      <p className="text-xs text-blue-800">
        Поле не заполнено — используется глобальная настройка студии. Заполните, чтобы задать
        свою для этого проекта (она приоритетнее).
      </p>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-blue-700">
        {expanded ? globalValue : globalValue.slice(0, PREVIEW_CHARS)}
        {!expanded && globalValue.length > PREVIEW_CHARS ? '…' : ''}
      </p>
      {globalValue.length > PREVIEW_CHARS ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 text-xs font-medium text-blue-600 transition-colors hover:text-blue-500"
        >
          {expanded ? 'Свернуть' : 'Показать полностью'}
        </button>
      ) : null}
    </div>
  );
}

export function KnowledgeBaseForm({
  projectId,
  onClose,
  onSaved,
}: {
  projectId: string;
  onClose: () => void;
  /** Дергается после успешного сохранения — родитель обновляет бейджи/списки. */
  onSaved?: () => void;
}) {
  const [projectBrief, setProjectBrief] = useState('');
  // Запасной бриф: заполняется здесь, в карточку проекта не уходит.
  const [localBrief, setLocalBrief] = useState('');
  const [briefExpanded, setBriefExpanded] = useState(false);
  const [productFacts, setProductFacts] = useState('');
  const [toneNotes, setToneNotes] = useState('');
  const [exampleCase, setExampleCase] = useState('');
  const [globalKb, setGlobalKb] = useState<GlobalKnowledgeBaseDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploadingField, setUploadingField] = useState<UploadField | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchKnowledgeBase(projectId)
      .then(({ kb, projectBrief: brief, global }) => {
        setProjectBrief(brief);
        setGlobalKb(global);
        if (!kb) return;
        setProductFacts(kb.productFacts);
        setLocalBrief(kb.localBrief);
        setToneNotes(kb.toneNotes);
        setExampleCase(kb.exampleCase);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить'))
      .finally(() => setLoading(false));
  }, [projectId]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveKnowledgeBase(projectId, { productFacts, toneNotes, exampleCase, localBrief });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
      onSaved?.();
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
      if (field === 'productFacts') setProductFacts(text);
      if (field === 'exampleCase') setExampleCase(text);
      if (field === 'localBrief') setLocalBrief(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось прочитать файл');
    } finally {
      setUploadingField(null);
    }
  };

  return (
    <div className="flex max-h-[88vh] min-h-0 flex-col">
      <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-7 pb-5 pt-6">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">База знаний проекта</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Из этого ИИ собирает ответы лидам. Текст можно подтянуть из PDF, DOCX, TXT или MD до 20 МБ — он заменит поле.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть"
          className="-mr-2 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 px-7 py-16 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загрузка…
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-7 py-6">
            {/* Бриф из карточки проекта — источник истины, его тут только
                показываем. Когда карточка пуста, отвечать лиду всё равно
                нужно сегодня, поэтому рядом лежит запасное поле: оно уходит
                в генерацию и НЕ пишется обратно в карточку. Жёлтая пометка
                остаётся намеренно — напоминает, где бриф должен жить, чтобы
                запасное поле не стало тихо основным местом. */}
            {projectBrief ? (
              <div>
                <div className="mb-2">
                  <label className="block text-sm font-medium text-zinc-900">Бриф проекта</label>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    Подтягивается из карточки проекта и редактируется там — здесь только для просмотра
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3.5 py-2.5">
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-700">
                    {briefExpanded ? projectBrief : projectBrief.slice(0, PREVIEW_CHARS)}
                    {!briefExpanded && projectBrief.length > PREVIEW_CHARS ? '…' : ''}
                  </p>
                  {projectBrief.length > PREVIEW_CHARS ? (
                    <button
                      type="button"
                      onClick={() => setBriefExpanded((v) => !v)}
                      className="mt-2 text-xs font-medium text-blue-600 transition-colors hover:text-blue-500"
                    >
                      {briefExpanded ? 'Свернуть' : 'Показать полностью'}
                    </button>
                  ) : null}
                </div>
                {localBrief.trim() ? (
                  <p className="mt-2 text-xs text-zinc-500">
                    В базе знаний сохранён свой бриф, но используется бриф из карточки проекта — он главнее.
                  </p>
                ) : null}
              </div>
            ) : (
              <KbField
                label="Бриф проекта"
                hint="В карточке проекта его нет — заполните здесь, и генерация возьмёт этот текст"
                value={localBrief}
                onChange={setLocalBrief}
                rows={6}
                placeholder="Что за продукт, кому продаём, чем отличаемся, какие возражения закрываем…"
                uploadField="localBrief"
                uploadingField={uploadingField}
                onUpload={handleUpload}
                belowLabel={
                  <p className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm leading-relaxed text-amber-700">
                    В карточке проекта нет брифа — заполните его там, когда дойдут руки: это основной
                    источник для всего портала. Текст ниже сохранится только в этой базе знаний,
                    в карточку проекта он не попадёт.
                  </p>
                }
              />
            )}

            <KbField
              label="Факты о продукте"
              hint="Возможности и кейсы, которые можно упоминать в письмах"
              value={productFacts}
              onChange={setProductFacts}
              rows={5}
              placeholder="Цифры, клиенты, результаты внедрений…"
              uploadField="productFacts"
              uploadingField={uploadingField}
              onUpload={handleUpload}
            />

            <KbField
              label="Тон и ограничения"
              hint="Как обращаться, чего избегать, стиль подписи"
              value={toneNotes}
              onChange={setToneNotes}
              rows={3}
              placeholder="На «вы», без давления, подпись — имя и должность…"
              belowLabel={
                globalKb ? <GlobalOverrideNote globalValue={globalKb.toneNotes} projectValue={toneNotes} /> : null
              }
            />

            <KbField
              label="Пример хорошего письма"
              hint="Один реальный пример как ориентир по стилю"
              value={exampleCase}
              onChange={setExampleCase}
              rows={5}
              placeholder="Вставьте письмо, которое хорошо сработало…"
              uploadField="exampleCase"
              uploadingField={uploadingField}
              onUpload={handleUpload}
              belowLabel={
                globalKb ? <GlobalOverrideNote globalValue={globalKb.exampleCase} projectValue={exampleCase} /> : null
              }
            />
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-zinc-200 px-7 py-4">
            {error ? <p className="mr-auto text-sm text-red-600">{error}</p> : null}
            {saved ? <span className="text-sm text-green-600">Сохранено</span> : null}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {saving ? 'Сохранение…' : 'Сохранить'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
