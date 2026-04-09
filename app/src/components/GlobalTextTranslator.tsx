'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { translateKnownRuToEn } from '@/lib/globalTranslations';

type Locale = 'ru' | 'en';

const ATTRS_TO_TRANSLATE = ['placeholder', 'title', 'aria-label'] as const;
const ORIG_TEXT = '__i18n_orig__';
const ORIG_ATTR = '__i18n_attr__';

const useDomEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

function shouldSkip(el: Element | null): boolean {
  if (!el) return true;
  const tag = el.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CODE' || tag === 'PRE' || tag === 'TEXTAREA') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export function GlobalTextTranslator({ locale }: { locale: Locale }) {
  const enabledRef = useRef(true);

  useDomEffect(() => {
    if (typeof document === 'undefined') return;

    enabledRef.current = true;

    const processText = (node: Text) => {
      if (!enabledRef.current) return;
      if (shouldSkip(node.parentElement)) return;
      const raw = node.nodeValue;
      if (!raw || !raw.trim()) return;

      if (locale === 'en') {
        const translated = translateKnownRuToEn(raw);
        if (translated !== raw) {
          if (!(ORIG_TEXT in node)) {
            (node as unknown as Record<string, string>)[ORIG_TEXT] = raw;
          }
          node.nodeValue = translated;
        }
      } else {
        const saved = (node as unknown as Record<string, string>)[ORIG_TEXT];
        if (typeof saved === 'string') {
          if (node.nodeValue !== saved) node.nodeValue = saved;
          delete (node as unknown as Record<string, string>)[ORIG_TEXT];
        }
      }
    };

    const processAttrs = (el: Element) => {
      if (!enabledRef.current) return;
      if (shouldSkip(el)) return;

      if (locale === 'en') {
        const existing = (el as unknown as Record<string, Record<string, string>>)[ORIG_ATTR] ?? {};
        let changed = false;
        for (const attr of ATTRS_TO_TRANSLATE) {
          const v = el.getAttribute(attr);
          if (!v) continue;
          const t = translateKnownRuToEn(v);
          if (t !== v) {
            if (!(attr in existing)) { existing[attr] = v; changed = true; }
            el.setAttribute(attr, t);
          }
        }
        if (changed) (el as unknown as Record<string, Record<string, string>>)[ORIG_ATTR] = existing;
      } else {
        const saved = (el as unknown as Record<string, Record<string, string>>)[ORIG_ATTR];
        if (!saved) return;
        for (const attr of ATTRS_TO_TRANSLATE) {
          if (attr in saved) el.setAttribute(attr, saved[attr]);
        }
        delete (el as unknown as Record<string, Record<string, string>>)[ORIG_ATTR];
      }
    };

    const walk = (root: Node) => {
      if (!enabledRef.current) return;
      if (root.nodeType === Node.TEXT_NODE) { processText(root as Text); return; }
      if (root.nodeType === Node.ELEMENT_NODE) processAttrs(root as Element);
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      let n: Node | null;
      while ((n = tw.nextNode())) {
        if (n.nodeType === Node.TEXT_NODE) processText(n as Text);
        else if (n.nodeType === Node.ELEMENT_NODE) processAttrs(n as Element);
      }
    };

    walk(document.body);

    const observer = new MutationObserver((muts) => {
      if (!enabledRef.current) return;
      for (const m of muts) {
        if (m.type === 'characterData') { processText(m.target as Text); continue; }
        if (m.type === 'attributes') { processAttrs(m.target as Element); continue; }
        for (const node of m.addedNodes) walk(node);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...ATTRS_TO_TRANSLATE],
    });

    return () => {
      enabledRef.current = false;
      observer.disconnect();
    };
  }, [locale]);

  return null;
}
