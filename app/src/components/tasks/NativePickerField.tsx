'use client';

import { useCallback, useRef } from 'react';
import type { Locale } from '@/lib/i18n';

/**
 * Поле даты/времени, которое открывает системный календарь по клику.
 *
 * Голый `<input type="datetime-local">` календарь по клику НЕ открывает: клик
 * по полю лишь ставит курсор в один из сегментов, а всплывашка появляется
 * только по крошечной иконке справа. Поэтому здесь видимое поле — обычный
 * readonly-текст в нужном формате, а рядом лежит настоящий input, которому мы
 * зовём `showPicker()`.
 */
export function openNativePicker(input: HTMLInputElement): void {
  const pickerInput = input as HTMLInputElement & { showPicker?: () => void };
  if (typeof pickerInput.showPicker !== 'function') return;
  try {
    pickerInput.showPicker();
  } catch {
    // Ignore browser/security restrictions and keep native behavior.
  }
}

export function formatDateTimeLocalDisplay(value: string, locale: Locale): string {
  if (!value) return '';
  const [datePart, timePart] = value.split('T');
  if (!datePart) return value;
  const [year, month, day] = datePart.split('-');
  if (!year || !month || !day) return value;
  const time = (timePart ?? '').slice(0, 5);
  if (locale === 'en') {
    return `${month}/${day}/${year}${time ? ` ${time}` : ''}`;
  }
  return `${day}.${month}.${year}${time ? ` ${time}` : ''}`;
}

export function NativePickerField({
  type,
  locale,
  value,
  onChange,
  className,
  placeholderRu,
  placeholderEn,
}: {
  type: 'datetime-local' | 'time';
  locale: Locale;
  value: string;
  onChange: (nextValue: string) => void;
  className: string;
  placeholderRu: string;
  placeholderEn: string;
}) {
  const hiddenRef = useRef<HTMLInputElement>(null);
  const isEn = locale === 'en';
  const displayValue = type === 'time' ? value : formatDateTimeLocalDisplay(value, locale);

  const openPicker = useCallback(() => {
    if (!hiddenRef.current) return;
    hiddenRef.current.focus();
    openNativePicker(hiddenRef.current);
  }, []);

  return (
    <div className="relative">
      <input
        type="text"
        readOnly
        value={displayValue}
        placeholder={isEn ? placeholderEn : placeholderRu}
        // Открываем ТОЛЬКО по клику. Раньше здесь висел ещё и onFocus, а клик
        // мышью порождает оба события подряд: focus открывал календарь, а
        // пришедший следом click открывал его во второй раз — и гасил уже
        // открытый. Отсюда жалоба «с первого раза дата не ставится, нужно
        // нажимать несколько раз». С клавиатуры открывает onKeyDown ниже.
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPicker();
          }
        }}
        className={className}
      />
      <input
        ref={hiddenRef}
        type={type}
        lang={isEn ? 'en-GB' : 'ru-RU'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 opacity-0 pointer-events-none"
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  );
}
