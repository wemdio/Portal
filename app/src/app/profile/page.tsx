'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useIsTma } from '@/lib/useIsTma';
import { logAudit, logError } from '@/lib/loggerClient';
import { normalizePublicAvatarUrl } from '@/lib/publicAvatarUrl';
import { ROLE_LABELS } from '@/lib/roles';
import type { UserRole } from '@/types';

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  avatar_url: string | null;
  role: string | null;
};

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Неизвестная ошибка';
}

function getInitial(value: string) {
  const trimmed = value.trim();
  return (trimmed[0] ?? '?').toUpperCase();
}

async function getImageSize(file: File): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error('Invalid image'));
      img.src = url;
    });
    return size;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function ProfilePage() {
  const isTma = useIsTma();

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  const [userId, setUserId] = useState<string | null>(null);
  const [authEmail, setAuthEmail] = useState<string>('');

  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [avatarRefreshKey, setAvatarRefreshKey] = useState(0);
  const [signedAvatarUrl, setSignedAvatarUrl] = useState<string | null>(null);
  const [avatarTriedSigned, setAvatarTriedSigned] = useState(false);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPassword2, setNewPassword2] = useState('');

  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const displayName = useMemo(() => {
    const name = fullName.trim();
    if (name) return name;
    const mail = email.trim() || authEmail.trim();
    if (mail) return mail.split('@')[0] || mail;
    return 'User';
  }, [authEmail, email, fullName]);

  const roleLabel = useMemo(() => {
    const r = (profile?.role ?? '').trim();
    if (!r) return '';
    const key = r as UserRole;
    return ROLE_LABELS[key] ?? r;
  }, [profile?.role]);

  const avatarUrl = useMemo(() => {
    const base = normalizePublicAvatarUrl(profile?.avatar_url) ?? '';
    if (signedAvatarUrl) return signedAvatarUrl;
    if (!base) return '';
    const join = base.includes('?') ? '&' : '?';
    return `${base}${join}v=${avatarRefreshKey}`;
  }, [profile?.avatar_url, avatarRefreshKey, signedAvatarUrl]);

  async function fetchSignedAvatarUrl() {
    if (avatarTriedSigned) return;
    setAvatarTriedSigned(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return;
      const res = await fetch('/api/profile/avatar/signed', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { readUrl?: unknown };
      if (typeof data.readUrl === 'string' && data.readUrl.trim()) {
        setSignedAvatarUrl(data.readUrl.trim());
      }
    } catch {
      // ignore, fallback to initials
    }
  }

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const u = session?.user;
        if (!mounted) return;

        if (!u) {
          setLoading(false);
          return;
        }

        setUserId(u.id);
        setAuthEmail(u.email ?? '');

        const { data, error } = await supabase
          .from('profiles')
          .select('id, email, full_name, avatar_url, role')
          .eq('id', u.id)
          .single();

        if (error) throw error;

        const row = (data as ProfileRow) ?? null;
        setProfile(row);
        setFullName(row?.full_name ?? '');
        setEmail(row?.email ?? (u.email ?? ''));
      } catch (err) {
        void logError('profile.load.failed', err);
        setError(getErrorMessage(err));
      } finally {
        setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  async function handleSaveProfile() {
    if (!userId) return;
    const nextFullName = fullName.trim();
    const nextEmail = email.trim().toLowerCase();

    setSaving(true);
    setError('');
    setMessage('');

    try {
      const { error: profileErr, data: updated } = await supabase
        .from('profiles')
        .update({
          full_name: nextFullName || null,
          email: nextEmail || null,
        })
        .eq('id', userId)
        .select('id, email, full_name, avatar_url, role')
        .single();

      if (profileErr) throw profileErr;

      setProfile((updated as ProfileRow) ?? null);
      setMessage('Профиль сохранён');
      void logAudit('profile.update.success', 'Profile updated', { userId });

      const currentAuthEmail = authEmail.trim().toLowerCase();
      if (nextEmail && nextEmail !== currentAuthEmail) {
        const { error: authErr } = await supabase.auth.updateUser({ email: nextEmail });
        if (authErr) throw authErr;
        setAuthEmail(nextEmail);
        setMessage('Email обновлён');
        void logAudit('profile.email.update.requested', 'Email update requested', { userId });
      }
    } catch (err) {
      void logError('profile.update.failed', err);
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleChangePassword() {
    const pw = newPassword.trim();
    const pw2 = newPassword2.trim();

    setError('');
    setMessage('');

    if (pw.length < 8) {
      setError('Пароль должен быть минимум 8 символов');
      return;
    }
    if (pw.length > 72) {
      setError('Пароль слишком длинный (максимум 72 символа)');
      return;
    }
    if (pw !== pw2) {
      setError('Пароли не совпадают');
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) throw error;
      setNewPassword('');
      setNewPassword2('');
      setMessage('Пароль обновлён');
      void logAudit('profile.password.update.success', 'Password updated', { userId: userId ?? undefined });
    } catch (err) {
      void logError('profile.password.update.failed', err);
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleAvatarFile(file: File) {
    if (!userId) return;
    if (!file.type.startsWith('image/')) {
      setError('Выберите изображение');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Файл слишком большой (максимум 5MB)');
      return;
    }

    setUploadingAvatar(true);
    setError('');
    setMessage('');

    try {
      const { width, height } = await getImageSize(file);
      if (width !== 512 || height !== 512) {
        setError(`Нужен аватар ровно 512×512 px. Сейчас: ${width}×${height}. Подрежьте/уменьшите и загрузите ещё раз.`);
        return;
      }

      const nameParts = file.name.split('.');
      const extRaw = nameParts.length > 1 ? (nameParts.at(-1) ?? '') : '';
      const ext = (extRaw || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';

      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not authenticated');

      const presignRes = await fetch('/api/profile/avatar/presign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ contentType: file.type, ext }),
      });

      if (!presignRes.ok) {
        const data = await presignRes.json().catch(() => null);
        throw new Error((typeof data?.error === 'string' && data.error) ? data.error : 'Не удалось получить ссылку для загрузки');
      }

      const presigned = (await presignRes.json()) as { uploadUrl: string; publicUrl: string };

      const upload = await fetch(presigned.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': file.type,
        },
        body: file,
      });

      if (!upload.ok) {
        throw new Error(`S3 upload failed: ${upload.status}`);
      }

      const publicUrl = presigned.publicUrl;

      const { error: profileErr, data: updated } = await supabase
        .from('profiles')
        .update({ avatar_url: publicUrl })
        .eq('id', userId)
        .select('id, email, full_name, avatar_url, role')
        .single();

      if (profileErr) throw profileErr;

      setProfile((updated as ProfileRow) ?? null);
      setAvatarRefreshKey(Date.now());
      setMessage('Аватар обновлён');
      void logAudit('profile.avatar.update.success', 'Avatar updated', { userId });
    } catch (err) {
      void logError('profile.avatar.update.failed', err);
      setError(getErrorMessage(err));
    } finally {
      setUploadingAvatar(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-500">Загрузка...</div>
      </div>
    );
  }

  return (
    <div className={`max-w-3xl mx-auto ${isTma ? 'space-y-4' : 'space-y-6'}`}>
      <div className="flex items-start gap-4">
        <div className="relative">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt="Аватар"
              className="h-24 w-24 rounded-3xl object-cover ring-1 ring-black/5"
              onError={() => {
                void fetchSignedAvatarUrl();
              }}
            />
          ) : (
            <div className="h-24 w-24 rounded-3xl bg-gray-100 ring-1 ring-black/5 flex items-center justify-center text-gray-700 text-3xl font-bold">
              {getInitial(displayName)}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleAvatarFile(file);
            }}
          />
        </div>

        <div className="min-w-0 flex-1 flex flex-col min-h-[96px]">
          <h1 className={`${isTma ? 'text-xl' : 'text-2xl'} font-bold tracking-tight text-gray-900`}>
            Профиль
          </h1>
          <p className="mt-1 text-sm text-gray-500 truncate">
            {displayName}{roleLabel ? ` · ${roleLabel}` : ''}
          </p>
          <div className="mt-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={uploadingAvatar}
              onClick={() => fileInputRef.current?.click()}
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {uploadingAvatar ? 'Загрузка...' : 'Сменить аватар'}
            </button>
            <span className="text-xs text-gray-500">
              512×512 px (квадрат), до 5MB
            </span>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {message}
        </div>
      )}

      <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="border-b border-gray-100 bg-gray-50/60 px-5 py-4">
          <h2 className="text-sm font-semibold text-gray-900">Профиль</h2>
          <p className="mt-1 text-xs text-gray-500">Имя и email для отображения в портале</p>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Имя</label>
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Иван Иванов"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              autoComplete="name"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              autoComplete="email"
              inputMode="email"
            />
          </div>

          <div className="pt-1">
            <button
              type="button"
              onClick={() => void handleSaveProfile()}
              disabled={saving}
              className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Сохранение...' : 'Сохранить'}
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="border-b border-gray-100 bg-gray-50/60 px-5 py-4">
          <h2 className="text-sm font-semibold text-gray-900">Пароль</h2>
          <p className="mt-1 text-xs text-gray-500">Смена пароля для входа</p>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Новый пароль</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                autoComplete="new-password"
                placeholder="Минимум 8 символов"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Повторите пароль</label>
              <input
                type="password"
                value={newPassword2}
                onChange={(e) => setNewPassword2(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                autoComplete="new-password"
                placeholder="Повтор"
              />
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={() => void handleChangePassword()}
              disabled={saving || !newPassword.trim() || !newPassword2.trim()}
              className="inline-flex items-center justify-center rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-50"
            >
              {saving ? 'Сохранение...' : 'Сменить пароль'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

