'use client';

import { useEffect } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import { DEFAULT_REGLAMENT_CONTENT, REGLAMENT_EXTENSIONS } from '@/lib/reglamentEditor';

type ReglamentRendererProps = {
  content: JSONContent | null | undefined;
};

export function ReglamentRenderer({ content }: ReglamentRendererProps) {
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
    editor.commands.setContent(content ?? DEFAULT_REGLAMENT_CONTENT, false);
  }, [content, editor]);

  if (!editor) return null;

  return <EditorContent editor={editor} />;
}
