'use client';

import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import { DEFAULT_REGLAMENT_CONTENT, REGLAMENT_EXTENSIONS } from '@/lib/reglamentEditor';

type ReglamentRendererProps = {
  content: JSONContent | null | undefined;
};

export function ReglamentRenderer({ content }: ReglamentRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popover, setPopover] = useState<{ text: string; left: number; top: number } | null>(null);

  const editor = useEditor({
    extensions: REGLAMENT_EXTENSIONS,
    content: content ?? DEFAULT_REGLAMENT_CONTENT,
    editable: false,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'reglament-content space-y-5 sm:space-y-6 reglament-prose',
      },
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(content ?? DEFAULT_REGLAMENT_CONTENT, { emitUpdate: false });
  }, [content, editor]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const handleClick = (e: MouseEvent) => {
      const trigger = (e.target as HTMLElement).closest('.reglament-popover-trigger') as HTMLElement | null;
      if (!trigger) {
        setPopover(null);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const text = trigger.dataset.popoverContent ?? '';
      if (!text.trim()) return;
      const rect = trigger.getBoundingClientRect();
      setPopover({ text, left: rect.left, top: rect.bottom + 4 });
    };

    const handleOutside = (e: MouseEvent) => {
      if (popoverRef.current?.contains(e.target as Node)) return;
      setPopover(null);
    };

    root.addEventListener('click', handleClick, true);
    document.addEventListener('click', handleOutside);
    document.addEventListener('keydown', (e) => e.key === 'Escape' && setPopover(null));
    return () => {
      root.removeEventListener('click', handleClick, true);
      document.removeEventListener('click', handleOutside);
    };
  }, [content]);

  if (!editor) return null;

  return (
    <div ref={containerRef} className="relative">
      <EditorContent editor={editor} />
      {popover && (
        <div
          ref={popoverRef}
          className="fixed z-50 max-w-sm rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 shadow-lg"
          style={{ left: popover.left, top: popover.top }}
          role="tooltip"
        >
          {popover.text.split('\n').map((line, i) => (
            <p key={i} className={i > 0 ? 'mt-1' : ''}>
              {line}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
