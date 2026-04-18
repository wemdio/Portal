'use client';

import { useCallback, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { FileUp, X, FileText } from 'lucide-react';

const MAX_BRIEF_FILE_BYTES = 20 * 1024 * 1024;

interface ProjectBriefUploaderProps {
  file: File | null;
  onFileChange: (file: File | null) => void;
  disabled?: boolean;
  hint?: string;
}

/**
 * Reusable PDF picker card used by NewProjectPage (deferred upload) and
 * ProjectPage (immediate upload). The card itself does NOT call the API —
 * the parent decides when/how to upload the chosen file.
 */
export function ProjectBriefUploader({
  file,
  onFileChange,
  disabled,
  hint,
}: ProjectBriefUploaderProps) {
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const acceptFile = useCallback(
    (candidate: File | null | undefined) => {
      setError(null);
      if (!candidate) return;
      if (!candidate.name.toLowerCase().endsWith('.pdf') && !candidate.type.includes('pdf')) {
        setError('Файл должен быть в формате PDF');
        return;
      }
      if (candidate.size > MAX_BRIEF_FILE_BYTES) {
        setError('Файл слишком большой (макс 20 МБ)');
        return;
      }
      onFileChange(candidate);
    },
    [onFileChange],
  );

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const next = event.dataTransfer.files?.[0];
    acceptFile(next);
  };

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`relative rounded-xl border-2 border-dashed p-6 transition-colors ${
          dragOver
            ? 'border-blue-500 bg-blue-50/40'
            : 'border-gray-300 bg-gray-50 hover:border-blue-400'
        } ${disabled ? 'opacity-60 pointer-events-none' : ''}`}
      >
        {file ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex-shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full bg-blue-100 text-blue-600">
                <FileText className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{file.name}</p>
                <p className="text-xs text-gray-500">
                  {(file.size / 1024 / 1024).toFixed(2)} МБ · PDF
                </p>
              </div>
            </div>
            {!disabled && (
              <button
                type="button"
                onClick={() => {
                  onFileChange(null);
                  if (inputRef.current) inputRef.current.value = '';
                }}
                className="inline-flex items-center justify-center w-8 h-8 rounded-full text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                title="Убрать файл"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="w-full text-left flex items-center gap-3"
            disabled={disabled}
          >
            <div className="flex-shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full bg-white border border-gray-200 text-gray-500">
              <FileUp className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">
                Перетащите PDF или нажмите, чтобы выбрать
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                Макс. 20 МБ. На основе брифа AI один раз сгенерирует гипотезы по сбору базы.
              </p>
            </div>
          </button>
        )}

        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => acceptFile(e.target.files?.[0])}
          disabled={disabled}
        />
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-600">{error}</p>
      )}
      {hint && !error && (
        <p className="mt-2 text-xs text-gray-400">{hint}</p>
      )}
    </div>
  );
}
