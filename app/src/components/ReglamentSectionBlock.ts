import { mergeAttributes, Node } from '@tiptap/core';

export const SectionBlock = Node.create({
  name: 'sectionBlock',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      class: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).getAttribute('class'),
      },
      id: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).getAttribute('id'),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'section' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['section', mergeAttributes(HTMLAttributes), 0];
  },
});
