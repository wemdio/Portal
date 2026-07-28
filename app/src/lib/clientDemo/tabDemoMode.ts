'use client';

/**
 * Демо-режим НА ВКЛАДКУ (per-tab), независимый от авторизации.
 *
 * Зачем: сейлз на показе держит рядом две вкладки — обычный клиентский
 * кабинет и демо. Сессия в браузере одна на домен, поэтому два АККАУНТА
 * (демо-логин + клиентский) в одном браузере не уживаются. Решение — не
 * аккаунт, а пометка вкладки: флаг живёт в sessionStorage (он per-tab по
 * спецификации), фронт добавляет заголовок TAB_DEMO_HEADER к запросам,
 * сервер по нему отдаёт демо-фикстуры (см. requireClientAuth).
 *
 * Включается параметром ?demo=1 на любой странице /client (capture ниже),
 * выключается кнопкой «Выйти из демо» в баннере или закрытием вкладки
 * (sessionStorage умирает с вкладкой — залипнуть «в демо» в рабочей
 * вкладке невозможно).
 */

const TAB_DEMO_KEY = 'client_demo_tab';

export function isTabDemoMode(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(TAB_DEMO_KEY) === '1';
  } catch {
    return false;
  }
}

export function enableTabDemoMode(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(TAB_DEMO_KEY, '1');
  } catch {
    // Приватный режим без sessionStorage — демо по вкладке просто не включится.
  }
}

export function disableTabDemoMode(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(TAB_DEMO_KEY);
  } catch {
    // см. выше
  }
}

/**
 * Захват ?demo=1 из адресной строки (точка входа в демо-вкладку).
 * Возвращает true, если параметр был и флаг включён. Параметр из URL
 * убирает, чтобы он не протекал в ссылки/шаринг.
 */
export function captureTabDemoFromLocation(): boolean {
  if (typeof window === 'undefined') return false;
  const url = new URL(window.location.href);
  if (url.searchParams.get('demo') !== '1') return false;
  enableTabDemoMode();
  url.searchParams.delete('demo');
  window.history.replaceState(null, '', url.toString());
  return true;
}
