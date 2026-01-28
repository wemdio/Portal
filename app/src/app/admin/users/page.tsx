'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { UserRole, UserProfile } from '@/types';
import { ALL_ROLES, ROLE_LABELS, isAdmin, getCurrentUserRole } from '@/lib/roles';
import { Users, Loader2, Edit2, X, Check, AlertCircle, UserPlus, Search, Trash2 } from 'lucide-react';

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Неизвестная ошибка';
}

export default function UsersPage() {
  const [currentUserRole, setCurrentUserRole] = useState<UserRole | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newUser, setNewUser] = useState({ email: '', password: '', role: 'technician' as UserRole, full_name: '' });
  
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editingRole, setEditingRole] = useState<UserRole | null>(null);
  const [saving, setSaving] = useState(false);
  
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchUsers = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*');

      if (error) throw error;
      setUsers((data as UserProfile[]) || []);
    } catch (err: unknown) {
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
      setError(getErrorMessage(err));
      setLoading(false);
    }
  }, [fetchUsers]);

  useEffect(() => {
    void checkAccess();
  }, [checkAccess]);

  async function handleCreateUser() {
    if (!newUser.email || !newUser.password || !newUser.role) {
      setError('Заполните все обязательные поля');
      return;
    }

    setCreating(true);
    setError('');

    try {
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: newUser.email,
        password: newUser.password,
        options: {
          data: {
            full_name: newUser.full_name || newUser.email.split('@')[0],
          }
        }
      });

      if (authError) throw authError;
      if (!authData.user) throw new Error('Не удалось создать пользователя');

      const { error: profileError } = await supabase
        .from('profiles')
        .upsert({
          id: authData.user.id,
          email: newUser.email,
          role: newUser.role,
          full_name: newUser.full_name || newUser.email.split('@')[0],
        });

      if (profileError) throw profileError;

      setShowCreateModal(false);
      setNewUser({ email: '', password: '', role: 'technician', full_name: '' });
      setSearchQuery(''); // Reset search when user is created
      await fetchUsers();
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      if (message.includes('already registered')) {
        setError('Пользователь с таким email уже существует');
      } else {
        setError(message || 'Ошибка создания пользователя');
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleUpdateRole(userId: string, newRole: UserRole) {
    setSaving(true);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ role: newRole })
        .eq('id', userId);

      if (error) throw error;

      setUsers(users.map(u => u.id === userId ? { ...u, role: newRole } : u));
      setEditingUserId(null);
      setEditingRole(null);
    } catch (err: unknown) {
      setError(getErrorMessage(err) || 'Ошибка обновления роли');
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
    } catch (err: unknown) {
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

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!isAdmin(currentUserRole)) {
    return (
      <div className="max-w-4xl mx-auto py-10">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 flex items-center">
          <AlertCircle className="h-6 w-6 text-red-600 mr-3" />
          <div>
            <h2 className="text-lg font-semibold text-red-800">Доступ запрещен</h2>
            <p className="text-red-600">Только администраторы могут управлять пользователями.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto py-10 px-4">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Управление пользователями</h1>
          <p className="mt-1 text-sm text-gray-500">Создание и управление ролями пользователей</p>
        </div>
        <button
          onClick={() => {
            setSearchQuery(''); // Clear search when opening modal
            setShowCreateModal(true);
          }}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <UserPlus className="h-5 w-5 mr-2" />
          Добавить пользователя
        </button>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center text-red-700">
          <AlertCircle className="h-5 w-5 mr-2" />
          {error}
          <button onClick={() => setError('')} className="ml-auto">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
          <input
            type="text"
            placeholder="Поиск по email, имени или роли..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoComplete="off"
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center">
            <Users className="h-5 w-5 mr-2 text-blue-600" />
            Пользователи ({filteredUsers.length})
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Пользователь
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Email
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Роль
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Действия
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filteredUsers.map((user) => (
                <tr key={user.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <div className="h-10 w-10 rounded-full bg-blue-600 flex items-center justify-center text-white font-medium">
                        {(user.full_name || user.email || '?').charAt(0).toUpperCase()}
                      </div>
                      <div className="ml-4">
                        <p className="text-sm font-medium text-gray-900">
                          {user.full_name || 'Без имени'}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <p className="text-sm text-gray-600">{user.email || '—'}</p>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {editingUserId === user.id ? (
                      <select
                        value={editingRole || user.role || ''}
                        onChange={(e) => setEditingRole(e.target.value as UserRole)}
                        className="px-3 py-1 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500"
                      >
                        {ALL_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABELS[role]}
                          </option>
                        ))}
                      </select>
                    ) : (
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
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {editingUserId === user.id ? (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => editingRole && handleUpdateRole(user.id, editingRole)}
                          disabled={saving || !editingRole}
                          className="p-1 text-green-600 hover:bg-green-50 rounded disabled:opacity-50"
                        >
                          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                        </button>
                        <button
                          onClick={() => { setEditingUserId(null); setEditingRole(null); }}
                          className="p-1 text-gray-600 hover:bg-gray-100 rounded"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => { setEditingUserId(user.id); setEditingRole(user.role); }}
                          className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                          title="Изменить роль"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>
                        {user.id !== currentUserId && (
                          <button
                            onClick={() => setDeletingUserId(user.id)}
                            className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            title="Удалить пользователя"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    )}
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
                className="p-1 hover:bg-gray-100 rounded"
              >
                <X className="h-5 w-5 text-gray-500" />
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
                  placeholder="Минимум 6 символов"
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
                {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Создать
              </button>
            </div>
          </div>
        </div>
      )}

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
                {deleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
