'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { tgOutreachFetch } from '@/lib/tgOutreach/fetcher';
import type { ProxyType, TgOutreachTag } from '@/lib/tgOutreach/types';

function parseProxyString(raw: string): {
  ip: string; port: string; login: string; password: string; type: ProxyType;
} | null {
  const value = raw.trim();
  if (!value) return null;

  if (value.includes('://')) {
    try {
      const url = new URL(value);
      const proto = url.protocol.replace(':', '').toUpperCase();
      const type: ProxyType = proto === 'SOCKS5' ? 'SOCKS5' : proto === 'SOCKS4' ? 'SOCKS4' : 'HTTP';
      if (!url.hostname || !url.port) return null;
      return {
        ip: url.hostname,
        port: url.port,
        login: decodeURIComponent(url.username || ''),
        password: decodeURIComponent(url.password || ''),
        type,
      };
    } catch {
      return null;
    }
  }

  const parts = value.split(':').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const [ip, portStr, login = '', password = ''] = parts;
  if (!ip || !portStr || isNaN(Number(portStr))) return null;
  return { ip, port: portStr, login, password, type: 'HTTP' };
}

interface Props {
  allTags: TgOutreachTag[];
  onClose: () => void;
  onCreated: () => void;
}

export function AddProxyModal({ allTags, onClose, onCreated }: Props) {
  const [quickPaste, setQuickPaste] = useState('');
  const [ip, setIp] = useState('');
  const [port, setPort] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [type, setType] = useState<ProxyType>('HTTP');
  const [notes, setNotes] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parseSuccess, setParseSuccess] = useState(false);

  const handleQuickPaste = (value: string) => {
    setQuickPaste(value);
    setParseSuccess(false);
    const parsed = parseProxyString(value);
    if (parsed) {
      setIp(parsed.ip);
      setPort(parsed.port);
      setLogin(parsed.login);
      setPassword(parsed.password);
      setType(parsed.type);
      setError(null);
      setParseSuccess(true);
    }
  };

  const handleSubmit = async () => {
    if (!ip.trim() || !port.trim()) {
      setError('IP и Порт обязательны');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await tgOutreachFetch('/proxies', {
        method: 'POST',
        json: { ip: ip.trim(), port: Number(port), login, password, type, notes, tag_ids: selectedTags },
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
          <h2 className="text-lg font-semibold text-gray-900">Добавить прокси</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div>
            <label className="block text-sm text-gray-600 mb-1">
              Вставьте строку прокси целиком (необязательно). Поддерживаемые форматы:
            </label>
            <p className="text-xs text-gray-400 mb-1.5">
              http://логин:пароль@хост:порт &nbsp;·&nbsp; socks5://логин:пароль@хост:порт &nbsp;·&nbsp; хост:порт:логин:пароль
            </p>
            <input
              value={quickPaste}
              onChange={(e) => handleQuickPaste(e.target.value)}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text');
                if (text) {
                  e.preventDefault();
                  handleQuickPaste(text);
                }
              }}
              placeholder="http://user:pass@host:port"
              className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-1 ${
                parseSuccess
                  ? 'border-green-300 bg-green-50 focus:border-green-400 focus:ring-green-400'
                  : 'border-gray-200 focus:border-blue-400 focus:ring-blue-400'
              }`}
            />
            {parseSuccess && (
              <p className="mt-1 text-xs text-green-600">Прокси распознана, поля заполнены автоматически</p>
            )}
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center" aria-hidden="true">
              <div className="w-full border-t border-gray-200" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-white px-2 text-xs text-gray-400">или заполните вручную</span>
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-600 mb-1">
              IP адрес (только IP4, IP6 не поддерживаются!). Обычно формат такой: 190.123.22.11 или isp2.domen.com
            </label>
            <input
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="127.0.0.1"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-600 mb-1">
              Порт. Порт это набор цифр, например: 2334 или 43567
            </label>
            <input
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
              placeholder="80"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-600 mb-1">
              Логин. Если не знаете, что сюда указать - спросите в техподдержке поставщика прокси.
            </label>
            <input
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              placeholder="root"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-600 mb-1">
              Пароль. Если не знаете, что сюда указать - спросите в техподдержке поставщика прокси.
            </label>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="123456"
              type="password"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-600 mb-1">
              Тип. Тип прокси виден в личном кабинете поставщика прокси.
            </label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as ProxyType)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            >
              <option value="HTTP">HTTP</option>
              <option value="SOCKS5">SOCKS5</option>
              <option value="SOCKS4">SOCKS4</option>
            </select>
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
              placeholder="..."
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
      </div>
    </div>
  );
}
