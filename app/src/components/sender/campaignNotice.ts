/**
 * Итог сохранения кампании — со страницы настроек в список кампаний.
 *
 * Настройки живут на отдельной странице, а рассказать о результате («база
 * загружена, 325 получателей, 12 дублей пропущено») нужно в списке, куда
 * страница возвращает. Через адрес такой текст не передать — он длинный и
 * пользователю в адресной строке не нужен, поэтому он лежит в памяти вкладки
 * до первого чтения.
 */

const KEY = 'sender.campaignNotice';

export interface CampaignNotice {
  notice?: string;
  error?: string;
}

export function stashCampaignNotice(result: CampaignNotice) {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(result));
  } catch {
    // Приватный режим браузера: тогда список просто откроется без подписи.
  }
}

/** Забрать и сразу убрать: подпись показывается один раз, а не при каждом возврате. */
export function takeCampaignNotice(): CampaignNotice | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(KEY);
    return JSON.parse(raw) as CampaignNotice;
  } catch {
    return null;
  }
}
