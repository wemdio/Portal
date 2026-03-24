'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { UserRole, UserProfile } from '@/types';
import { ALL_ROLES, ROLE_LABELS, isAdmin, getCurrentUserRole } from '@/lib/roles';
import { logAudit, logError } from '@/lib/loggerClient';
import { useIsTma } from '@/lib/useIsTma';
import { normalizePublicAvatarUrl } from '@/lib/publicAvatarUrl';
import { Check, ChevronDown, ChevronUp, MoreVertical } from 'lucide-react';
import { ALL_TOOL_IDS, TOOLS_CONFIG, ALL_NAV_TAB_IDS, NAV_TABS_CONFIG } from '@/lib/toolsRegistry';

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Неизвестная ошибка';
}

function UserAvatar({ user, signedUrl }: { user: UserProfile; signedUrl?: string | null }) {
  const [failedUrls, setFailedUrls] = useState<Set<string>>(new Set());
  const publicUrl = normalizePublicAvatarUrl(user.avatar_url);
  const avatarUrl = (signedUrl && !failedUrls.has(signedUrl)) ? signedUrl
    : (publicUrl && !failedUrls.has(publicUrl)) ? publicUrl
    : null;
  const initial = (user.full_name || user.email || '?').charAt(0).toUpperCase();

  return (
    <div className="h-10 w-10 rounded-full flex items-center justify-center overflow-hidden bg-blue-600 flex-shrink-0">
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={avatarUrl}
          src={avatarUrl}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          onError={() => setFailedUrls((prev) => new Set(prev).add(avatarUrl))}
        />
      ) : (
        <span className="text-white font-medium">{initial}</span>
      )}
    </div>
  );
}

export default function UsersPage() {
  const isTma = useIsTma();
  const [currentUserRole, setCurrentUserRole] = useState<UserRole | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newUser, setNewUser] = useState({ email: '', password: '', role: 'technician' as UserRole, full_name: '' });
  
  const [saving, setSaving] = useState(false);
  
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [resettingUserId, setResettingUserId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetting, setResetting] = useState(false);
  const [revealPassword, setRevealPassword] = useState(false);

  const [actionModalUserId, setActionModalUserId] = useState<string | null>(null);
  const [actionModalOrigin, setActionModalOrigin] = useState<{ x: number; y: number } | null>(null);
  const [actionModalLoadingUserId, setActionModalLoadingUserId] = useState<string | null>(null);
  const [modalFlyIn, setModalFlyIn] = useState(false);
  const [modalRole, setModalRole] = useState<UserRole | null>(null);
  const [toolVisibility, setToolVisibility] = useState<Record<string, boolean>>({});
  const [saveSuccessMessage, setSaveSuccessMessage] = useState<string | null>(null);

  const [clientCampaigns, setClientCampaigns] = useState<string[]>([]);
  const [clientCampaignInput, setClientCampaignInput] = useState('');

  type SortColumn = 'name' | 'email' | 'role';
  type SortDir = 'asc' | 'desc';
  const [sortBy, setSortBy] = useState<SortColumn>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const [avatarSignedUrls, setAvatarSignedUrls] = useState<Record<string, string>>({});

  const fetchUsers = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*');

      if (error) throw error;
      setUsers((data as UserProfile[]) || []);
    } catch (err: unknown) {
      void logError('admin.users.fetch.failed', err);
      setError(getErrorMessage(err) || 'Ошибка загрузки пользователей');
    }
  }, []);

  const checkAccess = useCallback(async () => {
    try {
      const role = await getCurrentUserRole();
      setCurrentUserRole(role);

      const { data: { session } } = await supabase.auth.getSession();
      setCurrentUserId(session?.user?.id ?? null);

      if (!isAdmin(role)) {
        setError('Доступ запрещен. Только администраторы могут управлять пользователями.');
        setLoading(false);
        return;
      }

      await fetchUsers();
      setLoading(false);
    } catch (err: unknown) {
      void logError('admin.users.access.check.failed', err);
      setError(getErrorMessage(err));
      setLoading(false);
    }
  }, [fetchUsers]);

  const getAccessToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  }, []);

  const apiFetch = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const token = await getAccessToken();
    if (!token) throw new Error('Not authenticated');

    const res = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        const msg = typeof parsed?.error === 'string' ? parsed.error : '';
        throw new Error(msg || text || `Request failed: ${res.status}`);
      } catch {
        throw new Error(text || `Request failed: ${res.status}`);
      }
    }

    return (await res.json()) as T;
  }, [getAccessToken]);

  async function handleResetPassword() {
    if (!resettingUserId) return;
    const pw = newPassword.trim();
    if (pw.length < 8) {
      setError('Пароль должен быть минимум 8 символов');
      return;
    }
    if (pw.length > 72) {
      setError('Пароль слишком длинный (максимум 72 символа)');
      return;
    }

    setResetting(true);
    setError('');
    try {
      await apiFetch<{ ok: true }>(`/api/admin/users/${resettingUserId}/password`, {
        method: 'POST',
        body: JSON.stringify({ password: pw }),
      });
      void logAudit('admin.users.password.update.success', 'User password updated (client)', {
        targetUserId: resettingUserId,
      });
      setResettingUserId(null);
      setNewPassword('');
      setRevealPassword(false);
    } catch (err: unknown) {
      void logError('admin.users.password.update.failed', err, { targetUserId: resettingUserId });
      setError(getErrorMessage(err) || 'Ошибка обновления пароля');
    } finally {
      setResetting(false);
    }
  }

  function generatePassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
    const len = 14;
    let out = '';
    for (let i = 0; i < len; i += 1) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)] ?? '';
    }
    setNewPassword(out);
    setRevealPassword(true);
  }

  useEffect(() => {
    void checkAccess();
  }, [checkAccess]);

  useEffect(() => {
    if (!actionModalUserId) {
      setActionModalOrigin(null);
      setSaveSuccessMessage(null);
    }
  }, [actionModalUserId]);

  useEffect(() => {
    if (!saveSuccessMessage) return;
    const t = setTimeout(() => setSaveSuccessMessage(null), 3500);
    return () => clearTimeout(t);
  }, [saveSuccessMessage]);

  async function openActionModal(user: UserProfile, origin: { x: number; y: number }) {
    setActionModalLoadingUserId(user.id);
    setError('');
    try {
      const [toolsRes, accessRes] = await Promise.all([
        apiFetch<{ visibility: Record<string, boolean> }>(
          `/api/admin/users/${user.id}/tools`
        ),
        user.role === 'client'
          ? apiFetch<{ rows: Array<{ resource_type: string; resource_id: string }> }>(
              `/api/admin/users/${user.id}/client-access`
            )
          : Promise.resolve({ rows: [] as Array<{ resource_type: string; resource_id: string }> }),
      ]);
      setToolVisibility(toolsRes.visibility ?? {});
      const campaigns = accessRes.rows.filter((r) => r.resource_type === 'campaign').map((r) => r.resource_id);
      setClientCampaigns(campaigns);
      setModalRole(user.role ?? null);
      setActionModalOrigin(origin);
      setActionModalUserId(user.id);
      setModalFlyIn(false);
      setActionModalLoadingUserId(null);
      setTimeout(() => setModalFlyIn(true), 20);
    } catch {
      setToolVisibility({});
      setClientCampaigns([]);
      setModalRole(user.role ?? null);
      setActionModalOrigin(origin);
      setActionModalUserId(user.id);
      setModalFlyIn(false);
      setActionModalLoadingUserId(null);
      setTimeout(() => setModalFlyIn(true), 20);
    }
  }

  useEffect(() => {
    if (users.length === 0) return;
    const idsWithAvatar = users
      .filter((u) => typeof u.avatar_url === 'string' && u.avatar_url.trim().length > 0)
      .map((u) => u.id);
    if (idsWithAvatar.length === 0) return;

    let cancelled = false;

    const fetchAvatars = async () => {
      try {
        const token = await getAccessToken();
        if (!token || cancelled) return;
        const res = await fetch('/api/admin/avatars/signed', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ userIds: idsWithAvatar }),
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { urls?: Record<string, string> };
        if (cancelled || !data.urls || typeof data.urls !== 'object') return;
        setAvatarSignedUrls(data.urls);
      } catch {
        // ignore: fallback to public URL or initial
      }
    };

    void fetchAvatars();
    const interval = setInterval(() => void fetchAvatars(), 30 * 60 * 1000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void fetchAvatars();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [users, getAccessToken]);

  async function handleCreateUser() {
    if (!newUser.email || !newUser.password || !newUser.role) {
      setError('Заполните все обязательные поля');
      return;
    }
    if (newUser.password.trim().length < 8) {
      setError('Пароль должен быть минимум 8 символов');
      return;
    }
    if (newUser.password.trim().length > 72) {
      setError('Пароль слишком длинный (максимум 72 символа)');
      return;
    }

    setCreating(true);
    setError('');

    try {
      const fullName = newUser.full_name || newUser.email.split('@')[0];
      const result = await apiFetch<{ ok: true; user: { id: string } }>('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          email: newUser.email,
          password: newUser.password,
          role: newUser.role,
          full_name: fullName,
        }),
      });

      setShowCreateModal(false);
      setNewUser({ email: '', password: '', role: 'technician', full_name: '' });
      setSearchQuery(''); // Reset search when user is created
      void logAudit('admin.users.create.success', 'User created', {
        targetUserId: result.user.id,
        role: newUser.role,
      });
      await fetchUsers();
    } catch (err: unknown) {
      void logError('admin.users.create.failed', err, { role: newUser.role });
      const message = getErrorMessage(err);
      const lower = message.toLowerCase();
      if (lower.includes('already registered')) {
        setError('Пользователь с таким email уже существует');
      } else if (lower.includes('already') || lower.includes('уже существует')) {
        setError('Пользователь с таким email уже существует');
      } else {
        setError(message || 'Ошибка создания пользователя');
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleSaveAllChanges() {
    if (!actionModalUserId || !modalRole) return;
    setSaving(true);
    setError('');
    setSaveSuccessMessage(null);
    try {
      await apiFetch<{ ok: true }>(`/api/admin/users/${actionModalUserId}/role`, {
        method: 'POST',
        body: JSON.stringify({ role: modalRole }),
      });
      setUsers(users.map(u => (u.id === actionModalUserId ? { ...u, role: modalRole } : u)));
      void logAudit('admin.users.role.updated', 'User role updated', {
        targetUserId: actionModalUserId,
        role: modalRole,
      });

      await apiFetch<{ ok: true }>(`/api/admin/users/${actionModalUserId}/tools`, {
        method: 'POST',
        body: JSON.stringify({ visibility: toolVisibility }),
      });

      if (modalRole === 'client') {
        await apiFetch<{ ok: true }>(`/api/admin/users/${actionModalUserId}/client-access`, {
          method: 'PUT',
          body: JSON.stringify({ campaigns: clientCampaigns }),
        });
      }

      setSaveSuccessMessage('Изменения сохранены');
    } catch (err: unknown) {
      void logError('admin.users.save.all.failed', err, { targetUserId: actionModalUserId });
      setError(getErrorMessage(err) || 'Ошибка сохранения изменений');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteUser(userId: string) {
    // Prevent deleting yourself
    if (userId === currentUserId) {
      setError('Вы не можете удалить самого себя');
      setDeletingUserId(null);
      return;
    }

    setDeleting(true);
    setError('');
    try {
      // Delete from profiles table
      const { error } = await supabase
        .from('profiles')
        .delete()
        .eq('id', userId);

      if (error) throw error;

      // Remove from local state
      setUsers(users.filter(u => u.id !== userId));
      setDeletingUserId(null);
      void logAudit('admin.users.delete.success', 'User deleted', { targetUserId: userId });
    } catch (err: unknown) {
      void logError('admin.users.delete.failed', err, { targetUserId: userId });
      setError(getErrorMessage(err) || 'Ошибка удаления пользователя');
    } finally {
      setDeleting(false);
    }
  }

  const filteredUsers = users.filter(user =>
    user.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    user.full_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (user.role && ROLE_LABELS[user.role]?.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const sortedUsers = useMemo(() => {
    const list = [...filteredUsers];
    const cmp = (a: UserProfile, b: UserProfile): number => {
      const av = sortBy === 'name' ? (a.full_name || a.email || '').toLowerCase() : sortBy === 'email' ? (a.email || '').toLowerCase() : (a.role ? ROLE_LABELS[a.role] : '');
      const bv = sortBy === 'name' ? (b.full_name || b.email || '').toLowerCase() : sortBy === 'email' ? (b.email || '').toLowerCase() : (b.role ? ROLE_LABELS[b.role] : '');
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    };
    list.sort((a, b) => (sortDir === 'asc' ? 1 : -1) * cmp(a, b));
    return list;
  }, [filteredUsers, sortBy, sortDir]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-500">Загрузка...</div>
      </div>
    );
  }

  if (!isAdmin(currentUserRole)) {
    return (
      <div className={`max-w-4xl mx-auto ${isTma ? 'py-6 px-4 text-sm leading-relaxed' : 'py-10'}`}>
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 flex items-center">
          <div>
            <h2 className="text-lg font-semibold text-red-800">Доступ запрещен</h2>
            <p className="text-red-600">Только администраторы могут управлять пользователями.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`max-w-6xl mx-auto px-4 ${isTma ? 'py-6 text-sm leading-relaxed' : 'py-10'}`}>
      <div className="mb-6">
        <Link href="/admin" className="text-sm font-medium text-blue-600 hover:text-blue-700">
          ← Назад в админку
        </Link>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6 sm:mb-8">
        <div>
          <h1 className={`${isTma ? 'text-xl' : 'text-3xl'} font-bold text-gray-900`}>Управление пользователями</h1>
          <p className="mt-1 text-sm text-gray-500">Создание и управление ролями пользователей</p>
        </div>
        <button
          onClick={() => {
            setSearchQuery(''); // Clear search when opening modal
            setShowCreateModal(true);
          }}
          className={`inline-flex items-center justify-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors ${isTma ? 'w-full sm:w-auto' : ''}`}
        >
          Добавить пользователя
        </button>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center text-red-700">
          {error}
          <button onClick={() => setError('')} className="ml-auto">
            ✕
          </button>
        </div>
      )}

      <div className="mb-6">
        <div className="relative">
          <input
            type="text"
            placeholder="Поиск по email, имени или роли..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoComplete="off"
            className="w-full pl-4 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center">
            Пользователи ({filteredUsers.length})
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {([
                  { key: 'name' as SortColumn, label: 'Пользователь' },
                  { key: 'email' as SortColumn, label: 'Email' },
                  { key: 'role' as SortColumn, label: 'Роль' },
                ]).map(({ key, label }) => (
                  <th
                    key={key}
                    className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (sortBy === key) {
                          setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
                        } else {
                          setSortBy(key);
                          setSortDir('asc');
                        }
                      }}
                      className="inline-flex items-center justify-center gap-1 hover:text-gray-700 focus:outline-none rounded mx-auto"
                    >
                      {label}
                      {sortBy === key && (sortDir === 'asc' ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />)}
                    </button>
                  </th>
                ))}
                <th className="px-6 py-3 w-12" aria-label="Действия" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {sortedUsers.map((user) => (
                <tr key={user.id} className="hover:bg-gray-50">
                  <td className="pl-10 pr-6 py-4 whitespace-nowrap text-left">
                    <div className="flex items-center">
                      <div className="w-10 flex justify-center flex-shrink-0">
                        <UserAvatar user={user} signedUrl={avatarSignedUrls[user.id]} />
                      </div>
                      <div className="ml-4">
                        <p className="text-sm font-medium text-gray-900">
                          {user.full_name || 'Без имени'}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-center">
                    <p className="text-sm text-gray-600">{user.email || '—'}</p>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-center">
                    <span className={`inline-flex px-3 py-1 rounded-full text-xs font-medium ${
                        user.role === 'admin' ? 'bg-purple-100 text-purple-800' :
                        user.role === 'manager' ? 'bg-blue-100 text-blue-800' :
                        user.role === 'director' ? 'bg-indigo-100 text-indigo-800' :
                        user.role === 'technician' ? 'bg-green-100 text-green-800' :
                        user.role === 'sales' ? 'bg-yellow-100 text-yellow-800' :
                        user.role === 'marketer' ? 'bg-pink-100 text-pink-800' :
                        'bg-gray-100 text-gray-800'
                      }`}>
                      {user.role ? ROLE_LABELS[user.role] : 'Нет роли'}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-center">
                    <button
                      type="button"
                      onClick={(e) => {
                        const target = e.currentTarget as HTMLElement;
                        const rect = target.getBoundingClientRect();
                        const origin = {
                          x: rect.left + rect.width / 2,
                          y: rect.top + rect.height / 2,
                        };
                        void openActionModal(user, origin);
                      }}
                      disabled={actionModalLoadingUserId === user.id}
                      className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors inline-flex items-center justify-center disabled:opacity-70"
                      title="Действия"
                      aria-label="Открыть действия"
                    >
                      {actionModalLoadingUserId === user.id ? (
                        <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" aria-hidden />
                      ) : (
                        <MoreVertical className="h-5 w-5" />
                      )}
                    </button>
                  </td>
                </tr>
              ))}
              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-gray-500">
                    {searchQuery ? 'Пользователи не найдены' : 'Нет пользователей'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showCreateModal && (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">Новый пользователь</h3>
              <button
                onClick={() => { 
                  setShowCreateModal(false); 
                  setError(''); 
                  setSearchQuery(''); 
                }}
                className="size-8 inline-flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors text-gray-600"
                aria-label="Закрыть"
              >
                ✕
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Имя
                </label>
                <input
                  type="text"
                  value={newUser.full_name}
                  onChange={(e) => setNewUser({ ...newUser, full_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Иван Иванов"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email <span className="text-red-500">*</span>
                </label>
                <input
                  type="email"
                  value={newUser.email}
                  onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="user@example.com"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Пароль <span className="text-red-500">*</span>
                </label>
                <input
                  type="password"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Минимум 8 символов"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Роль <span className="text-red-500">*</span>
                </label>
                <select
                  value={newUser.role}
                  onChange={(e) => setNewUser({ ...newUser, role: e.target.value as UserRole })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  {ALL_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
              <button
                onClick={() => { 
                  setShowCreateModal(false); 
                  setError(''); 
                  setSearchQuery(''); 
                }}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Отмена
              </button>
              <button
                onClick={handleCreateUser}
                disabled={creating}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center"
              >
                {creating ? 'Создание...' : 'Создать'}
              </button>
            </div>
          </div>
        </div>
      )}

      {actionModalUserId && actionModalOrigin && (() => {
        const userForModal = users.find((u) => u.id === actionModalUserId);
        if (!userForModal) return null;
        const origin = actionModalOrigin;
        return (
          <div
            className="fixed inset-0 z-50 p-4 flex items-center justify-center"
            style={{
              backgroundColor: modalFlyIn ? 'rgba(0,0,0,0.2)' : 'transparent',
              backdropFilter: modalFlyIn ? 'blur(4px)' : 'none',
              transition: 'background-color 1s ease-out, backdrop-filter 1s ease-out',
            }}
          >
            <div
              className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col"
              style={{
                position: 'fixed',
                left: modalFlyIn ? '50%' : `${origin.x}px`,
                top: modalFlyIn ? '50%' : `${origin.y}px`,
                transform: `translate(-50%, -50%) scale(${modalFlyIn ? 1 : 0})`,
                transformOrigin: 'center center',
                opacity: modalFlyIn ? 1 : 0.95,
                transition: 'left 1s cubic-bezier(0.34, 1.56, 0.64, 1), top 1s cubic-bezier(0.34, 1.56, 0.64, 1), transform 1s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 1s ease-out',
              }}
            >
              <div className="px-6 py-4 border-b border-gray-200 shrink-0 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-gray-900">
                    {userForModal.full_name || userForModal.email || 'Пользователь'}
                  </h3>
                  <button
                  type="button"
                  onClick={() => {
                    setActionModalUserId(null);
                    setModalFlyIn(false);
                  }}
                  className="size-8 inline-flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors text-gray-600"
                  aria-label="Закрыть"
                >
                  ✕
                </button>
                </div>
                {saveSuccessMessage && (
                  <div
                    className="flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800 border border-green-200"
                    role="status"
                  >
                    <span className="shrink-0 size-5 rounded-full bg-green-500 flex items-center justify-center text-white" aria-hidden>
                      <Check className="size-3 stroke-[3]" />
                    </span>
                    {saveSuccessMessage}
                  </div>
                )}
              </div>
              <div className="p-6 overflow-y-auto space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Роль</label>
                  <select
                    value={modalRole ?? ''}
                    onChange={(e) => setModalRole(e.target.value as UserRole)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                  >
                    {ALL_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setActionModalUserId(null);
                      setModalFlyIn(false);
                      setError('');
                      setResettingUserId(actionModalUserId);
                      setNewPassword('');
                      setRevealPassword(false);
                    }}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
                  >
                    Сменить пароль
                  </button>
                  {actionModalUserId !== currentUserId && (
                    <button
                      type="button"
                      onClick={() => {
                        setActionModalUserId(null);
                        setModalFlyIn(false);
                        setDeletingUserId(actionModalUserId);
                      }}
                      className="px-3 py-2 border border-red-200 text-red-700 rounded-lg text-sm hover:bg-red-50"
                    >
                      Удалить пользователя
                    </button>
                  )}
                </div>
                <div className="space-y-5">
                  <div>
                    <h4 className="text-sm font-medium text-gray-900 mb-3">Отображение инструментов</h4>
                    <ul className="space-y-2">
                      {ALL_TOOL_IDS.map((toolId) => (
                        <li key={toolId} className="flex items-center justify-between gap-4">
                          <span className="text-sm text-gray-700">{TOOLS_CONFIG[toolId].title}</span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={toolVisibility[toolId] !== false}
                            onClick={() =>
                              setToolVisibility((prev) => ({
                                ...prev,
                                [toolId]: prev[toolId] === false,
                              }))
                            }
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                              toolVisibility[toolId] !== false ? 'bg-blue-600' : 'bg-gray-200'
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${
                                toolVisibility[toolId] !== false ? 'translate-x-5' : 'translate-x-1'
                              }`}
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-gray-900 mb-1">Отображение вкладок в боковой панели</h4>
                    <p className="text-xs text-gray-500 mb-3">Управляет дополнительными пунктами навигации для данного пользователя</p>
                    <ul className="space-y-2">
                      {ALL_NAV_TAB_IDS.map((tabId) => (
                        <li key={tabId} className="flex items-center justify-between gap-4">
                          <span className="text-sm text-gray-700">{NAV_TABS_CONFIG[tabId].title}</span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={toolVisibility[tabId] !== false}
                            onClick={() =>
                              setToolVisibility((prev) => ({
                                ...prev,
                                [tabId]: prev[tabId] === false,
                              }))
                            }
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                              toolVisibility[tabId] !== false ? 'bg-blue-600' : 'bg-gray-200'
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${
                                toolVisibility[tabId] !== false ? 'translate-x-5' : 'translate-x-1'
                              }`}
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {modalRole === 'client' && (
                  <div className="space-y-4 pt-2 border-t border-gray-200">
                    <h4 className="text-sm font-medium text-gray-900">Доступ клиента к Instantly</h4>

                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Кампании (Campaign IDs)</label>
                      <div className="flex gap-2 mb-2">
                        <input
                          type="text"
                          value={clientCampaignInput}
                          onChange={(e) => setClientCampaignInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              const v = clientCampaignInput.trim();
                              if (v && !clientCampaigns.includes(v)) {
                                setClientCampaigns((prev) => [...prev, v]);
                              }
                              setClientCampaignInput('');
                            }
                          }}
                          placeholder="Вставьте Campaign ID и Enter"
                          className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      {clientCampaigns.length > 0 && (
                        <ul className="space-y-1">
                          {clientCampaigns.map((id) => (
                            <li key={id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-1.5 text-sm">
                              <span className="truncate text-gray-700 font-mono text-xs">{id}</span>
                              <button
                                type="button"
                                onClick={() => setClientCampaigns((prev) => prev.filter((c) => c !== id))}
                                className="ml-2 text-red-500 hover:text-red-700 text-xs shrink-0"
                              >
                                ✕
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {clientCampaigns.length === 0 && (
                        <p className="text-xs text-gray-400">Нет назначенных кампаний</p>
                      )}
                    </div>

                    <p className="text-xs text-gray-400">Lead-списки определяются автоматически из назначенных кампаний</p>
                  </div>
                )}
              </div>
              <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end">
                <button
                  type="button"
                  onClick={handleSaveAllChanges}
                  disabled={saving || !modalRole}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium"
                >
                  {saving ? 'Сохранение...' : 'Сохранить изменения'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {deletingUserId && (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Подтверждение удаления</h3>
            </div>
            <div className="p-6">
              {(() => {
                const userToDelete = users.find(u => u.id === deletingUserId);
                return (
                  <p className="text-gray-700">
                    Вы уверены, что хотите удалить пользователя{' '}
                    <span className="font-semibold">
                      {userToDelete?.full_name || userToDelete?.email || 'этого пользователя'}
                    </span>?
                    <br />
                    <span className="text-sm text-gray-500 mt-2 block">
                      Это действие нельзя отменить.
                    </span>
                  </p>
                );
              })()}
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
              <button
                onClick={() => setDeletingUserId(null)}
                disabled={deleting}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
              >
                Отмена
              </button>
              <button
                onClick={() => deletingUserId && handleDeleteUser(deletingUserId)}
                disabled={deleting}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center"
              >
                {deleting ? 'Удаление...' : 'Удалить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {resettingUserId && (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">Сменить пароль</h3>
              <button
                onClick={() => {
                  setResettingUserId(null);
                  setNewPassword('');
                  setRevealPassword(false);
                  setError('');
                }}
                className="size-8 inline-flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors text-gray-600"
                aria-label="Закрыть"
              >
                ✕
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="text-sm text-gray-600">
                Админ задаёт новый пароль пользователю. Сообщите пароль пользователю безопасным способом.
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Новый пароль <span className="text-red-500">*</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type={revealPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="Минимум 8 символов"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setRevealPassword((v) => !v)}
                    className="px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
                    title={revealPassword ? 'Скрыть' : 'Показать'}
                  >
                    {revealPassword ? 'Скрыть' : 'Показать'}
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={generatePassword}
                    className="text-sm text-blue-600 hover:text-blue-800"
                  >
                    Сгенерировать
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        if (!newPassword.trim()) return;
                        await navigator.clipboard.writeText(newPassword.trim());
                      } catch {
                        // ignore
                      }
                    }}
                    className="text-sm text-gray-600 hover:text-gray-800"
                    disabled={!newPassword.trim()}
                  >
                    Копировать
                  </button>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
              <button
                onClick={() => {
                  setResettingUserId(null);
                  setNewPassword('');
                  setRevealPassword(false);
                  setError('');
                }}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Отмена
              </button>
              <button
                onClick={handleResetPassword}
                disabled={resetting || newPassword.trim().length < 8}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {resetting ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
