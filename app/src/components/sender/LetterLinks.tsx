'use client';

import { useState } from 'react';
import { Eraser, Italic, Link2, List, ListOrdered, Quote, Strikethrough, Underline } from 'lucide-react';
import { letterBlocks, splitStyled } from '@/lib/mail/letterFormat';
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
        className="letter-tool inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50"
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

/** Строка письма как её увидит получатель: ссылки — ссылками, `**жирный**` — жирным. */
function Inline({ text }: { text: string }) {
  return (
    <>
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
          <span key={index}>
            {splitStyled(chunk.text).map((part, i) => {
              let node: React.ReactNode = part.text;
              if (part.bold) node = <strong>{node}</strong>;
              if (part.italic) node = <em>{node}</em>;
              if (part.underline) node = <u>{node}</u>;
              if (part.strike) node = <s>{node}</s>;
              return <span key={i}>{node}</span>;
            })}
          </span>
        ),
      )}
    </>
  );
}

/** Текст письма как его увидит получатель: ссылки, жирный и списки нарисованы настоящими. */
export function LetterText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ?? 'break-words text-sm text-zinc-700'}>
      {letterBlocks(text).map((block, index) =>
        block.kind === 'list' ? (
          block.ordered ? (
            <ol key={index} className="my-1 list-decimal pl-5">
              {block.items.map((item, i) => (
                <li key={i}><Inline text={item} /></li>
              ))}
            </ol>
          ) : (
            <ul key={index} className="my-1 list-disc pl-5">
              {block.items.map((item, i) => (
                <li key={i}><Inline text={item} /></li>
              ))}
            </ul>
          )
        ) : block.kind === 'quote' ? (
          <blockquote key={index} className="my-1 whitespace-pre-wrap border-l-2 border-zinc-300 pl-3 text-zinc-500">
            <Inline text={block.lines.join('
')} />
          </blockquote>
        ) : (
          <p key={index} className="my-1 whitespace-pre-wrap">
            <Inline text={block.lines.join('\n')} />
          </p>
        ),
      )}
    </div>
  );
}

/**
 * Панель инструментов письма внизу окна, как в Instantly: жирный, курсив,
 * подчёркнутый, зачёркнутый, списки, цитата, очистка оформления и ссылка.
 * Кнопки не отнимают фокус у поля, поэтому выделение остаётся.
 */
export function LetterToolbar({
  disabled,
  onBold,
  onItalic,
  onUnderline,
  onStrike,
  onBullets,
  onNumbered,
  onQuote,
  onClear,
  children,
}: {
  disabled?: boolean;
  onBold: () => void;
  onItalic?: () => void;
  onUnderline?: () => void;
  onStrike?: () => void;
  onBullets: () => void;
  onNumbered?: () => void;
  onQuote?: () => void;
  onClear?: () => void;
  /** Остальные инструменты панели — например, вставка ссылки. */
  children?: React.ReactNode;
}) {
  const button =
    'letter-tool inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-lg px-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50';
  const tool = (label: string, onClick: (() => void) | undefined, content: React.ReactNode, extra = '') =>
    onClick ? (
      <button
        key={label}
        type="button"
        title={label}
        aria-label={label}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className={`${button} ${extra}`}
      >
        {content}
      </button>
    ) : null;
  const divider = <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-zinc-300" />;
  return (
    <div className="sticky bottom-3 z-10 mt-3 flex justify-center">
      <div className="flex flex-wrap items-center gap-1 rounded-xl border border-zinc-300 bg-white px-2 py-1.5 shadow-lg">
        {tool('Жирный', onBold, 'Ж', 'font-bold')}
        {tool('Курсив', onItalic, <Italic className="h-4 w-4" />)}
        {tool('Подчёркнутый', onUnderline, <Underline className="h-4 w-4" />)}
        {tool('Зачёркнутый', onStrike, <Strikethrough className="h-4 w-4" />)}
        {divider}
        {tool('Список с маркерами', onBullets, <List className="h-4 w-4" />)}
        {tool('Нумерованный список', onNumbered, <ListOrdered className="h-4 w-4" />)}
        {tool('Цитата', onQuote, <Quote className="h-4 w-4" />)}
        {divider}
        {tool('Убрать оформление', onClear, <Eraser className="h-4 w-4" />)}
        {children}
      </div>
    </div>
  );
}
