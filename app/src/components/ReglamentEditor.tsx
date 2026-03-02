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
const CUSTOM_FONTS_STORAGE_KEY = 'reglament-custom-fonts';

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

type ColorSwatch = { label: string; value: string };

const toolbarInputBase =
  'h-8 min-w-0 rounded-md border border-gray-200 bg-white px-2.5 text-xs text-gray-700 shadow-sm transition focus:border-gray-300 focus:outline-none focus:ring-1 focus:ring-gray-200';

function ToolbarButton({ onClick, active, disabled, title, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => { e.preventDefault(); if (!disabled) onClick(); }}
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

function ColorPalette({
  colors,
  value,
  onChange,
  allowCustom = true,
  columns = 5,
}: {
  colors: ColorSwatch[];
  value: string;
  onChange: (color: string) => void;
  allowCustom?: boolean;
  columns?: number;
}) {
  const customColorRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isCustom = Boolean(value && !colors.some((c) => c.value.toLowerCase() === value.toLowerCase()));

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const handleCustomChange = (val: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onChange(val), 80);
  };

  return (
    <div className="space-y-1.5">
      <div
        className="grid gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {colors.map((color) => {
          const isActive = color.value.toLowerCase() === value.toLowerCase();
          return (
            <button
              key={color.value}
              type="button"
              title={color.label}
              onMouseDown={(e) => { e.preventDefault(); onChange(color.value); }}
              className="relative rounded transition-transform hover:scale-110 focus:outline-none"
              style={{
                aspectRatio: '1',
                background: color.value,
                border: isActive ? '2px solid #111827' : '1px solid rgba(0,0,0,0.12)',
                boxShadow: isActive ? '0 0 0 1.5px white inset' : undefined,
              }}
              aria-label={color.label}
              aria-pressed={isActive}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          title="Сбросить цвет"
          onMouseDown={(e) => { e.preventDefault(); onChange(''); }}
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded border border-gray-300 bg-white text-[11px] text-gray-400 hover:border-gray-400 hover:text-gray-600"
        >
          ✕
        </button>
        {allowCustom && (
          <label
            className="flex h-[22px] cursor-pointer items-center gap-1 rounded border border-dashed border-gray-300 px-1.5 text-[10px] text-gray-500 hover:border-gray-400"
            title="Произвольный цвет"
          >
            <span
              className="block h-3.5 w-3.5 shrink-0 rounded-full border border-gray-300"
              style={{ background: isCustom ? value : 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }}
            />
            <span>Свой</span>
            <input
              ref={customColorRef}
              type="color"
              defaultValue={isCustom ? value : '#3b82f6'}
              onChange={(e) => handleCustomChange(e.target.value)}
              className="sr-only"
            />
          </label>
        )}
        {value && (
          <span
            className="ml-auto flex h-[22px] items-center gap-1 rounded border border-gray-200 px-1.5 text-[10px] text-gray-500"
          >
            <span
              className="block h-3 w-3 shrink-0 rounded-full border border-gray-300"
              style={{ background: value }}
            />
            {value}
          </span>
        )}
      </div>
    </div>
  );
}

export function ReglamentEditor({ content, onChange, onUploadImage, disabled = false, scale = 1 }: ReglamentEditorProps) {
  const [toolbarTick, setToolbarTick] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [showButtonModal, setShowButtonModal] = useState(false);
  const [buttonForm, setButtonForm] = useState({ label: 'Кнопка', href: 'https://', style: 'primary' });
  const [showPopoverModal, setShowPopoverModal] = useState(false);
  const [popoverForm, setPopoverForm] = useState({ triggerText: 'Подсказка', popoverContent: '' });
  const [customFonts, setCustomFonts] = useState<{ label: string; value: string }[]>([]);
  const [fontUploadError, setFontUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fontFileInputRef = useRef<HTMLInputElement>(null);
  const lastContentRef = useRef<string>(JSON.stringify(content ?? DEFAULT_REGLAMENT_CONTENT));
  const stickyToolbarRef = useRef<HTMLDivElement>(null);
  const toolbarColumnRef = useRef<HTMLDivElement>(null);
  const fixedToolbarRef = useRef<HTMLDivElement>(null);
  const editorContentBlockRef = useRef<HTMLDivElement>(null);
  const [panelPosition, setPanelPosition] = useState({ left: 0, top: 100, scale: 1 });

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

  // Restore custom fonts from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(CUSTOM_FONTS_STORAGE_KEY);
      if (!stored) return;
      const fonts = JSON.parse(stored) as { name: string; dataUrl: string }[];
      Promise.all(
        fonts.map(async ({ name, dataUrl }) => {
          try {
            const fontFace = new FontFace(name, `url(${dataUrl})`);
            await fontFace.load();
            document.fonts.add(fontFace);
            return { label: name, value: name };
          } catch {
            return null;
          }
        })
      ).then((results) => {
        const loaded = results.filter(Boolean) as { label: string; value: string }[];
        if (loaded.length) setCustomFonts(loaded);
      });
    } catch {
      // ignore parse errors
    }
  }, []);

  async function handleFontUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFontUploadError(null);

    if (file.size > 6 * 1024 * 1024) {
      setFontUploadError('Шрифт слишком большой (максимум 6 МБ)');
      return;
    }

    const fontName = file.name.replace(/\.[^.]+$/, '');
    try {
      const arrayBuffer = await file.arrayBuffer();
      const fontFace = new FontFace(fontName, arrayBuffer);
      await fontFace.load();
      document.fonts.add(fontFace);

      // Encode as base64 dataUrl for persistence
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      const ext = file.name.split('.').pop()?.toLowerCase() ?? 'ttf';
      const mimeMap: Record<string, string> = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
      const dataUrl = `data:${mimeMap[ext] ?? 'font/ttf'};base64,${base64}`;

      try {
        const stored = localStorage.getItem(CUSTOM_FONTS_STORAGE_KEY);
        const existing: { name: string; dataUrl: string }[] = stored ? JSON.parse(stored) : [];
        const updated = existing.filter((f) => f.name !== fontName);
        updated.push({ name: fontName, dataUrl });
        localStorage.setItem(CUSTOM_FONTS_STORAGE_KEY, JSON.stringify(updated));
      } catch {
        // localStorage full — font works for this session only
      }

      setCustomFonts((prev) => {
        const filtered = prev.filter((f) => f.value !== fontName);
        return [...filtered, { label: fontName, value: fontName }];
      });
      editor?.chain().focus().setFontFamily(fontName).run();
    } catch (err) {
      console.error('Font load error', err);
      setFontUploadError('Не удалось загрузить шрифт');
    }
  }

  function removeCustomFont(fontName: string) {
    try {
      const stored = localStorage.getItem(CUSTOM_FONTS_STORAGE_KEY);
      if (stored) {
        const existing: { name: string; dataUrl: string }[] = JSON.parse(stored);
        localStorage.setItem(CUSTOM_FONTS_STORAGE_KEY, JSON.stringify(existing.filter((f) => f.name !== fontName)));
      }
    } catch { /* ignore */ }
    setCustomFonts((prev) => prev.filter((f) => f.value !== fontName));
    if (currentFont === fontName) editor?.chain().focus().unsetFontFamily().run();
  }

  const MIN_TOP = 80;

  useLayoutEffect(() => {
    const col = toolbarColumnRef.current;
    const panel = fixedToolbarRef.current;
    const updatePosition = () => {
      if (!col) return;
      const colRect = col.getBoundingClientRect();
      const left = colRect.left;
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
      const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
      const padding = 24;
      const scale = Math.min(1, Math.max(0.7, vw / 1280));
      const editorTop = editorContentBlockRef.current?.getBoundingClientRect().top ?? colRect.top;
      const minTop = Math.max(MIN_TOP, editorTop);
      const top = minTop;
      setPanelPosition((prev) =>
        prev.left === left && prev.top === top && prev.scale === scale ? prev : { left, top, scale }
      );
    };
    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    const main = typeof document !== 'undefined' ? document.querySelector('main') : null;
    if (main) main.addEventListener('scroll', updatePosition, true);
    const ro = panel ? new ResizeObserver(updatePosition) : null;
    if (panel && ro) ro.observe(panel);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
      if (main) main.removeEventListener('scroll', updatePosition, true);
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

  useEffect(() => {
    if (!showButtonModal && !showPopoverModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowButtonModal(false);
        setShowPopoverModal(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showButtonModal, showPopoverModal]);

  const currentFont = editor?.getAttributes('textStyle')?.fontFamily ?? '';
  const currentTextColor = editor?.getAttributes('textStyle')?.color ?? '';
  const currentHighlight = editor?.getAttributes('highlight')?.color ?? '';
  const calloutAttributes = editor?.getAttributes('callout') ?? {};
  const currentCallout = calloutAttributes.variant ?? '';
  const currentCalloutBackground = calloutAttributes.background ?? '';
  const currentCalloutBorder = calloutAttributes.border ?? '';
  const buttonAttrs = editor?.getAttributes('reglamentButton') ?? {};
  const popoverAttrs = editor?.getAttributes('reglamentPopover') ?? {};

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

  const handleInsertButton = () => {
    const { label, href, style } = buttonForm;
    const attrs = { label: label.trim() || 'Кнопка', href: href.trim() || '#', style };
    if (editor.schema.nodes.reglamentButton) {
      editor.chain().focus().splitBlock().setNode('reglamentButton', attrs).run();
    } else {
      const pos = editor.state.selection.$from.after();
      editor.chain().focus().insertContentAt(pos, [{ type: 'reglamentButton', attrs }, { type: 'paragraph', content: [] }]).run();
    }
    setShowButtonModal(false);
  };

  const handleInsertPopover = () => {
    const trigger = popoverForm.triggerText.trim() || 'Подсказка';
    const content = popoverForm.popoverContent.trim();
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'reglamentPopover',
        attrs: { popoverContent: content },
        content: [{ type: 'text', text: trigger }],
      })
      .run();
    setShowPopoverModal(false);
    setPopoverForm({ triggerText: 'Подсказка', popoverContent: '' });
  };

  return (
    <>
    <div className="flex w-full max-w-full items-start gap-4">
      {useScale ? (
        <div
          ref={editorContentBlockRef}
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
        <div ref={editorContentBlockRef} className="min-w-0 flex-[5] self-stretch rounded-xl border border-gray-200 bg-white shadow-sm">
          {uploadError && (
            <div className="border-b border-gray-100 px-4 py-2 text-xs text-red-600">
              {uploadError}
            </div>
          )}
          <div className={`px-4 py-5 ${disabled ? 'opacity-70' : ''}`}>
            <EditorContent editor={editor} />
          </div>
        </div>
      )}
      <div
        ref={toolbarColumnRef}
        className="flex-[1] min-w-[200px] shrink-0 self-stretch"
      >
        <div
          ref={(el) => {
            fixedToolbarRef.current = el;
            stickyToolbarRef.current = el;
          }}
          className="z-10 min-w-[200px] origin-top-right rounded-xl border border-gray-200 bg-gray-50/50 shadow-sm overflow-y-auto w-fit transition-[top,left,transform] duration-150 ease-out"
          style={{
            position: 'fixed',
            left: panelPosition.left,
            top: panelPosition.top,
            transform: `scale(${panelPosition.scale})`,
            maxHeight: `calc((100vh - ${panelPosition.top + 20}px) / ${panelPosition.scale})`,
          }}
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

        <ToolbarButton
          onClick={() => {
            setButtonForm({ label: 'Кнопка', href: 'https://', style: 'primary' });
            setShowButtonModal(true);
          }}
          title="Вставить кнопку"
        >
          Кнопка
        </ToolbarButton>
        <ToolbarButton
          onClick={() => {
            setPopoverForm({ triggerText: 'Подсказка', popoverContent: '' });
            setShowPopoverModal(true);
          }}
          title="Вставить всплывающую подсказку"
        >
          Подсказка
        </ToolbarButton>

        <div className="col-span-2 h-px bg-gray-200" aria-hidden />

        {/* Font selector + custom font upload */}
        <div className="col-span-2 space-y-1">
          <span className="text-xs font-medium text-gray-600">Шрифт</span>
          <div className="flex items-center gap-1">
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
              className={`${toolbarInputBase} min-w-0 flex-1`}
            >
              {REGLAMENT_FONT_OPTIONS.map((option) => (
                <option key={option.label} value={option.value} style={{ fontFamily: option.value || undefined }}>
                  {option.label}
                </option>
              ))}
              {customFonts.length > 0 && (
                <optgroup label="Пользовательские">
                  {customFonts.map((f) => (
                    <option key={f.value} value={f.value} style={{ fontFamily: f.value }}>
                      {f.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <button
              type="button"
              title="Загрузить шрифт (.ttf, .otf, .woff, .woff2)"
              onClick={() => fontFileInputRef.current?.click()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-dashed border-gray-300 bg-white text-gray-500 hover:border-blue-400 hover:text-blue-600 transition"
            >
              +
            </button>
            <input
              ref={fontFileInputRef}
              type="file"
              accept=".ttf,.otf,.woff,.woff2"
              className="hidden"
              onChange={handleFontUpload}
            />
          </div>
          {fontUploadError && (
            <p className="text-[10px] text-red-600">{fontUploadError}</p>
          )}
          {customFonts.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {customFonts.map((f) => (
                <span
                  key={f.value}
                  className="flex items-center gap-0.5 rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[10px] text-gray-600"
                  style={{ fontFamily: f.value }}
                >
                  {f.label}
                  <button
                    type="button"
                    title="Удалить шрифт"
                    onClick={() => removeCustomFont(f.value)}
                    className="ml-0.5 text-gray-400 hover:text-red-500"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Text color palette */}
        <div className="col-span-2 space-y-1">
          <span className="text-xs font-medium text-gray-600">Цвет текста</span>
          <ColorPalette
            colors={REGLAMENT_TEXT_COLORS}
            value={currentTextColor}
            columns={5}
            onChange={(value) => {
              if (!value) {
                editor.chain().focus().unsetColor().run();
              } else {
                editor.chain().focus().setColor(value).run();
              }
            }}
          />
        </div>

        {/* Highlight color palette */}
        <div className="col-span-2 space-y-1">
          <span className="text-xs font-medium text-gray-600">Выделение</span>
          <ColorPalette
            colors={REGLAMENT_HIGHLIGHT_COLORS}
            value={currentHighlight}
            columns={5}
            onChange={(value) => {
              if (!value) {
                editor.chain().focus().unsetHighlight().run();
              } else {
                editor.chain().focus().toggleHighlight({ color: value }).run();
              }
            }}
          />
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

        {editor.isActive('reglamentButton') && (
          <>
            <div className="col-span-2 h-px bg-gray-200" aria-hidden />
            <div className="col-span-2 text-xs font-medium text-gray-600">Кнопка</div>
            <div className="col-span-2 flex flex-col gap-2">
              <input
                key={`btn-label-${toolbarTick}`}
                type="text"
                value={buttonAttrs.label ?? ''}
                onChange={(e) => editor.chain().focus().updateAttributes('reglamentButton', { label: e.target.value }).run()}
                placeholder="Текст кнопки"
                className={toolbarInputBase}
              />
              <input
                key={`btn-href-${toolbarTick}`}
                type="text"
                value={buttonAttrs.href ?? ''}
                onChange={(e) => editor.chain().focus().updateAttributes('reglamentButton', { href: e.target.value }).run()}
                placeholder="https://..."
                className={toolbarInputBase}
              />
              <select
                key={`btn-style-${toolbarTick}`}
                value={buttonAttrs.style ?? 'primary'}
                onChange={(e) => editor.chain().focus().updateAttributes('reglamentButton', { style: e.target.value }).run()}
                className={toolbarInputBase}
              >
                <option value="primary">Основная</option>
                <option value="secondary">Вторичная</option>
                <option value="outline">Рамка</option>
              </select>
            </div>
          </>
        )}

        {editor.isActive('reglamentPopover') && (
          <>
            <div className="col-span-2 h-px bg-gray-200" aria-hidden />
            <div className="col-span-2 text-xs font-medium text-gray-600">Текст подсказки</div>
            <div className="col-span-2">
              <textarea
                key={`popover-${toolbarTick}`}
                value={popoverAttrs.popoverContent ?? ''}
                onChange={(e) => editor.chain().focus().updateAttributes('reglamentPopover', { popoverContent: e.target.value }).run()}
                placeholder="Инструкция при клике..."
                rows={3}
                className={`${toolbarInputBase} w-full resize-y`}
              />
            </div>
          </>
        )}

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

    {showButtonModal && (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
        onClick={() => setShowButtonModal(false)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="button-modal-title"
      >
        <div
          className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 id="button-modal-title" className="text-lg font-semibold text-gray-900 mb-4">
            Вставить кнопку
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Текст кнопки</label>
              <input
                type="text"
                value={buttonForm.label}
                onChange={(e) => setButtonForm((f) => ({ ...f, label: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                placeholder="Кнопка"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Ссылка (URL)</label>
              <input
                type="url"
                value={buttonForm.href}
                onChange={(e) => setButtonForm((f) => ({ ...f, href: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                placeholder="https://"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Стиль</label>
              <select
                value={buttonForm.style}
                onChange={(e) => setButtonForm((f) => ({ ...f, style: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              >
                <option value="primary">Основная (синяя)</option>
                <option value="secondary">Вторичная (серая)</option>
                <option value="outline">Рамка</option>
              </select>
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowButtonModal(false)}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={handleInsertButton}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Вставить
            </button>
          </div>
        </div>
      </div>
    )}

    {showPopoverModal && (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
        onClick={() => setShowPopoverModal(false)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="popover-modal-title"
      >
        <div
          className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 id="popover-modal-title" className="text-lg font-semibold text-gray-900 mb-4">
            Вставить подсказку
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Текст ссылки (что видно в документе)</label>
              <input
                type="text"
                value={popoverForm.triggerText}
                onChange={(e) => setPopoverForm((f) => ({ ...f, triggerText: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                placeholder="Подсказка"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Текст подсказки (всплывает по клику)</label>
              <textarea
                value={popoverForm.popoverContent}
                onChange={(e) => setPopoverForm((f) => ({ ...f, popoverContent: e.target.value }))}
                className="w-full min-h-[100px] resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                placeholder="Инструкция при клике..."
              />
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowPopoverModal(false)}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={handleInsertPopover}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Вставить
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
