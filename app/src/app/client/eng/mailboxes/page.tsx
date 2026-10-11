import { redirect } from 'next/navigation';

/**
 * /client/eng/mailboxes — экрана больше нет (решение владельца 11.10.2026):
 * кампании ENG-кабинета шлют только из ящиков нашего пула
 * (engSendingPreset.ensureHeEngPresetForProject), подключать свои ящики
 * клиенту незачем, и пункта в меню нет (lib/clientNav.ts). Старые ссылки и
 * закладки ведут на Command Center.
 *
 * Строки client_mailbox_accounts, подключённые раньше, не трогаются. RU-экран
 * /client/mailboxes — отдельная страница, она не меняется. Прежний экран
 * (список подключённых и скрытая форма) — в истории Git до этого коммита.
 */
export default function EngMailboxesRedirectPage() {
  redirect('/client/eng/dashboard');
}
