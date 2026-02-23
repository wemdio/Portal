'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { uploadCSV } from '@/lib/csvUpload';
import { logAudit, logError } from '@/lib/loggerClient';
import { useIsTma } from '@/lib/useIsTma';

export default function AdminImportPage() {
  const isTma = useIsTma();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error' | 'warning' | null; message: string; details?: string[] }>({
    type: null,
    message: '',
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFile(e.target.files[0] ?? null);
      setStatus({ type: null, message: '' });
    }
  };

  const handleUpload = async () => {
    if (!file) return;

    setUploading(true);
    setStatus({ type: null, message: '' });

    try {
      void logAudit('admin.csv.upload.start', 'CSV upload started', {
        fileName: file.name,
        fileSize: file.size,
      });
      const result = await uploadCSV(file);
      if (result.count > 0) {
        setStatus({ type: 'success', message: `Успешно импортировано проектов: ${result.count}` });
        setFile(null);
        void logAudit('admin.csv.upload.success', 'CSV upload completed', { count: result.count });
      } else {
        setStatus({
          type: 'warning',
          message: 'Файл прочитан, но проекты не найдены. Возможно, не совпали заголовки.',
          details: result.headers,
        });
        void logAudit('admin.csv.upload.empty', 'CSV upload completed with no rows', {
          headers: result.headers ?? [],
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ошибка при загрузке CSV';
      void logError('admin.csv.upload.failed', error, { fileName: file.name, fileSize: file.size });
      setStatus({ type: 'error', message });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className={`max-w-6xl mx-auto px-4 ${isTma ? 'py-6 text-sm leading-relaxed' : 'py-10'}`}>
      <div className="mb-6">
        <Link href="/admin" className="text-sm font-medium text-blue-600 hover:text-blue-700">
          ← Назад в админку
        </Link>
      </div>

      <div className={`bg-white rounded-xl border border-gray-200 shadow-sm ${isTma ? 'p-4' : 'p-6'}`}>
        <h1 className={`${isTma ? 'text-xl' : 'text-2xl'} font-bold mb-4 text-gray-900`}>Импорт проектов из CSV</h1>
        <p className="text-gray-500 mb-6 text-sm">
          Загрузите ваш Excel файл (сохраненный как CSV), чтобы заполнить базу данных.
          <br />Убедитесь, что первая строка содержит заголовки: Название, Статус проекта, Контролирует и т.д.
        </p>

        <div className={`flex items-center ${isTma ? 'flex-col gap-3' : 'gap-4 justify-between'}`}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={handleFileChange}
            className="hidden"
          />
          <div className={`flex items-center min-w-0 ${isTma ? 'w-full gap-3' : 'gap-4'}`}>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center justify-center rounded-md border border-gray-200 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100"
            >
              Выбрать файл
            </button>
            <span className="text-sm text-gray-500 truncate">
              {file?.name || 'Файл не выбран'}
            </span>
          </div>
          <button
            onClick={handleUpload}
            disabled={!file || uploading}
            className={`inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${isTma ? 'w-full' : 'ml-auto'}`}
          >
            {uploading ? 'Импорт...' : 'Загрузить данные'}
          </button>
        </div>

        {status.type === 'success' && (
          <div className="mt-4 p-4 rounded-md bg-green-50 border border-green-200 flex items-center text-green-700">
            {status.message}
          </div>
        )}

        {status.type === 'warning' && (
          <div className="mt-4 p-4 rounded-md bg-yellow-50 border border-yellow-200 text-yellow-800">
            <div className="flex items-center">
              {status.message}
            </div>
            {status.details && (
              <div className="mt-2 text-xs font-mono bg-yellow-100 p-2 rounded overflow-auto">
                <p className="font-semibold">Обнаруженные заголовки в файле:</p>
                <p>{status.details.join(', ')}</p>
                <p className="mt-2 font-semibold">Ожидаемые (пример):</p>
                <p>Название, Статус проекта, Контролирует...</p>
              </div>
            )}
          </div>
        )}

        {status.type === 'error' && (
          <div className="mt-4 p-4 rounded-md bg-red-50 border border-red-200 flex items-center text-red-700">
            {status.message}
          </div>
        )}
      </div>
    </div>
  );
}

