'use client';

import { useEffect, useRef, useState } from 'react';
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

type ReglamentEditorProps = {
  content: JSONContent | null | undefined;
  onChange: (content: JSONContent) => void;
  onUploadImage?: (file: File) => Promise<string>;
  disabled?: boolean;
};

type ToolbarButtonProps = {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
};

function ToolbarButton({ onClick, active, disabled, title, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center rounded-md border px-2.5 py-1 text-xs font-medium transition
        ${active ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      `}
    >
      {children}
    </button>
  );
}

export function ReglamentEditor({ content, onChange, onUploadImage, disabled = false }: ReglamentEditorProps) {
  const [toolbarTick, setToolbarTick] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastContentRef = useRef<string>(JSON.stringify(content ?? DEFAULT_REGLAMENT_CONTENT));

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
      editor.commands.setContent(content ?? DEFAULT_REGLAMENT_CONTENT, false);
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

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex flex-nowrap sm:flex-wrap items-center gap-2 border-b border-gray-100 bg-gray-50 px-4 py-3 overflow-x-auto sm:overflow-visible">
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

        <div className="h-5 w-px bg-gray-200" aria-hidden />

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

        <div className="h-5 w-px bg-gray-200" aria-hidden />

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

        <div className="h-5 w-px bg-gray-200" aria-hidden />

        <label className="flex items-center gap-2 text-xs font-medium text-gray-600">
          Шрифт
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
            className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700"
          >
            {REGLAMENT_FONT_OPTIONS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs font-medium text-gray-600">
          Цвет текста
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
            className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700"
          >
            <option value="">Сбросить</option>
            {REGLAMENT_TEXT_COLORS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs font-medium text-gray-600">
          Выделение
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
            className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700"
          >
            <option value="">Сбросить</option>
            {REGLAMENT_HIGHLIGHT_COLORS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs font-medium text-gray-600">
          Блок
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
            className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700"
          >
            <option value="">Снять</option>
            {REGLAMENT_CALLOUT_VARIANTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs font-medium text-gray-600">
          Фон
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
            className="h-6 w-8 cursor-pointer rounded border border-gray-200 bg-white p-0"
            title="Цвет фона блока"
          />
        </label>

        <label className="flex items-center gap-2 text-xs font-medium text-gray-600">
          Рамка
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
            className="h-6 w-8 cursor-pointer rounded border border-gray-200 bg-white p-0"
            title="Цвет рамки блока"
          />
        </label>

        <div className="h-5 w-px bg-gray-200" aria-hidden />

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

        <div className="ml-auto flex items-center gap-2">
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
}
