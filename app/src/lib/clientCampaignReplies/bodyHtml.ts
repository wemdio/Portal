/**
 * Текст из textarea ответа → безопасный HTML с сохранением переносов строк.
 *
 * Зачем: Instantly отправляет тело ответа как HTML-письмо. Если слать только
 * { text } с символами \n, почтовый клиент рендерит его как HTML, где перенос
 * строки — незначимый whitespace → весь текст схлопывается в один сплошной
 * абзац (это и видел клиент: ответ ушёл «простынёй»). Поэтому экранируем
 * спецсимволы и переводим \n → <br>; рядом всё равно шлём { text } как
 * plain-text fallback для клиентов без HTML.
 */
export function textToReplyHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\r\n|\r|\n/g, '<br>\n');
}
