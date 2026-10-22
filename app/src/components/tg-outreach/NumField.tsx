'use client';

import { useEffect, useState, type InputHTMLAttributes } from 'react';

/**
 * Числовое поле, которое можно стереть и вписать заново.
 *
 * Обычный `<input type="number" value={n}>` с `Number(e.target.value)` не даёт
 * очистить поле: пустая строка превращается в 0, и новая цифра дописывается к
 * нулю («012»). Здесь строка живёт в самом поле, а наружу число уходит только
 * когда оно настоящее и в границах; пустое поле остаётся пустым, пока оператор
 * печатает, и на выходе из поля возвращается в допустимые границы.
 */
export function NumField({
  value,
  onChange,
  min,
  max,
  className,
  ...rest
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max' | 'type'>) {
  const [text, setText] = useState(String(value));

  // Значение сверху изменилось не от нас (загрузка, сброс) — подхватываем.
  useEffect(() => {
    setText((prev) => (prev !== '' && Number(prev) === value ? prev : String(value)));
  }, [value]);

  return (
    <input
      {...rest}
      type="text"
      inputMode="numeric"
      value={text}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D+/g, '').slice(0, 4);
        if (digits === '') {
          setText('');
          return;
        }
        const n = Number(digits);
        // Больше потолка — сразу потолок. Меньше нижней границы — оставляем как
        // набрано: «1» на пути к «12» не должно превращаться в минимум, в
        // границы вернём на выходе из поля.
        if (n > max) {
          setText(String(max));
          onChange(max);
          return;
        }
        setText(digits);
        if (n >= min) onChange(n);
      }}
      onFocus={(e) => e.target.select()}
      onBlur={() => {
        const n = text === '' ? value : Math.min(max, Math.max(min, Number(text)));
        setText(String(n));
        if (n !== value) onChange(n);
      }}
      className={className}
    />
  );
}
