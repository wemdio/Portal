import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { isGisSignalsClient } from '@/lib/gisSignalOutreach/access';
import { GisSignalsDashboard } from '@/components/gis-signals/GisSignalsDashboard';

/**
 * /client/gis-signals — закрытый дашборд отчётности пайплайна «2GIS + сигналы».
 *
 * Виден ровно одному клиенту (profiles.id = gis_signal_pipeline_config
 * .client_user_id, синглтон id=1). Всем остальным — notFound(): существование
 * страницы не раскрываем (ни 403, ни редиректа).
 *
 * Гейт серверный (сессия из cookie через @supabase/ssr — тот же механизм, что
 * в middleware). Данные клиентский компонент тянет через
 * /api/client/gis-signals — там тот же гейт повторно, как у всех страниц
 * клиентского портала (client/dashboard и др. работают через clientApiFetch).
 */
export default async function GisSignalsPage() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase env is not configured (NEXT_PUBLIC_SUPABASE_URL/ANON_KEY).');
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      // Server Component не может писать куки — сессию обновляет middleware.
      setAll() {},
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !(await isGisSignalsClient(user.id))) {
    notFound();
  }

  return <GisSignalsDashboard />;
}
