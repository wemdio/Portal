'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import {
  TRANSLATABLE_TARGET_LOCALES,
  type Locale,
  type TargetLocale,
} from '@/lib/i18n';

/**
 * GlobalTextTranslator — on-the-fly UI translator.
 *
 * Source language is Russian. When the user picks a non-Russian locale, this
 * component:
 *   1. Walks the DOM and collects every text node + translatable attribute
 *      that contains Cyrillic.
 *   2. Splits collected strings into "in localStorage cache" and "missing".
 *   3. POSTs missing strings to /api/portal/translate. While the request is
 *      in flight, sets `data-portal-translating="1"` on <html> so the
 *      LanguageLoadingOverlay component can block the UI.
 *   4. Applies translations to the DOM (text nodes + attributes) and stores
 *      pristine source values on the nodes so we can restore on locale=ru.
 *   5. Installs a MutationObserver to translate any text added later
 *      (route changes, modals, lazy-loaded content). New strings outside
 *      the cache are batched and fetched on a short debounce.
 *
 * Why a runtime DOM translator and not key-based i18n? The codebase has
 * ~1500 hardcoded Russian strings spread across hundreds of components.
 * Migrating every one to a translation key would touch the entire portal.
 * The runtime approach + LLM-backed cache is good enough for the immediate
 * problem (broken English + 4 new languages on demand) and leaves the door
 * open to a proper key-based migration later — at which point this
 * component becomes the fallback for unkeyed strings, not the primary
 * mechanism.
 *
 * Storage layout (localStorage):
 *   portal-i18n:v1:<lang>  →  { [source]: translated }
 *
 * The cache is per-language and grows as the user navigates. We cap it at
 * ~5000 entries to keep localStorage usage under ~500KB per language.
 */

const ATTRS_TO_TRANSLATE = ['placeholder', 'title', 'aria-label'] as const;
const ORIG_TEXT = '__i18n_orig__';
const ORIG_ATTR = '__i18n_attr__';
const CACHE_VERSION = 'v1';
const CACHE_MAX_ENTRIES = 5000;
const BATCH_DEBOUNCE_MS = 150;
const TRANSLATING_FLAG = 'data-portal-translating';

const useDomEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

function isTargetLocale(value: Locale): value is TargetLocale {
  return (TRANSLATABLE_TARGET_LOCALES as readonly string[]).includes(value);
}

/**
 * Whether the TEXT CONTENT of `el`'s children should be ignored. Skips
 * containers whose visible text is either code, machine output, or user-typed
 * input — translating those would corrupt them. <textarea> is here because its
 * text node IS the user's draft.
 */
export function shouldSkipTextIn(el: Element | null): boolean {
  if (!el) return true;
  const tag = el.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CODE' || tag === 'PRE' || tag === 'TEXTAREA') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  // The loading overlay opts out via [data-i18n-skip] so the MutationObserver
  // doesn't try to translate (now non-existent) overlay copy.
  if (el.closest?.('[data-i18n-skip]')) return true;
  return false;
}

/**
 * Whether the translatable ATTRIBUTES on `el` should be ignored. Narrower than
 * the text-node rule: <textarea>/<code>/<pre> can legitimately carry
 * `placeholder`/`title`/`aria-label` strings authored by us, and those should
 * absolutely be translated even though their child text is off-limits.
 */
export function shouldSkipAttrsOn(el: Element | null): boolean {
  if (!el) return true;
  const tag = el.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE') return true;
  if (el.closest?.('[data-i18n-skip]')) return true;
  return false;
}

function needsTranslation(s: string | null | undefined): boolean {
  if (!s) return false;
  if (!s.trim()) return false;
  // Cyrillic-bearing only: ASCII labels, brand names, numbers stay verbatim.
  return /[Ѐ-ӿ]/.test(s);
}

function cacheKey(lang: TargetLocale): string {
  return `portal-i18n:${CACHE_VERSION}:${lang}`;
}

function readCache(lang: TargetLocale): Map<string, string> {
  if (typeof window === 'undefined') return new Map();
  try {
    const raw = window.localStorage.getItem(cacheKey(lang));
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function writeCache(lang: TargetLocale, cache: Map<string, string>): void {
  if (typeof window === 'undefined') return;
  try {
    // Trim oldest entries if we're over the cap. Iteration order on Map is
    // insertion order, so dropping from the front discards the earliest
    // entries — good enough as an LRU approximation without tracking access.
    if (cache.size > CACHE_MAX_ENTRIES) {
      const keep = Array.from(cache).slice(-CACHE_MAX_ENTRIES);
      cache = new Map(keep);
    }
    const obj: Record<string, string> = {};
    for (const [k, v] of cache) obj[k] = v;
    window.localStorage.setItem(cacheKey(lang), JSON.stringify(obj));
  } catch {
    // QuotaExceededError etc. — drop silently, next pass will repopulate.
  }
}

interface TranslateResponse {
  translations?: Record<string, string>;
  error?: string;
}

async function fetchTranslations(
  strings: string[],
  targetLang: TargetLocale,
): Promise<Record<string, string>> {
  if (strings.length === 0) return {};
  try {
    const res = await authFetch('/api/portal/translate', {
      method: 'POST',
      body: JSON.stringify({ target_lang: targetLang, strings }),
    });
    if (!res.ok) {
      console.warn('[i18n] /api/portal/translate failed:', res.status);
      return {};
    }
    const data = (await res.json()) as TranslateResponse;
    return data.translations ?? {};
  } catch (err) {
    console.warn('[i18n] /api/portal/translate threw:', err);
    return {};
  }
}

function getOrigText(node: Text): string | undefined {
  return (node as unknown as Record<string, string | undefined>)[ORIG_TEXT];
}

function setOrigText(node: Text, value: string): void {
  (node as unknown as Record<string, string>)[ORIG_TEXT] = value;
}

function getOrigAttrs(el: Element): Record<string, string> | undefined {
  return (el as unknown as Record<string, Record<string, string> | undefined>)[ORIG_ATTR];
}

function setOrigAttrs(el: Element, value: Record<string, string>): void {
  (el as unknown as Record<string, Record<string, string>>)[ORIG_ATTR] = value;
}

function clearOrigText(node: Text): void {
  delete (node as unknown as Record<string, string | undefined>)[ORIG_TEXT];
}

function clearOrigAttrs(el: Element): void {
  delete (el as unknown as Record<string, Record<string, string> | undefined>)[ORIG_ATTR];
}

export function GlobalTextTranslator({ locale }: { locale: Locale }) {
  // The overlay reads this flag from <html> via CSS attribute selector and
  // shows itself while translation is pending. Component re-renders on
  // locale change so the effect can clean up the previous pass.
  const [, setTick] = useState(0);
  const aliveRef = useRef(true);
  const pendingRef = useRef<Set<string>>(new Set());
  const debounceRef = useRef<number | null>(null);
  const inFlightCountRef = useRef(0);

  // Effect re-runs on every locale change. On RU it restores originals;
  // on a target locale it performs a full DOM walk and translates.
  useDomEffect(() => {
    if (typeof document === 'undefined') return;
    aliveRef.current = true;

    // --- Mode A: source language. Restore originals and stop. ----------
    if (!isTargetLocale(locale)) {
      const tw = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      );
      let n: Node | null;
      while ((n = tw.nextNode())) {
        if (n.nodeType === Node.TEXT_NODE) {
          const node = n as Text;
          const orig = getOrigText(node);
          if (typeof orig === 'string') {
            if (node.nodeValue !== orig) node.nodeValue = orig;
            clearOrigText(node);
          }
        } else if (n.nodeType === Node.ELEMENT_NODE) {
          const el = n as Element;
          const orig = getOrigAttrs(el);
          if (!orig) continue;
          for (const attr of ATTRS_TO_TRANSLATE) {
            if (attr in orig) el.setAttribute(attr, orig[attr]!);
          }
          clearOrigAttrs(el);
        }
      }
      document.documentElement.removeAttribute(TRANSLATING_FLAG);
      return () => {
        aliveRef.current = false;
      };
    }

    // --- Mode B: target language. Full walk + translate. ---------------
    const targetLang = locale;

    const startPending = () => {
      inFlightCountRef.current += 1;
      document.documentElement.setAttribute(TRANSLATING_FLAG, '1');
    };
    const finishPending = () => {
      inFlightCountRef.current = Math.max(0, inFlightCountRef.current - 1);
      if (inFlightCountRef.current === 0) {
        document.documentElement.removeAttribute(TRANSLATING_FLAG);
      }
    };

    // Cache loaded once per locale change; new entries merged in.
    const cache = readCache(targetLang);

    // Collect untranslated strings discovered during DOM walks.
    const collectQueue: Array<{ kind: 'text'; node: Text } | { kind: 'attr'; el: Element; attr: string }> = [];

    const collectText = (node: Text) => {
      if (shouldSkipTextIn(node.parentElement)) return;
      const raw = node.nodeValue;
      if (!needsTranslation(raw)) return;
      // Save original once.
      if (typeof getOrigText(node) !== 'string') setOrigText(node, raw!);
      const original = getOrigText(node)!;
      const cached = cache.get(original);
      if (cached !== undefined) {
        node.nodeValue = cached;
      } else {
        pendingRef.current.add(original);
        collectQueue.push({ kind: 'text', node });
      }
    };

    const collectAttrs = (el: Element) => {
      if (shouldSkipAttrsOn(el)) return;
      let existing = getOrigAttrs(el);
      for (const attr of ATTRS_TO_TRANSLATE) {
        const v = el.getAttribute(attr);
        if (!needsTranslation(v)) continue;
        if (!existing) {
          existing = {};
          setOrigAttrs(el, existing);
        }
        if (!(attr in existing)) existing[attr] = v!;
        const original = existing[attr]!;
        const cached = cache.get(original);
        if (cached !== undefined) {
          el.setAttribute(attr, cached);
        } else {
          pendingRef.current.add(original);
          collectQueue.push({ kind: 'attr', el, attr });
        }
      }
    };

    const walk = (root: Node) => {
      if (root.nodeType === Node.TEXT_NODE) {
        collectText(root as Text);
        return;
      }
      if (root.nodeType === Node.ELEMENT_NODE) collectAttrs(root as Element);
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      let n: Node | null;
      while ((n = tw.nextNode())) {
        if (n.nodeType === Node.TEXT_NODE) collectText(n as Text);
        else if (n.nodeType === Node.ELEMENT_NODE) collectAttrs(n as Element);
      }
    };

    const applyTranslations = (map: Record<string, string>) => {
      // Merge into cache for next visit + persist.
      let changed = false;
      for (const [src, tgt] of Object.entries(map)) {
        if (cache.get(src) !== tgt) {
          cache.set(src, tgt);
          changed = true;
        }
      }
      if (changed) writeCache(targetLang, cache);
      // Apply to anything in the live DOM that still shows the source.
      const tw = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      );
      let n: Node | null;
      while ((n = tw.nextNode())) {
        if (n.nodeType === Node.TEXT_NODE) {
          const node = n as Text;
          const orig = getOrigText(node);
          if (!orig) continue;
          const tgt = cache.get(orig);
          if (tgt !== undefined && node.nodeValue !== tgt) node.nodeValue = tgt;
        } else if (n.nodeType === Node.ELEMENT_NODE) {
          const el = n as Element;
          const orig = getOrigAttrs(el);
          if (!orig) continue;
          for (const attr of ATTRS_TO_TRANSLATE) {
            const o = orig[attr];
            if (!o) continue;
            const tgt = cache.get(o);
            if (tgt !== undefined && el.getAttribute(attr) !== tgt) {
              el.setAttribute(attr, tgt);
            }
          }
        }
      }
    };

    const flushPending = async () => {
      const batch = Array.from(pendingRef.current);
      pendingRef.current.clear();
      if (batch.length === 0) return;
      startPending();
      try {
        const map = await fetchTranslations(batch, targetLang);
        if (!aliveRef.current) return;
        // Identity-fallback for anything the API didn't return — prevents
        // the loop from re-queueing the same string forever on a failed call.
        for (const s of batch) {
          if (!(s in map)) map[s] = s;
        }
        applyTranslations(map);
      } finally {
        finishPending();
      }
    };

    const scheduleFlush = () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        void flushPending();
      }, BATCH_DEBOUNCE_MS);
    };

    // --- Initial full-page pass ---------------------------------------
    walk(document.body);
    if (collectQueue.length > 0 || pendingRef.current.size > 0) {
      // Flush synchronously for the first pass so the overlay shows
      // immediately and dismisses as soon as the initial batch resolves.
      void flushPending();
    }

    // --- Observer for late-added content -------------------------------
    const observer = new MutationObserver((muts) => {
      if (!aliveRef.current) return;
      let touched = false;
      for (const m of muts) {
        if (m.type === 'characterData') {
          collectText(m.target as Text);
          touched = true;
          continue;
        }
        if (m.type === 'attributes') {
          collectAttrs(m.target as Element);
          touched = true;
          continue;
        }
        for (const node of m.addedNodes) {
          walk(node);
          touched = true;
        }
      }
      if (touched && pendingRef.current.size > 0) scheduleFlush();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...ATTRS_TO_TRANSLATE],
    });

    // Trigger an overlay re-render on mount so consumers can react.
    setTick((t) => t + 1);

    return () => {
      aliveRef.current = false;
      observer.disconnect();
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      pendingRef.current.clear();
      inFlightCountRef.current = 0;
      document.documentElement.removeAttribute(TRANSLATING_FLAG);
    };
  }, [locale]);

  return null;
}

/**
 * Full-screen loading overlay shown while the translator is fetching
 * missing strings from the API. Driven purely by the
 * `data-portal-translating` attribute on <html> — set by GlobalTextTranslator
 * around its API calls.
 *
 * Intentionally text-free: any visible copy would have to live in the source
 * language (Russian) and would leak the fact that the UI is being translated
 * on the fly. A bare spinner on a page-coloured backdrop reads as a generic
 * "page is loading" state in every locale.
 */
export function LanguageLoadingOverlay() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    const update = () => setActive(html.hasAttribute(TRANSLATING_FLAG));
    update();
    const observer = new MutationObserver(update);
    observer.observe(html, { attributes: true, attributeFilter: [TRANSLATING_FLAG] });
    return () => observer.disconnect();
  }, []);

  const style = useMemo<React.CSSProperties>(
    () => ({
      position: 'fixed',
      inset: 0,
      zIndex: 9999,
      display: active ? 'flex' : 'none',
      alignItems: 'center',
      justifyContent: 'center',
      // Page-coloured, opaque-enough to hide the still-Russian content
      // underneath without looking like a modal dialog.
      backgroundColor: 'rgba(255, 255, 255, 0.92)',
      backdropFilter: 'blur(2px)',
      WebkitBackdropFilter: 'blur(2px)',
      pointerEvents: active ? 'auto' : 'none',
    }),
    [active],
  );

  return (
    <div
      data-i18n-skip
      role="status"
      aria-live="polite"
      aria-busy={active}
      style={style}
    >
      <div
        style={{
          width: 36,
          height: 36,
          border: '3px solid rgba(37, 99, 235, 0.18)',
          borderTopColor: '#2563eb',
          borderRadius: '50%',
          animation: 'portal-i18n-spin 0.8s linear infinite',
        }}
      />
      <style>{`@keyframes portal-i18n-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
