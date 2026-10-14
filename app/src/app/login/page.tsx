import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { isEngAppHost } from '@/lib/engMarket';
import { LoginForm, type EngSignInNext } from './LoginForm';

/**
 * Единственный `?next=`, который вход принимает, и только на ENG-хосте.
 * Сюда ведут ссылка «Set your own password» из письма сброса
 * (api/auth/forgot-password, ветка ENG: /login?next=/client/eng/account) и
 * middleware, когда гость на ENG-хосте открывает /client/eng/account. Без
 * next после входа он попадал бы в кабинет, а не на смену пароля. Вошедшего
 * клиента с /login?next=<этот адрес> middleware сразу ведёт на Account.
 * Сравнение точное, и в форму уходит эта константа, а не пришедшая строка,
 * поэтому увести на другой адрес или хост (//evil.com, /client/eng/../admin,
 * абсолютный URL) нельзя. Вне ENG-хоста `next` не читается вовсе — RU-вход
 * по-прежнему ведёт на '/'.
 */
const ENG_SIGN_IN_NEXT: EngSignInNext = '/client/eng/account';

/**
 * Заголовок вкладки и description на ENG-хосте — английские (у гостя без
 * куки локали корневой layout отдаёт русский description). Вне ENG-хоста —
 * пустой объект: остаётся то, что задаёт корневой layout, как раньше.
 */
export async function generateMetadata(): Promise<Metadata> {
  if (!isEngAppHost((await headers()).get('host'))) return {};
  return { title: 'Sign in', description: 'Sign in to your outreachOS account.' };
}

/**
 * /login — вход (сама форма — LoginForm).
 *
 * Серверная обёртка ради одного факта — хоста запроса, как у
 * app/client/support/page.tsx: на ENG-хосте (app.outreachos.xyz) страница
 * обязана быть английской уже в серверном HTML. Тот же признак, что у
 * middleware (isEngAppHost). На остальных хостах engHost=false, и форма —
 * прежняя русская: те же строки, та же разметка.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const engHost = isEngAppHost((await headers()).get('host'));
  const next = engHost ? (await searchParams).next : undefined;
  if (next === ENG_SIGN_IN_NEXT) {
    return <LoginForm engHost={engHost} afterSignIn={ENG_SIGN_IN_NEXT} />;
  }
  return <LoginForm engHost={engHost} />;
}
