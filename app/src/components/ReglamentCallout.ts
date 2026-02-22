import { mergeAttributes, Node } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (variant: string) => ReturnType;
      toggleCallout: (variant: string) => ReturnType;
      unsetCallout: () => ReturnType;
    };
  }
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      variant: {
        default: 'info',
        parseHTML: (element) => (element as HTMLElement).dataset.variant ?? 'info',
      },
      background: {
        default: null,
        parseHTML: (element) =>
          (element as HTMLElement).dataset.bg || (element as HTMLElement).style.backgroundColor || null,
      },
      border: {
        default: null,
        parseHTML: (element) =>
          (element as HTMLElement).dataset.border || (element as HTMLElement).style.borderColor || null,
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },
  renderHTML({ HTMLAttributes }) {
    const { variant, background, border, class: className, ...rest } = HTMLAttributes as Record<string, string>;
    const attrs: Record<string, string> = {
      ...rest,
      'data-callout': '',
      'data-variant': variant,
    };

    if (background) {
      attrs['data-bg'] = background;
    }
    if (border) {
      attrs['data-border'] = border;
    }

    const styles: string[] = [];
    if (background) styles.push(`background-color: ${background}`);
    if (border) styles.push(`border-color: ${border}`);
    if (styles.length) {
      attrs.style = styles.join('; ');
    }

    return [
      'div',
      mergeAttributes(attrs, {
        class: className ? `${className} reglament-callout` : 'reglament-callout',
      }),
      0,
    ];
  },
  addCommands() {
    return {
      setCallout:
        (variant: string) =>
        ({ commands }) =>
          commands.wrapIn(this.name, { variant }),
      toggleCallout:
        (variant: string) =>
        ({ commands }) =>
          commands.toggleWrap(this.name, { variant }),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },
});
