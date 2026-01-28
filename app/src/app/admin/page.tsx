'use client';

import { useState } from 'react';
import { uploadCSV } from '@/lib/csvUpload';
import { Upload, CheckCircle, AlertCircle, Loader2, Users, FileSpreadsheet } from 'lucide-react';
import Link from 'next/link';

export default function AdminPage() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error' | 'warning' | null; message: string; details?: string[] }>({ type: null, message: '' });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFile(e.target.files[0]);
      setStatus({ type: null, message: '' });
    }
  };

  const handleUpload = async () => {
    if (!file) return;

    setUploading(true);
    setStatus({ type: null, message: '' });

    try {
      const result = await uploadCSV(file);
      if (result.count > 0) {
        setStatus({ type: 'success', message: `Успешно импортировано проектов: ${result.count}` });
        setFile(null);
      } else {
        setStatus({ 
          type: 'warning', 
          message: 'Файл прочитан, но проекты не найдены. Возможно, не совпали заголовки.',
          details: result.headers 
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ошибка при загрузке CSV';
      console.error(error);
      setStatus({ type: 'error', message });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto py-10 px-4">
      <h1 className="text-3xl font-bold mb-8 text-gray-900">Админ панель</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <Link 
          href="/admin/users"
          className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm hover:shadow-md hover:border-blue-300 transition-all group"
        >
          <div className="flex items-center mb-4">
            <div className="p-3 rounded-lg bg-blue-100 group-hover:bg-blue-200 transition-colors">
              <Users className="h-6 w-6 text-blue-600" />
            </div>
            <div className="ml-4">
              <h2 className="text-lg font-semibold text-gray-900">Управление пользователями</h2>
              <p className="text-sm text-gray-500">Создание пользователей и назначение ролей</p>
            </div>
          </div>
          <p className="text-sm text-blue-600 font-medium">Перейти →</p>
        </Link>

        <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
          <div className="flex items-center mb-4">
            <div className="p-3 rounded-lg bg-green-100">
              <FileSpreadsheet className="h-6 w-6 text-green-600" />
            </div>
            <div className="ml-4">
              <h2 className="text-lg font-semibold text-gray-900">Импорт данных</h2>
              <p className="text-sm text-gray-500">Загрузка проектов из CSV</p>
            </div>
          </div>
        </div>
      </div>
      
      <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
        <h2 className="text-xl font-semibold mb-4 text-gray-900">Импорт проектов из CSV</h2>
        <p className="text-gray-500 mb-6 text-sm">
          Загрузите ваш Excel файл (сохраненный как CSV), чтобы заполнить базу данных.
          <br/>Убедитесь, что первая строка содержит заголовки: Название, Статус проекта, Контролирует и т.д.
        </p>

        <div className="flex items-center space-x-4">
          <input
            type="file"
            accept=".csv"
            onChange={handleFileChange}
            className="block w-full text-sm text-gray-500
              file:mr-4 file:py-2 file:px-4
              file:rounded-md file:border-0
              file:text-sm file:font-semibold
              file:bg-blue-50 file:text-blue-700
              hover:file:bg-blue-100"
          />
          <button
            onClick={handleUpload}
            disabled={!file || uploading}
            className="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {uploading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Импорт...
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                Загрузить данные
              </>
            )}
          </button>
        </div>

        {status.type === 'success' && (
          <div className="mt-4 p-4 rounded-md bg-green-50 border border-green-200 flex items-center text-green-700">
            <CheckCircle className="h-5 w-5 mr-2" />
            {status.message}
          </div>
        )}

        {status.type === 'warning' && (
          <div className="mt-4 p-4 rounded-md bg-yellow-50 border border-yellow-200 text-yellow-800">
            <div className="flex items-center">
              <AlertCircle className="h-5 w-5 mr-2" />
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
            <AlertCircle className="h-5 w-5 mr-2" />
            {status.message}
          </div>
        )}
      </div>
    </div>
  );
}
