import { useId, type ReactNode } from 'react';

type Props = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  className?: string;
  labelClassName?: string;
  id?: string;
};

export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  label,
  className = '',
  labelClassName = '',
  id,
}: Props) {
  const autoId = useId();
  const inputId = id ?? autoId;

  return (
    <label
      htmlFor={inputId}
      className={[
        'inline-flex items-start gap-3 text-sm text-gray-700 select-none group',
        disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer',
        labelClassName,
      ].join(' ')}
    >
      <div className={['relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2', 
        checked ? 'bg-blue-600' : 'bg-gray-200',
        className
      ].join(' ')}>
        <input
          id={inputId}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onCheckedChange(e.target.checked)}
          className="sr-only"
        />
        <span
          aria-hidden="true"
          className={[
            'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
            checked ? 'translate-x-5' : 'translate-x-0'
          ].join(' ')}
        />
      </div>
      {label ? <span className="min-w-0 pt-0.5 leading-snug">{label}</span> : null}
    </label>
  );
}
