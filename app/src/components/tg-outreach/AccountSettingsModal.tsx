'use client';

import { useEffect, useState, useRef } from 'react';
import { X, RefreshCw, Shuffle } from 'lucide-react';
import { tgOutreachFetch } from '@/lib/tgOutreach/fetcher';
import type { TgOutreachAccount, TgOutreachProxy, TgOutreachTag } from '@/lib/tgOutreach/types';

type Tab = 'basic' | 'limits' | 'additional';

interface Props {
  account: TgOutreachAccount;
  allTags: TgOutreachTag[];
  onClose: () => void;
  onSaved: () => void;
}

export function AccountSettingsModal({ account, allTags, onClose, onSaved }: Props) {
  const [tab, setTab] = useState<Tab>('basic');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proxies, setProxies] = useState<TgOutreachProxy[]>([]);
  const [loadingProxies, setLoadingProxies] = useState(false);
  const [proxyLoadError, setProxyLoadError] = useState<string | null>(null);

  // Basic fields
  const [firstName, setFirstName] = useState(account.first_name);
  const [lastName, setLastName] = useState(account.last_name);
  const [username, setUsername] = useState(account.username);
  const [bio, setBio] = useState(account.bio);
  const [accountPrice, setAccountPrice] = useState(String(account.account_price));
  const [notes, setNotes] = useState(account.notes);
  const [avatarUrl, setAvatarUrl] = useState(account.avatar_url);
  const [replaceAvatar, setReplaceAvatar] = useState(false);
  const [selectedProxyId, setSelectedProxyId] = useState<string>(account.proxy_id ?? '');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Limits
  const [maxInvites, setMaxInvites] = useState(String(account.max_invites_per_day));
  const [maxMessages, setMaxMessages] = useState(String(account.max_messages_per_day));
  const [maxChatMessages, setMaxChatMessages] = useState(String(account.max_chat_messages_per_day));
  const [maxContactAdds, setMaxContactAdds] = useState(String(account.max_contact_adds_per_day));
  const [maxStoryViews, setMaxStoryViews] = useState(String(account.max_story_views_per_day));
  const [maxNeurocommentPosts, setMaxNeurocommentPosts] = useState(String(account.max_neurocomment_posts_per_day));
  const [controlLimit, setControlLimit] = useState(account.control_tg_request_limit);

  // Tags
  const [selectedTags, setSelectedTags] = useState<string[]>(account.tags?.map((t) => t.id) ?? []);

  const toggleTag = (id: string) => {
    setSelectedTags((prev) => prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]);
  };

  useEffect(() => {
    let cancelled = false;

    const loadProxies = async () => {
      setLoadingProxies(true);
      setProxyLoadError(null);
      try {
        const data = await tgOutreachFetch<{ items?: TgOutreachProxy[] }>('/proxies');
        if (cancelled) return;
        setProxies(Array.isArray(data.items) ? data.items : []);
      } catch (err) {
        if (cancelled) return;
        setProxyLoadError(err instanceof Error ? err.message : 'Не удалось загрузить список прокси');
      } finally {
        if (!cancelled) setLoadingProxies(false);
      }
    };

    void loadProxies();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAvatarUpload = async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await tgOutreachFetch<{ avatar_url: string }>(`/accounts/${account.id}/avatar`, {
        method: 'POST',
        body: formData,
      });
      setAvatarUrl(res.avatar_url);
    } catch {
      // silent
    }
  };

  const handleCheckUsername = async () => {
    // Placeholder: would check username availability via MTProto
    alert(`Юзернейм "${username}" — проверка недоступна в текущей версии`);
  };

  const handleGenerateUsername = () => {
    const adjectives = ['swift', 'bright', 'cool', 'dark', 'epic', 'fast', 'gold', 'iron'];
    const nouns = ['hawk', 'wolf', 'star', 'fire', 'rock', 'wind', 'rain', 'bolt'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const num = Math.floor(Math.random() * 9000) + 1000;
    setUsername(`${adj}_${noun}${num}`);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await tgOutreachFetch(`/accounts/${account.id}`, {
        method: 'PATCH',
        json: {
          first_name: firstName,
          last_name: lastName,
          username,
          bio,
          account_price: Number(accountPrice) || 0,
          notes,
          proxy_id: selectedProxyId || null,
          max_invites_per_day: Number(maxInvites) || 0,
          max_messages_per_day: Number(maxMessages) || 0,
          max_chat_messages_per_day: Number(maxChatMessages) || 0,
          max_contact_adds_per_day: Number(maxContactAdds) || 0,
          max_story_views_per_day: Number(maxStoryViews) || 0,
          max_neurocomment_posts_per_day: Number(maxNeurocommentPosts) || 0,
          control_tg_request_limit: controlLimit,
          tag_ids: selectedTags,
        },
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'basic', label: 'Основное' },
    { id: 'limits', label: 'Лимиты' },
    { id: 'additional', label: 'Дополнительно' },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-lg max-h-[90vh] flex flex-col rounded-xl border border-gray-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">
            Настройки аккаунта {firstName} {lastName}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-6 border-b border-gray-100 px-6 shrink-0">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-zinc-500 hover:text-zinc-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {tab === 'basic' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Прокси</label>
                <select
                  value={selectedProxyId}
                  onChange={(e) => setSelectedProxyId(e.target.value)}
                  disabled={loadingProxies}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:bg-gray-50 disabled:text-gray-400"
                >
                  <option value="">Без прокси</option>
                  {account.proxy_id && !proxies.some((p) => p.id === account.proxy_id) ? (
                    <option value={account.proxy_id}>
                      Текущий прокси недоступен в списке ({account.proxy?.ip}:{account.proxy?.port})
                    </option>
                  ) : null}
                  {proxies.map((proxy) => (
                    <option key={proxy.id} value={proxy.id}>
                      {proxy.ip}:{proxy.port} ({proxy.type}){proxy.notes ? ` — ${proxy.notes}` : ''}
                    </option>
                  ))}
                </select>
                {loadingProxies ? (
                  <p className="mt-1 text-xs text-gray-500">Загружаем список прокси...</p>
                ) : null}
                {proxyLoadError ? (
                  <p className="mt-1 text-xs text-red-600">{proxyLoadError}</p>
                ) : null}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Имя</label>
                <input
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Фамилия</label>
                <input
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Логин</label>
                <div className="flex gap-2">
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  <button
                    onClick={handleCheckUsername}
                    className="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-600 transition-colors"
                  >
                    <RefreshCw className="h-4 w-4 inline mr-1" />
                    Проверить
                  </button>
                  <button
                    onClick={handleGenerateUsername}
                    className="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-600 transition-colors"
                  >
                    <Shuffle className="h-4 w-4 inline mr-1" />
                    Сгенерировать
                  </button>
                </div>
                <p className="mt-1 text-xs text-emerald-600">
                  Минимальная длина — 5 символов. Можно использовать a-z, 0-9 и _.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Аватар (старайтесь для каждого аккаунта загружать уникальную аватарку)
                </label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleAvatarUpload(file);
                  }}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
                >
                  Choose File
                </button>

                <label className="flex items-center gap-2 mt-2 text-sm text-gray-600">
                  <input
                    type="checkbox"
                    checked={replaceAvatar}
                    onChange={(e) => setReplaceAvatar(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  Заменить имеющийся аватар
                </label>

                {avatarUrl && (
                  <img src={avatarUrl} alt="" className="mt-2 h-14 w-14 rounded-lg object-cover" />
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">О себе</label>
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm resize-y focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Цена аккаунта для расчета стоимости действия
                </label>
                <input
                  value={accountPrice}
                  onChange={(e) => setAccountPrice(e.target.value)}
                  type="number"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Заметки</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm resize-y focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </div>
            </>
          )}

          {tab === 'limits' && (
            <>
              <LimitField
                label="Максимум приглашений в сутки (в первые 7 дней старайтесь делать не больше 3х действий)"
                value={maxInvites}
                onChange={setMaxInvites}
              />
              <LimitField
                label="Максимум сообщений в сутки (в первые 7 дней старайтесь делать не больше 3х действий)"
                value={maxMessages}
                onChange={setMaxMessages}
              />
              <LimitField
                label="Максимум сообщений в чаты в сутки"
                value={maxChatMessages}
                onChange={setMaxChatMessages}
              />
              <LimitField
                label="Максимум добавлений номеров в контакты (считаются успешные и неуспешные)"
                value={maxContactAdds}
                onChange={setMaxContactAdds}
              />
              <LimitField
                label="Максимум отметок в сториз в сутки"
                value={maxStoryViews}
                onChange={setMaxStoryViews}
              />
              <LimitField
                label="Максимум постов нейрокомментинга в сутки"
                value={maxNeurocommentPosts}
                onChange={setMaxNeurocommentPosts}
              />

              <label className="flex items-center gap-2 pt-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={controlLimit}
                  onChange={(e) => setControlLimit(e.target.checked)}
                  className="rounded border-gray-300"
                />
                В задачах контролировать лимит на количество обращений к Телеграм
              </label>
            </>
          )}

          {tab === 'additional' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Теги</label>
                <div className="flex flex-wrap gap-1.5">
                  {allTags.length === 0 && (
                    <p className="text-sm text-gray-400">Нет доступных тегов</p>
                  )}
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

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Формат</label>
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">
                  {account.format === 'tdata' ? 'tdata' : 'Session + JSON'}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Телефон</label>
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">
                  {account.phone || '—'}
                </div>
              </div>
            </>
          )}

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-100 px-6 py-4 shrink-0">
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Сохранение...' : 'Отправить'}
          </button>
        </div>
      </div>
    </div>
  );
}

function LimitField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-sm text-gray-600 mb-1">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
        type="text"
        inputMode="numeric"
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
      />
    </div>
  );
}
