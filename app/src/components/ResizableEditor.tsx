'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

/*
 * Высота поля ответа — «Персонализированные ответы» и «Рассылка» → «Письма».
 * Родная ручка textarea стоит в правом нижнем углу, а поле прижато к низу
 * экрана: тянуть её можно только вверх, и она упирается в край. Поэтому ручка
 * своя — полоса над блоком ответа: тянешь вверх, поле растёт за счёт
 * переписки. Выбранную высоту помним в браузере, двойной щелчок по ручке
 * возвращает исходную. Исходная — с запасом под черновик ИИ целиком: шести
 * строк не хватало даже на короткий ответ.
 */
export const EDITOR_DEFAULT_PX = 320;
const EDITOR_MIN_PX = 120;
/** Столько оставляем шапке, кусочку переписки и кнопкам под полем. */
const EDITOR_RESERVED_PX = 260;
const EDITOR_KEY_STEP_PX = 24;

function editorMaxHeight(panelPx: number): number {
  return Math.max(EDITOR_MIN_PX, panelPx - EDITOR_RESERVED_PX);
}

function clampEditorHeight(px: number, panelPx: number): number {
  return Math.round(Math.min(Math.max(px, EDITOR_MIN_PX), editorMaxHeight(panelPx)));
}

function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // без хранилища просто не запоминаем
  }
}

/**
 * Высота поля и обработчики ручки. rootRef — панель целиком: от её высоты
 * зависит предел, чтобы поле не выдавило кнопки «Отправить» за край.
 */
export function useEditorHeight(
  storageKey: string,
  rootRef: RefObject<HTMLElement | null>,
  /** Исходная высота; у «Писем» Рассылки она ниже — там поле съедало переписку. */
  defaultPx: number = EDITOR_DEFAULT_PX,
) {
  const [editorHeight, setEditorHeight] = useState(defaultPx);
  /** Предел для ручки — зависит от высоты панели, пересчитываем с окном. */
  const [editorMax, setEditorMax] = useState(defaultPx);
  /** Текущая высота без ожидания рендера: её пишем в хранилище по отпусканию ручки. */
  const heightRef = useRef(defaultPx);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const panelHeight = () => rootRef.current?.clientHeight ?? window.innerHeight;
  const applyHeight = (px: number) => {
    heightRef.current = px;
    setEditorHeight(px);
  };

  // Сохранённую высоту читаем после монтирования: на сервере хранилища нет, и
  // разметка до гидрации должна совпасть. Окно сжали — поле ужимаем следом.
  useEffect(() => {
    const panel = () => rootRef.current?.clientHeight ?? window.innerHeight;
    const saved = Number(readStore(storageKey));
    const initial = clampEditorHeight(saved > 0 ? saved : defaultPx, panel());
    heightRef.current = initial;
    setEditorHeight(initial);
    setEditorMax(editorMaxHeight(panel()));
    const onResize = () => {
      const next = clampEditorHeight(heightRef.current, panel());
      heightRef.current = next;
      setEditorHeight(next);
      setEditorMax(editorMaxHeight(panel()));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [storageKey, rootRef, defaultPx]);

  const handleProps = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startY: e.clientY, startHeight: heightRef.current };
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      // Ручка над полем: тянем вверх — поле выше.
      applyHeight(clampEditorHeight(drag.startHeight + (drag.startY - e.clientY), panelHeight()));
    },
    onPointerUp: () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      writeStore(storageKey, String(heightRef.current));
    },
    onPointerCancel: () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      writeStore(storageKey, String(heightRef.current));
    },
    onDoubleClick: () => {
      applyHeight(clampEditorHeight(defaultPx, panelHeight()));
      writeStore(storageKey, null);
    },
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const step = e.key === 'ArrowUp' ? EDITOR_KEY_STEP_PX : -EDITOR_KEY_STEP_PX;
      const next = clampEditorHeight(heightRef.current + step, panelHeight());
      applyHeight(next);
      writeStore(storageKey, String(next));
    },
  };

  return { editorHeight, editorMax, handleProps };
}

/** Ручка высоты — граница между перепиской и блоком ответа. */
export function EditorResizeHandle({
  editorHeight,
  editorMax,
  handleProps,
  className = 'border-gray-100 hover:bg-gray-50 focus-visible:bg-gray-100',
  gripClassName = 'bg-gray-300 group-hover:bg-gray-400',
}: ReturnType<typeof useEditorHeight> & { className?: string; gripClassName?: string }) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Высота поля ответа"
      aria-valuenow={editorHeight}
      aria-valuemin={EDITOR_MIN_PX}
      aria-valuemax={editorMax}
      tabIndex={0}
      title="Потяните вверх, чтобы увеличить поле ответа. Двойной щелчок — исходная высота"
      {...handleProps}
      className={`group flex h-4 shrink-0 cursor-row-resize touch-none select-none items-center justify-center border-t focus:outline-none ${className}`}
    >
      <div className={`h-1 w-10 rounded-full transition ${gripClassName}`} />
    </div>
  );
}
