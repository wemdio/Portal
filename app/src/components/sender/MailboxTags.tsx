'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, Pencil, Plus, Tag, Trash2, X } from 'lucide-react';
import {
  createMailboxTag,
  deleteMailboxTag,
  renameMailboxTag,
  type MailboxTagDto,
} from './api';
import { SenderModal } from './SenderModal';

/**
 * Теги ящиков: окошко фильтра над списком и выпадающее меню «Под тег» в панели
 * выделения.
 *
 * Один ящик — один тег, поэтому «повесить тег» здесь всегда замена, а не
 * добавление, и в меню назначения первым пунктом стоит «Без тега»: иначе снять
 * метку было бы нечем.
 */

/** Закрытие по клику мимо и по Esc — общее для обоих меню. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

/** Чип тега в строке таблицы. Цвета нет намеренно: рядом уже два цветных статуса. */
export function TagChip({ name }: { name: string }) {
  return (
    <span className="inline-flex max-w-40 items-center gap-1 rounded-md bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700">
      <Tag className="h-3 w-3 shrink-0 text-zinc-400" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Окно с одним полем: создание тега и переименование — одна и та же форма. */
function TagNameModal({
  title,
  initial,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: string;
  busy: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const trimmed = name.trim();

  return (
    <SenderModal
      title={title}
      onClose={onClose}
      footer={
        <>
          {error ? <span className="mr-auto text-sm text-red-600">{error}</span> : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => onSubmit(trimmed)}
            disabled={busy || !trimmed}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Сохранить
          </button>
        </>
      }
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && trimmed && !busy) onSubmit(trimmed);
        }}
        maxLength={40}
        placeholder="Например: Wolly, прогрев, клиники"
        className="w-full rounded-lg border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-zinc-900"
      />
      <p className="mt-2 text-xs text-zinc-500">
        Ящик может быть только под одним тегом. Тег виден в списке ящиков и в фильтре.
      </p>
    </SenderModal>
  );
}

interface FilterProps {
  tags: MailboxTagDto[];
  untagged: number;
  selected: ReadonlySet<string>;
  noTag: boolean;
  onToggleTag: (id: string) => void;
  onToggleNoTag: () => void;
  onReset: () => void;
  /** Список тегов изменился — перезагрузить теги и сам список ящиков. */
  onChanged: () => void | Promise<void>;
}

/** Кнопка «Теги» со списком: фильтр, переименование, удаление и создание. */
export function TagFilterMenu({
  tags,
  untagged,
  selected,
  noTag,
  onToggleTag,
  onToggleNoTag,
  onReset,
  onChanged,
}: FilterProps) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'rename'; tag: MailboxTagDto } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  const active = selected.size + (noTag ? 1 : 0);

  const submit = async (name: string) => {
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      if (form.mode === 'create') await createMailboxTag(name);
      else await renameMailboxTag(form.tag.id, name);
      setForm(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить тег');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (tag: MailboxTagDto) => {
    const suffix = tag.mailboxes
      ? ` Метка снимется с ${tag.mailboxes} ящиков, сами ящики останутся.`
      : '';
    if (!window.confirm(`Удалить тег «${tag.name}»?${suffix}`)) return;
    setError(null);
    try {
      await deleteMailboxTag(tag.id);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить тег');
    }
  };

  return (
    <>
      <div ref={ref} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ${
            active
              ? 'border-blue-300 bg-blue-50 text-blue-700'
              : 'border-zinc-300 text-zinc-700 hover:bg-zinc-100'
          }`}
        >
          <Tag className="h-4 w-4" />
          Теги
          {active ? <span className="font-medium">({active})</span> : null}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </button>

        {open ? (
          <div className="absolute right-0 z-30 mt-1 w-72 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-lg">
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-xs uppercase tracking-wide text-zinc-500">Показать ящики</span>
              {active ? (
                <button
                  type="button"
                  onClick={onReset}
                  className="rounded-md px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700"
                >
                  Сбросить
                </button>
              ) : null}
            </div>

            <div className="max-h-72 overflow-y-auto">
              <button
                type="button"
                onClick={onToggleNoTag}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-100"
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    noTag ? 'border-blue-600 bg-blue-600 text-white' : 'border-zinc-300'
                  }`}
                >
                  {noTag ? <Check className="h-3 w-3" /> : null}
                </span>
                <span className="flex-1 truncate text-zinc-500">Без тега</span>
                <span className="text-xs text-zinc-400">{untagged}</span>
              </button>

              {/* Строка — не одна кнопка: внутри живут карандаш и корзина, а
                  кнопка в кнопке не собирается. */}
              {tags.map((tag) => {
                const checked = selected.has(tag.id);
                return (
                  <div
                    key={tag.id}
                    className="group flex items-center gap-1 rounded-lg px-0.5 hover:bg-zinc-100"
                  >
                    <button
                      type="button"
                      onClick={() => onToggleTag(tag.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-sm text-zinc-700"
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          checked ? 'border-blue-600 bg-blue-600 text-white' : 'border-zinc-300'
                        }`}
                      >
                        {checked ? <Check className="h-3 w-3" /> : null}
                      </span>
                      <span className="flex-1 truncate">{tag.name}</span>
                      <span className="text-xs text-zinc-400">{tag.mailboxes}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        setForm({ mode: 'rename', tag });
                      }}
                      aria-label={`Переименовать тег ${tag.name}`}
                      className="rounded-md p-1 text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-200 hover:text-zinc-700 focus:opacity-100 group-hover:opacity-100"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(tag)}
                      aria-label={`Удалить тег ${tag.name}`}
                      className="mr-0.5 rounded-md p-1 text-zinc-400 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}

              {tags.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-zinc-500">Тегов пока нет.</p>
              ) : null}
            </div>

            {error ? <p className="px-2 py-1 text-xs text-red-600">{error}</p> : null}

            <div className="mt-1 border-t border-zinc-100 pt-1">
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setForm({ mode: 'create' });
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-blue-600 hover:bg-blue-50"
              >
                <Plus className="h-4 w-4" />
                Тег
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {form ? (
        <TagNameModal
          title={form.mode === 'create' ? 'Новый тег' : 'Переименовать тег'}
          initial={form.mode === 'create' ? '' : form.tag.name}
          busy={busy}
          error={error}
          onSubmit={(name) => void submit(name)}
          onClose={() => {
            setForm(null);
            setError(null);
          }}
        />
      ) : null}
    </>
  );
}

/** «Под тег» в панели выделения: один тег на всю выборку. */
export function TagAssignMenu({
  tags,
  disabled,
  onPick,
}: {
  tags: MailboxTagDto[];
  disabled: boolean;
  onPick: (tagId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
      >
        <Tag className="h-3.5 w-3.5" />
        Под тег
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open ? (
        <div className="absolute left-0 z-30 mt-1 w-56 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-lg">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onPick(null);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-zinc-500 hover:bg-zinc-100"
          >
            <X className="h-3.5 w-3.5" />
            Без тега
          </button>
          <div className="max-h-64 overflow-y-auto">
            {tags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPick(tag.id);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100"
              >
                <Tag className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                <span className="flex-1 truncate">{tag.name}</span>
                <span className="text-xs text-zinc-400">{tag.mailboxes}</span>
              </button>
            ))}
          </div>
          {tags.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-zinc-500">
              Тегов пока нет — создайте в фильтре «Теги».
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
