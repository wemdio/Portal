'use client';

import { useState } from 'react';
import { X, FolderOpen, FileJson } from 'lucide-react';
import { tgOutreachFetch } from '@/lib/tgOutreach/fetcher';
import type { AccountFormat, TgOutreachTag } from '@/lib/tgOutreach/types';

interface Props {
  allTags: TgOutreachTag[];
  onClose: () => void;
  onCreated: () => void;
}

export function AddAccountModal({ allTags, onClose, onCreated }: Props) {
  const [step, setStep] = useState<'format' | 'details'>('format');
  const [format, setFormat] = useState<AccountFormat>('tdata');
  const [phone, setPhone] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [sessionString, setSessionString] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFormatSelect = (f: AccountFormat) => {
    setFormat(f);
    setStep('details');
  };

  const handleSubmit = async () => {
    setSaving(true);
    setError(null);
    try {
      await tgOutreachFetch('/accounts', {
        method: 'POST',
        json: {
          format,
          session_data: { session_string: sessionString },
          phone,
          first_name: firstName,
          last_name: lastName,
          notes,
          tag_ids: selectedTags,
        },
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setSaving(false);
    }
  };

  const toggleTag = (id: string) => {
    setSelectedTags((prev) => prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-lg rounded-xl border border-gray-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">
            {step === 'format' ? 'Выберите формат аккаунтов' : 'Добавить аккаунт'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        {step === 'format' ? (
          <div className="space-y-3 px-6 py-5">
            <button
              onClick={() => handleFormatSelect('tdata')}
              className="flex w-full items-start gap-4 rounded-xl border border-gray-200 p-4 text-left hover:border-blue-300 hover:bg-blue-50/50 transition-colors"
            >
              <span className="mt-0.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white whitespace-nowrap">
                Из папки tdata
              </span>
              <p className="text-sm text-gray-600">
                Это родной для Телеграма формат аккаунтов, поэтому в сервисе они работают дольше и делают больше действий.
                Старайтесь работать именно с такими аккаунтами.
              </p>
            </button>

            <button
              onClick={() => handleFormatSelect('session_json')}
              className="flex w-full items-start gap-4 rounded-xl border border-gray-200 p-4 text-left hover:border-blue-300 hover:bg-blue-50/50 transition-colors"
            >
              <span className="mt-0.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white whitespace-nowrap">
                Session + JSON
              </span>
              <p className="text-sm text-gray-600">
                У этого формата аккаунтов нет четкого стандарта, и продавцы регистрируют их, кто как хочет.
                Из-за такого подхода аккаунты могут быстро умирать.
              </p>
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-4 px-6 py-5">
              <div className="flex items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
                {format === 'tdata' ? (
                  <><FolderOpen className="h-4 w-4" /> Формат: tdata</>
                ) : (
                  <><FileJson className="h-4 w-4" /> Формат: Session + JSON</>
                )}
                <button
                  onClick={() => setStep('format')}
                  className="ml-auto text-xs text-blue-600 hover:text-blue-700"
                >
                  Изменить
                </button>
              </div>

              <div>
                <label className="block text-sm text-gray-600 mb-1">Session String</label>
                <textarea
                  value={sessionString}
                  onChange={(e) => setSessionString(e.target.value)}
                  placeholder="Вставьте session string..."
                  rows={3}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono resize-y focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </div>

              <div>
                <label className="block text-sm text-gray-600 mb-1">Телефон</label>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+7..."
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Имя</label>
                  <input
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Фамилия</label>
                  <input
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                </div>
              </div>

              {allTags.length > 0 && (
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Теги</label>
                  <div className="flex flex-wrap gap-1.5">
                    {allTags.map((tag) => (
                      <button
                        key={tag.id}
                        onClick={() => toggleTag(tag.id)}
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                          selectedTags.includes(tag.id)
                            ? 'ring-2 ring-offset-1 ring-blue-400'
                            : 'opacity-60 hover:opacity-100'
                        }`}
                        style={{ backgroundColor: tag.color + '20', color: tag.color }}
                      >
                        {tag.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm text-gray-600 mb-1">Заметки</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm resize-y focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </div>

              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {error}
                </div>
              )}
            </div>

            <div className="border-t border-gray-100 px-6 py-4">
              <button
                onClick={handleSubmit}
                disabled={saving}
                className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {saving ? 'Сохранение...' : 'Отправить'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
