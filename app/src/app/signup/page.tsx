import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { isEngAppHost } from '@/lib/engMarket';
import { SignupForm } from './SignupForm';

/**
 * Заголовок вкладки и description на ENG-хосте — английские (у гостя без
 * куки локали корневой layout отдаёт русский description). Вне ENG-хоста —
 * пустой объект: остаётся то, что задаёт корневой layout, как раньше.
 */
export async function generateMetadata(): Promise<Metadata> {
  if (!isEngAppHost((await headers()).get('host'))) return {};
  return { title: 'Create your account', description: 'Create your outreachOS account.' };
}

/**
 * /signup — саморегистрация (сама форма — SignupForm).
 *
 * Серверная обёртка ради одного факта — хоста запроса, как у
 * app/client/support/page.tsx: на ENG-хосте (app.outreachos.xyz) страница
 * обязана быть английской уже в серверном HTML. Тот же признак, что у
 * middleware (isEngAppHost). На остальных хостах engHost=false, и форма —
 * прежняя русская, без изменений.
 */
export default async function SignupPage() {
  const engHost = isEngAppHost((await headers()).get('host'));
  return <SignupForm engHost={engHost} />;
}
