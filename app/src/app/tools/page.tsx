import Link from 'next/link';

export default function ToolsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Инструменты</h1>
        <p className="text-sm text-gray-500">
          Набор утилит для работы с данными и процессами.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Link
          href="/tools/databases"
          className="group rounded-2xl border border-gray-200 bg-white p-6 transition hover:shadow-md"
        >
          <div className="flex items-start gap-3">
            <div>
              <p className="text-base font-semibold text-gray-900">Работа с базами</p>
              <p className="text-sm text-gray-500">
                Табличный редактор с вкладками и копированием.
              </p>
            </div>
          </div>
          <div className="mt-4 text-sm font-medium text-blue-600 group-hover:text-blue-700">
            Открыть →
          </div>
        </Link>
      </div>
    </div>
  );
}
