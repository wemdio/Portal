import type { JSONContent } from '@tiptap/core';

type ContentNode = { type?: string; content?: unknown[]; attrs?: Record<string, unknown> };

const SECTION_COLOR_VARIANTS = [
  'blue',
  'violet',
  'emerald',
  'amber',
  'rose',
  'cyan',
] as const;

/** Оборачивает секции (h1/h2 + контент до следующего h1/h2) в sectionBlock с циклическими цветовыми вариантами */
export function wrapSectionsInBlocks(content: JSONContent): JSONContent {
  if (!content?.content || !Array.isArray(content.content)) return content;
  const nodes = content.content as ContentNode[];
  const result: ContentNode[] = [];
  let i = 0;
  let sectionIndex = 0;

  const isSectionStart = (n: ContentNode) =>
    n?.type === 'heading' && [1, 2].includes((n.attrs as { level?: number })?.level ?? 0);

  while (i < nodes.length) {
    const node = nodes[i];
    if (isSectionStart(node)) {
      const sectionContent: ContentNode[] = [node];
      i += 1;
      while (i < nodes.length) {
        const next = nodes[i];
        if (isSectionStart(next)) break;
        sectionContent.push(next);
        i += 1;
      }
      const variant = SECTION_COLOR_VARIANTS[sectionIndex % SECTION_COLOR_VARIANTS.length];
      result.push({
        type: 'sectionBlock',
        attrs: { class: `section-card section-${variant}` },
        content: sectionContent,
      });
      sectionIndex++;
    } else {
      result.push(node);
      i += 1;
    }
  }

  return { ...content, content: result };
}
