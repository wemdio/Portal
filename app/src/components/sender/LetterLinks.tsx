'use client';

import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { normalizeLinkUrl, splitLinkMarkup } from '@/lib/mail/linkMarkup';

/**
 * Ссылка под словом в письме: вставка в текст и показ в предпросмотре.
 *
 * В поле письма ссылка живёт разметкой `[Alial](https://alial.ru)` — поле
 * обычное, с подсказкой переменных, и видеть её как ссылку негде. Поэтому
 * адрес виден прямо в тексте, а то, что получит лид, показывает предпросмотр:
 * там разметка уже нарисована синей ссылкой.
 */

export function LinkInsert({
  disabled,
  /** Что подставить в «Текст» при открытии — выделенное в письме. */
  onOpen,
  onInsert,
}: {
  disabled?: boolean;
  onOpen: () => string;
  onInsert: (label: string, url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');

  const insert = () => {
    const text = label.trim();
    const href = normalizeLinkUrl(url);
    if (!text || !href) return;
    onInsert(text, href);
    setOpen(false);
    setLabel('');
    setUrl('');
  };

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setLabel(onOpen());
          setOpen(true);
        }}
        className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50"
      >
        <Link2 className="h-3.5 w-3.5" />
        Ссылка
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input
        autoFocus
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && insert()}
        placeholder="Текст — например, Alial"
        className="w-44 rounded-lg border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-900"
      />
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && insert()}
        placeholder="https://alial.ru"
        className="w-56 rounded-lg border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-900"
      />
      <button
        type="button"
        onClick={insert}
        disabled={!label.trim() || !url.trim()}
        className="rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
      >
        Вставить
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="rounded-lg px-2 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-100"
      >
        Отмена
      </button>
    </div>
  );
}

/** Текст письма как его увидит получатель: разметка ссылок — настоящими ссылками. */
export function LetterText({ text, className }: { text: string; className?: string }) {
  return (
    <p className={className ?? 'whitespace-pre-wrap break-words text-sm text-zinc-700'}>
      {splitLinkMarkup(text).map((chunk, index) =>
        chunk.kind === 'link' ? (
          <a
            key={index}
            href={chunk.url}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 underline"
          >
            {chunk.text}
          </a>
        ) : (
          <span key={index}>{chunk.text}</span>
        ),
      )}
    </p>
  );
}
