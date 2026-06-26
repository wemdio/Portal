import type { Metadata } from 'next';
import { PasswordChangeForm } from './PasswordChangeForm';

export const metadata: Metadata = { title: 'Настройки — Portal' };

export default function ClientSettingsPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-10 p-6">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-wider text-neutral-500">01 → аккаунт</p>
        <h1 className="text-2xl font-semibold text-neutral-100">Настройки</h1>
      </header>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-medium text-neutral-100">Сменить пароль</h2>
          <p className="mt-1 text-sm text-neutral-400">
            После смены мы пришлём уведомление с новым паролем на email вашего аккаунта.
          </p>
        </div>
        <PasswordChangeForm />
      </section>
    </div>
  );
}
