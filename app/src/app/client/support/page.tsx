import { headers } from 'next/headers';
import { isEngAppHost } from '@/lib/engMarket';
import { SupportChat } from './SupportChat';

/**
 * /client/support — чат клиента с командой (сам чат — SupportChat).
 *
 * Серверная обёртка ради одного факта — хоста запроса: на ENG-хосте
 * (app.outreachos.xyz) страница обязана быть английской уже в серверном HTML,
 * а клиентский layout узнаёт хост только в браузере. Тот же признак, что у
 * middleware (isEngAppHost). На остальных хостах engHost=false, и серверный
 * HTML — прежний RU-текст.
 */
export default async function ClientSupportPage() {
  const engHost = isEngAppHost((await headers()).get('host'));
  return <SupportChat engHost={engHost} />;
}
