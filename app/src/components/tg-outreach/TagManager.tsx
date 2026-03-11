'use client';

import { useState } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import { tgOutreachFetch } from '@/lib/tgOutreach/fetcher';
import type { TgOutreachTag } from '@/lib/tgOutreach/types';

const TAG_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#64748b', '#14b8a6',
];

interface Props {
  tags: TgOutreachTag[];
  onClose: () => void;
  onUpdate: () => void;
}

export function TagManager({ tags, onClose, onUpdate }: Props) {
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(TAG_COLORS[0]);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await tgOutreachFetch('/tags', { method: 'POST', json: { name: newName.trim(), color: newColor } });
      setNewName('');
      onUpdate();
    } catch {
      // silent
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    await tgOutreachFetch(`/tags/${id}`, { method: 'DELETE' });
    onUpdate();
  };

  const handleRename = async (id: string) => {
    if (!editName.trim()) return;
    await tgOutreachFetch(`/tags/${id}`, { method: 'PATCH', json: { name: editName.trim() } });
    setEditingId(null);
    onUpdate();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-xl border border-gray-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">Управление тегами</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          <div className="flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Название тега..."
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
            <button
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>

          <div className="flex gap-1.5 flex-wrap">
            {TAG_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setNewColor(c)}
                className={`h-6 w-6 rounded-full transition-transform ${newColor === c ? 'ring-2 ring-offset-2 ring-blue-400 scale-110' : 'hover:scale-105'}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>

          <div className="max-h-64 overflow-y-auto space-y-1">
            {tags.length === 0 && (
              <p className="text-center text-sm text-gray-400 py-4">Тегов пока нет</p>
            )}
            {tags.map((tag) => (
              <div
                key={tag.id}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-50"
              >
                <span
                  className="h-3 w-3 rounded-full shrink-0"
                  style={{ backgroundColor: tag.color }}
                />
                {editingId === tag.id ? (
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => handleRename(tag.id)}
                    onKeyDown={(e) => e.key === 'Enter' && handleRename(tag.id)}
                    autoFocus
                    className="flex-1 rounded border border-gray-200 px-2 py-0.5 text-sm focus:border-blue-400 focus:outline-none"
                  />
                ) : (
                  <span
                    className="flex-1 text-sm text-gray-700 cursor-pointer"
                    onClick={() => { setEditingId(tag.id); setEditName(tag.name); }}
                  >
                    {tag.name}
                  </span>
                )}
                <button
                  onClick={() => handleDelete(tag.id)}
                  className="text-gray-300 hover:text-red-500 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
