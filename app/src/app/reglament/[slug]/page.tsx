'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { ReglamentRenderer } from '@/components/ReglamentRenderer';
import { supabase } from '@/lib/supabaseClient';
import { useIsTma } from '@/lib/useIsTma';
import type { ReglamentDocument } from '@/types';
import { LegacyReglamentPage } from '@/app/reglament/page';

type ReglamentDocView = Pick<ReglamentDocument, 'title' | 'content' | 'updated_at' | 'published_at'>;

interface SearchResult {
  id: string;
  title: string;
  context: string;
  sectionId: string;
  searchText: string;
}

const dateFormatter = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' });

function formatDate(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date);
}

function isEmptyContent(content?: ReglamentDocument['content'] | null) {
  if (!content || content.type !== 'doc') return true;
  const nodes = content.content ?? [];
  if (nodes.length === 0) return true;
  if (nodes.length === 1) {
    const first = nodes[0] as { type?: string; content?: unknown[] };
    if (first.type === 'paragraph' && (!first.content || first.content.length === 0)) {
      return true;
    }
  }
  return false;
}

export default function ReglamentDocumentPage() {
  const isTma = useIsTma();
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  const [doc, setDoc] = useState<ReglamentDocView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!slug) return;
    let isMounted = true;

    const loadDocument = async () => {
      setLoading(true);
      setError(null);
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const isUuid = UUID_RE.test(slug);

      const query = supabase
        .from('reglament_documents')
        .select('title, content, updated_at, published_at')
        .eq('status', 'published');

      const { data, error: loadError } = await (isUuid
        ? query.eq('id', slug)
        : query.eq('slug', slug)
      ).single();

      if (!isMounted) return;

      if (loadError || !data) {
        setError(
          loadError
            ? `Ошибка загрузки: ${loadError.message} (код: ${loadError.code})`
            : 'Документ не найден или не опубликован.'
        );
        setLoading(false);
        return;
      }

      setDoc(data as ReglamentDocView);
      setLoading(false);
    };

    void loadDocument();
    return () => {
      isMounted = false;
    };
  }, [slug]);

  const searchInContent = (query: string): SearchResult[] => {
    if (!query.trim() || !contentRef.current) return [];
    const results: SearchResult[] = [];
    const queryLower = query.toLowerCase();
    const walker = window.document.createTreeWalker(
      contentRef.current,
      NodeFilter.SHOW_TEXT,
      null
    );
    const textNodes: Text[] = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent?.trim()) textNodes.push(node as Text);
    }
    textNodes.forEach((textNode, nodeIndex) => {
      const text = textNode.textContent || '';
      const textLower = text.toLowerCase();
      let index = textLower.indexOf(queryLower);
      let title = 'Раздел';
      let currentElement = textNode.parentElement;
      while (currentElement && currentElement !== contentRef.current) {
        const sibling = currentElement.previousElementSibling;
        if (sibling) {
          if (/^H[1-6]$/.test(sibling.tagName)) {
            title = sibling.textContent || 'Раздел';
            break;
          }
          const h = sibling.querySelector?.('h1, h2, h3, h4, h5, h6');
          if (h) {
            title = h.textContent || 'Раздел';
            break;
          }
        }
        if (/^H[1-6]$/.test(currentElement.tagName)) {
          title = currentElement.textContent || 'Раздел';
          break;
        }
        currentElement = currentElement.parentElement;
      }
      while (index !== -1 && results.length < 20) {
        const start = Math.max(0, index - 50);
        const end = Math.min(text.length, index + query.length + 50);
        let context = text.substring(start, end);
        if (start > 0) context = '...' + context;
        if (end < text.length) context = context + '...';
        results.push({
          id: `node-${nodeIndex}-${index}`,
          title,
          context,
          sectionId: nodeIndex.toString(),
          searchText: query,
        });
        index = textLower.indexOf(queryLower, index + 1);
      }
    });
    return results.slice(0, 5);
  };

  const updateSearch = (value: string) => {
    setSearchQuery(value);
    if (!value.trim()) {
      setSearchResults([]);
      setShowResults(false);
      return;
    }
    const results = searchInContent(value);
    setSearchResults(results);
    setShowResults(true);
  };

  const scrollToResult = (result: SearchResult) => {
    setShowResults(false);
    updateSearch('');
    setTimeout(() => {
      if (!contentRef.current) return;
      const textNodes: Text[] = [];
      const walker2 = window.document.createTreeWalker(
        contentRef.current,
        NodeFilter.SHOW_TEXT,
        null
      );
      let n;
      while ((n = walker2.nextNode())) {
        if (n.textContent?.trim()) textNodes.push(n as Text);
      }
      const foundNode = textNodes[parseInt(result.sectionId, 10)] || null;
      if (foundNode) {
        const text = foundNode.textContent || '';
        const idx = text.toLowerCase().indexOf(result.searchText.toLowerCase());
        if (idx !== -1) {
          const range = window.document.createRange();
          range.setStart(foundNode, idx);
          range.setEnd(foundNode, idx + result.searchText.length);
          const scrollTarget = foundNode.parentElement;
          if (scrollTarget) {
            scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
            try {
              const highlight = window.document.createElement('mark');
              highlight.style.backgroundColor = 'rgba(255, 255, 0, 0.6)';
              highlight.style.padding = '2px 0';
              range.surroundContents(highlight);
              setTimeout(() => {
                if (highlight.parentNode) {
                  const parent = highlight.parentNode;
                  parent.replaceChild(
                    window.document.createTextNode(highlight.textContent || ''),
                    highlight
                  );
                  parent.normalize();
                }
              }, 2000);
            } catch {
              // ignore
            }
          }
        }
      }
    }, 100);
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const hasContent = doc && !isEmptyContent(doc.content);

  return (
    <div className={`max-w-5xl mx-auto px-4 ${isTma ? 'py-6 text-sm leading-relaxed' : 'py-10'} bg-slate-50/50 min-h-screen`}>
      <div className="mb-6">
        <Link href="/reglament" className="text-sm font-medium text-blue-600 hover:text-blue-700">
          ← Все регламенты
        </Link>
      </div>

      {loading ? (
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500">
          Загрузка документа...
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          {error}
        </div>
      ) : doc ? (
        <div className="space-y-6">
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-2">{doc.title}</h1>
            <p className="text-xs text-gray-500">
              Опубликовано: {formatDate(doc.published_at)}
            </p>
          </div>

          {hasContent && (
            <div ref={searchContainerRef} className="relative z-30">
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                  <svg className="h-5 w-5 text-gray-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path
                      fillRule="evenodd"
                      d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
                <input
                  type="text"
                  className="block w-full rounded-lg border border-gray-200 bg-white py-2 pl-10 pr-3 text-sm placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="Поиск по регламенту..."
                  value={searchQuery}
                  onChange={(e) => updateSearch(e.target.value)}
                />
                {showResults && searchResults.length > 0 && (
                  <div className="absolute left-0 right-0 top-full z-[100] mt-1 max-h-96 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
                    {searchResults.map((result) => (
                      <button
                        key={result.id}
                        onClick={() => scrollToResult(result)}
                        className="w-full border-b border-gray-100 px-4 py-3 text-left last:border-0 hover:bg-gray-50"
                      >
                        <div className="mb-1 text-xs font-medium text-gray-500">{result.title}</div>
                        <div className="text-sm text-gray-900">
                          {result.context
                            .split(new RegExp(`(${result.searchText})`, 'gi'))
                            .map((part, i) =>
                              part.toLowerCase() === result.searchText.toLowerCase() ? (
                                <mark key={i} className="bg-yellow-200 text-gray-900">
                                  {part}
                                </mark>
                              ) : (
                                part
                              )
                            )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                {showResults && searchQuery && searchResults.length === 0 && (
                  <div className="absolute left-0 right-0 top-full z-[100] mt-1 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-500 shadow-lg">
                    Ничего не найдено
                  </div>
                )}
              </div>
            </div>
          )}

          <div ref={contentRef} className="rounded-xl border border-gray-200 bg-white p-6 sm:p-8 shadow-sm">
            {isEmptyContent(doc.content) ? <LegacyReglamentPage /> : <ReglamentRenderer content={doc.content} />}
          </div>
        </div>
      ) : null}
    </div>
  );
}
