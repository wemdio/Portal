'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import {
  DEFAULT_REGLAMENT_CONTENT,
  REGLAMENT_CALLOUT_VARIANTS,
  REGLAMENT_EXTENSIONS,
  REGLAMENT_FONT_OPTIONS,
  REGLAMENT_HIGHLIGHT_COLORS,
  REGLAMENT_TEXT_COLORS,
} from '@/lib/reglamentEditor';

const EDITOR_BASE_WIDTH = 1400;

type ReglamentEditorProps = {
  content: JSONContent | null | undefined;
  onChange: (content: JSONContent) => void;
  onUploadImage?: (file: File) => Promise<string>;
  disabled?: boolean;
  /** When < 1, only the editor column is scaled so the toolbar stays outside transform and sticky works */
  scale?: number;
};

type ToolbarButtonProps = {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
};

const toolbarInputBase =
  'h-8 min-w-0 rounded-md border border-gray-200 bg-white px-2.5 text-xs text-gray-700 shadow-sm transition focus:border-gray-300 focus:outline-none focus:ring-1 focus:ring-gray-200';

function ToolbarButton({ onClick, active, disabled, title, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={
        'inline-flex h-8 items-center justify-center rounded-md border px-2.5 text-xs font-medium transition ' +
        (active
          ? 'border-gray-300 bg-gray-100 text-gray-900'
          : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50') +
        (disabled ? ' cursor-not-allowed opacity-50' : '')
      }
    >
      {children}
    </button>
  );
}

export function ReglamentEditor({ content, onChange, onUploadImage, disabled = false, scale = 1 }: ReglamentEditorProps) {
  const [toolbarTick, setToolbarTick] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastContentRef = useRef<string>(JSON.stringify(content ?? DEFAULT_REGLAMENT_CONTENT));
  const stickyToolbarRef = useRef<HTMLDivElement>(null);
  const toolbarColumnRef = useRef<HTMLDivElement>(null);
  const fixedToolbarRef = useRef<HTMLDivElement>(null);
  const [fixedLeft, setFixedLeft] = useState(0);
  const [toolbarHeight, setToolbarHeight] = useState(0);

  const editor = useEditor({
    extensions: REGLAMENT_EXTENSIONS,
    content: content ?? DEFAULT_REGLAMENT_CONTENT,
    editable: !disabled,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'reglament-content space-y-5 sm:space-y-6 reglament-prose',
      },
    },
    onUpdate({ editor: editorInstance }) {
      const json = editorInstance.getJSON();
      const serialized = JSON.stringify(json);
      if (serialized !== lastContentRef.current) {
        lastContentRef.current = serialized;
        onChange(json);
      }
    },
  });

  useEffect(() => {
    if (!editor) return;
    const serialized = JSON.stringify(content ?? DEFAULT_REGLAMENT_CONTENT);
    if (serialized !== lastContentRef.current) {
      lastContentRef.current = serialized;
      editor.commands.setContent(content ?? DEFAULT_REGLAMENT_CONTENT, { emitUpdate: false });
    }
  }, [content, editor]);

  useEffect(() => {
    if (!editor) return;
    const updateToolbar = () => setToolbarTick((prev) => prev + 1);
    editor.on('selectionUpdate', updateToolbar);
    editor.on('transaction', updateToolbar);
    return () => {
      editor.off('selectionUpdate', updateToolbar);
      editor.off('transaction', updateToolbar);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  useLayoutEffect(() => {
    const col = toolbarColumnRef.current;
    const fixedEl = fixedToolbarRef.current;
    const updateLeft = () => {
      if (col) setFixedLeft(col.getBoundingClientRect().left);
    };
    const updateHeight = () => {
      if (fixedEl) setToolbarHeight(fixedEl.getBoundingClientRect().height);
    };
    updateLeft();
    updateHeight();
    window.addEventListener('scroll', updateLeft, true);
    window.addEventListener('resize', () => {
      updateLeft();
      updateHeight();
    });
    const main = typeof document !== 'undefined' ? document.querySelector('main') : null;
    if (main) main.addEventListener('scroll', updateLeft, true);
    const ro = fixedEl ? new ResizeObserver(() => updateHeight()) : null;
    if (fixedEl && ro) ro.observe(fixedEl);
    return () => {
      window.removeEventListener('scroll', updateLeft, true);
      window.removeEventListener('resize', updateHeight);
      if (main) main.removeEventListener('scroll', updateLeft, true);
      ro?.disconnect();
    };
  }, [editor]);

  // #region agent log
  useEffect(() => {
    const el = fixedToolbarRef.current ?? stickyToolbarRef.current;
    const main = typeof document !== 'undefined' ? document.querySelector('main') : null;
    if (!el) return;
    const log = (msg: string, data: Record<string, unknown>) => {
      const payload = { sessionId: 'd2c76a', location: 'ReglamentEditor.tsx:sticky-debug', message: msg, data, timestamp: Date.now(), hypothesisId: (data as { hypothesisId?: string }).hypothesisId };
      if (typeof window !== 'undefined') (window as unknown as { __stickyDebug?: unknown[] }).__stickyDebug = (window as unknown as { __stickyDebug?: unknown[] }).__stickyDebug || []; (window as unknown as { __stickyDebug: unknown[] }).__stickyDebug.push(payload);
      fetch('http://127.0.0.1:7245/ingest/3f813762-1c83-4866-9785-21b432739610', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'd2c76a' }, body: JSON.stringify(payload) }).catch(() => {});
    };
    const cs = getComputedStyle(el);
    let p: HTMLElement | null = el.parentElement;
    let transformedAncestor: string | null = null;
    while (p) {
      if (getComputedStyle(p).transform !== 'none') {
        transformedAncestor = p.tagName + (p.id ? '#' + p.id : '') + (p.className ? '.' + (p.className as string).split(' ')[0] : '');
        break;
      }
      p = p.parentElement;
    }
    log('Sticky block mount', {
      hypothesisId: 'B',
      position: cs.position,
      top: cs.top,
      useScale: scale < 1 && scale > 0,
      transformedAncestor,
      mainScrollHeight: main ? (main as HTMLElement).scrollHeight : null,
      mainClientHeight: main ? (main as HTMLElement).clientHeight : null,
      mainOverflowY: main ? getComputedStyle(main as HTMLElement).overflowY : null,
      windowScrollable: typeof document !== 'undefined' && document.documentElement.scrollHeight > window.innerHeight,
    });
    if (!main) return;
    const onScroll = () => {
      const mainEl = main as HTMLElement;
      const stickyRect = el.getBoundingClientRect();
      const mainRect = mainEl.getBoundingClientRect();
      log('Scroll', {
        hypothesisId: 'A',
        mainScrollTop: mainEl.scrollTop,
        mainRectTop: mainRect.top,
        stickyRectTop: stickyRect.top,
        viewportTop: 0,
      });
    };
    main.addEventListener('scroll', onScroll, { passive: true });
    return () => main.removeEventListener('scroll', onScroll);
  }, [editor, scale]);
  // #endregion

  const currentFont = editor?.getAttributes('textStyle')?.fontFamily ?? '';
  const currentTextColor = editor?.getAttributes('textStyle')?.color ?? '';
  const currentHighlight = editor?.getAttributes('highlight')?.color ?? '';
  const calloutAttributes = editor?.getAttributes('callout') ?? {};
  const currentCallout = calloutAttributes.variant ?? '';
  const currentCalloutBackground = calloutAttributes.background ?? '';
  const currentCalloutBorder = calloutAttributes.border ?? '';

  async function handleImageUpload(event: React.ChangeEvent<HTMLInputElement>) {
    if (!onUploadImage || !editor) return;
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploadError(null);
    setIsUploading(true);
    try {
      const url = await onUploadImage(file);
      editor.chain().focus().setImage({ src: url }).run();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось загрузить изображение';
      setUploadError(message);
    } finally {
      setIsUploading(false);
    }
  }

  if (!editor) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">
        Редактор загружается...
      </div>
    );
  }

  const useScale = scale < 1 && scale > 0;
  const editorColumn = (
    <div className="min-w-0 flex-[5] self-stretch rounded-xl border border-gray-200 bg-white shadow-sm">
      {uploadError && (
        <div className="border-b border-gray-100 px-4 py-2 text-xs text-red-600">
          {uploadError}
        </div>
      )}
      <div className={`px-4 py-5 ${disabled ? 'opacity-70' : ''}`}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );

  return (
    <div className="flex w-full max-w-full items-start gap-4">
      {useScale ? (
        <div
          className="shrink-0 overflow-hidden rounded-xl"
          style={{ width: EDITOR_BASE_WIDTH * scale }}
        >
          <div
            style={{
              width: EDITOR_BASE_WIDTH,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          >
            {editorColumn}
          </div>
        </div>
      ) : (
        editorColumn
      )}
      <div
        ref={toolbarColumnRef}
        className="flex-[1] min-w-[200px] shrink-0 self-start"
        style={{ minHeight: toolbarHeight || 1 }}
      >
        <div style={{ height: toolbarHeight || 0 }} aria-hidden />
        <div
          ref={(el) => {
            fixedToolbarRef.current = el;
            stickyToolbarRef.current = el;
          }}
          className="min-w-[200px] rounded-xl border border-gray-200 bg-gray-50/50 shadow-sm"
          style={{ position: 'fixed', top: 255, left: fixedLeft, zIndex: 10 }}
        >
          <div className="grid grid-cols-2 gap-x-2 gap-y-3 p-4 content-start">
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          active={editor.isActive('bold')}
          title="Жирный"
        >
          B
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleItalic().run()}
          active={editor.isActive('italic')}
          title="Курсив"
        >
          I
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          active={editor.isActive('underline')}
          title="Подчеркивание"
        >
          U
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleStrike().run()}
          active={editor.isActive('strike')}
          title="Зачеркивание"
        >
          S
        </ToolbarButton>

        <div className="col-span-2 h-px bg-gray-200" aria-hidden />

        <ToolbarButton
          onClick={() => editor.chain().focus().setParagraph().run()}
          active={editor.isActive('paragraph')}
          title="Обычный текст"
        >
          P
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          active={editor.isActive('heading', { level: 2 })}
          title="Заголовок H2"
        >
          H2
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          active={editor.isActive('heading', { level: 3 })}
          title="Заголовок H3"
        >
          H3
        </ToolbarButton>

        <div className="col-span-2 h-px bg-gray-200" aria-hidden />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          active={editor.isActive('bulletList')}
          title="Маркированный список"
        >
          ••
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          active={editor.isActive('orderedList')}
          title="Нумерованный список"
        >
          1.
        </ToolbarButton>

        <div className="col-span-2 h-px bg-gray-200" aria-hidden />

        <div className="col-span-2 flex items-center gap-3">
          <span className="w-20 shrink-0 text-xs font-medium text-gray-600">Шрифт</span>
          <select
            key={`font-${toolbarTick}`}
            value={currentFont}
            onChange={(event) => {
              const value = event.target.value;
              if (!value) {
                editor.chain().focus().unsetFontFamily().run();
                return;
              }
              editor.chain().focus().setFontFamily(value).run();
            }}
            className={`${toolbarInputBase} flex-1`}
          >
            {REGLAMENT_FONT_OPTIONS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="col-span-2 flex items-center gap-3">
          <span className="w-20 shrink-0 text-xs font-medium text-gray-600">Цвет текста</span>
          <select
            key={`color-${toolbarTick}`}
            value={currentTextColor}
            onChange={(event) => {
              const value = event.target.value;
              if (!value) {
                editor.chain().focus().unsetColor().run();
                return;
              }
              editor.chain().focus().setColor(value).run();
            }}
            className={`${toolbarInputBase} flex-1`}
          >
            <option value="">Сбросить</option>
            {REGLAMENT_TEXT_COLORS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="col-span-2 flex items-center gap-3">
          <span className="w-20 shrink-0 text-xs font-medium text-gray-600">Выделение</span>
          <select
            key={`highlight-${toolbarTick}`}
            value={currentHighlight}
            onChange={(event) => {
              const value = event.target.value;
              if (!value) {
                editor.chain().focus().unsetHighlight().run();
                return;
              }
              editor.chain().focus().toggleHighlight({ color: value }).run();
            }}
            className={`${toolbarInputBase} flex-1`}
          >
            <option value="">Сбросить</option>
            {REGLAMENT_HIGHLIGHT_COLORS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="col-span-2 flex items-center gap-3">
          <span className="w-20 shrink-0 text-xs font-medium text-gray-600">Блок</span>
          <select
            key={`callout-${toolbarTick}`}
            value={currentCallout}
            onChange={(event) => {
              const value = event.target.value;
              if (!value) {
                editor.chain().focus().unsetCallout().run();
                return;
              }
              const attrs = {
                variant: value,
                background: value === 'custom' ? currentCalloutBackground : null,
                border: value === 'custom' ? currentCalloutBorder : null,
              };
              const chain = editor.chain().focus();
              if (!editor.isActive('callout')) {
                chain.setCallout(value);
              }
              chain.updateAttributes('callout', attrs).run();
            }}
            className={`${toolbarInputBase} flex-1`}
          >
            <option value="">Снять</option>
            {REGLAMENT_CALLOUT_VARIANTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="col-span-2 flex items-center gap-3">
          <span className="w-20 shrink-0 text-xs font-medium text-gray-600">Фон</span>
          <input
            type="color"
            value={currentCalloutBackground || '#EEF2FF'}
            onChange={(event) => {
              const value = event.target.value;
              const chain = editor.chain().focus();
              if (!editor.isActive('callout')) {
                chain.setCallout('custom');
              }
              chain.updateAttributes('callout', {
                variant: 'custom',
                background: value,
                border: currentCalloutBorder || null,
              }).run();
            }}
            className="h-8 w-10 cursor-pointer rounded-md border border-gray-200 bg-white p-0.5 shadow-sm"
            title="Цвет фона блока"
          />
        </div>

        <div className="col-span-2 flex items-center gap-3">
          <span className="w-20 shrink-0 text-xs font-medium text-gray-600">Рамка</span>
          <input
            type="color"
            value={currentCalloutBorder || '#C7D2FE'}
            onChange={(event) => {
              const value = event.target.value;
              const chain = editor.chain().focus();
              if (!editor.isActive('callout')) {
                chain.setCallout('custom');
              }
              chain.updateAttributes('callout', {
                variant: 'custom',
                background: currentCalloutBackground || null,
                border: value,
              }).run();
            }}
            className="h-8 w-10 cursor-pointer rounded-md border border-gray-200 bg-white p-0.5 shadow-sm"
            title="Цвет рамки блока"
          />
        </div>

        <div className="col-span-2 h-px bg-gray-200" aria-hidden />

        <ToolbarButton
          onClick={() => {
            const previousUrl = editor.getAttributes('link').href as string | undefined;
            const url = window.prompt('Ссылка', previousUrl ?? '');
            if (url === null) return;
            if (!url.trim()) {
              editor.chain().focus().unsetLink().run();
              return;
            }
            editor.chain().focus().setLink({ href: url.trim() }).run();
          }}
          active={editor.isActive('link')}
          title="Ссылка"
        >
          Ссылка
        </ToolbarButton>

        <ToolbarButton
          onClick={() => fileInputRef.current?.click()}
          disabled={!onUploadImage || isUploading}
          title="Вставить картинку"
        >
          {isUploading ? 'Загрузка...' : 'Картинка'}
        </ToolbarButton>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleImageUpload}
        />

        <ToolbarButton
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
          title="Отменить"
        >
          Отменить
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
          title="Повторить"
        >
          Повторить
        </ToolbarButton>
      </div>
        </div>
      </div>
    </div>
  );
}
