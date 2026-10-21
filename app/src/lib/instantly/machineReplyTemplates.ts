/** Complete known service envelopes. Never match only a sender or a prefix:
 * any additional human request must continue through normal qualification. */
const VERTICER_FAQ = "Geachte relatie, Bedankt voor uw e-mail, wij streven ernaar deze zo spoedig mogelijk te beantwoorden. Hieronder treft u een aantal van onze 'Veelgestelde vragen [https://verticer.eu/nl/veelgestelde-vragen/]', waarmee u wellicht al geholpen bent. Algemeen * Hoe werkt MyVertiCer? De handleidingen kunt u vinden bij Downloads [https://verticer.eu/nl/downloads/]. * Hoe kom ik aan eHerkenning EH2+? Alle informatie over eHerkenning kunt u vinden op de website van eHerkenning [https://www.eherkenning.nl/nl]. Account of Productie-installatie aanmelden * Wilt u uw account en/of productie-installatie aanmelden? Dit kunt u doen via onze website [http://www.verticer.eu/]. U selecteert onder het kopje ‘Zelf regelen’ of uw een registratie doet als ‘Particulier’ of als ‘Producent’ (zakelijk). Vervolgens kiest u in het blok ‘Acties in MyVertiCer’ voor de optie ‘Ik wil mijzelf en/of mijn productie-installatie (opnieuw) aanmelden’. Let op: bij de registratie van een thermische-, groen gas of waterstof installatie is een meetprotocol nodig. Neem hiervoor contact op met uw meetbedrijf. Een wijziging doorvoeren * Wilt u een wijziging doorgeven? Bijvoorbeeld een handelaarswijziging, een verhuizing, een wijziging in relatie- of installatiegegevens? Klik hier [https://verticer.eu/nl/veelgestelde-vragen/een-wijziging-doorvoeren/] voor de benodigde stappen. Subsidie * Heeft u vragen over uw subsidie? Deze kunt u stellen aan RVO [https://rvo.nl/over-ons/contact]. * Heeft u vragen met betrekking tot Emissiereductie Eenheden (ERE)? Deze kunt u stellen aan Nea [https://emissieautoriteit.nl/]. Meetwaarden & rapportages * Wilt u zelf de meetwaarden van uw ingeschreven productie-installatie inzien, kies op onze website [http://www.verticer.eu/] ‘Voor particulieren’ of ‘Voor zakelijk’ en indien zakelijk, selecteert u vervolgens uw rol. Vervolgens scrolt u naar beneden naar ‘Acties in MyVertiCer’. * Zijn volgens u de meetwaarden elektriciteit niet juist of onvolledig, neem dan contact op met uw netbeheerder. * Heeft u een installatie voor thermische energie, groen gas of waterstof, dan kunt u voor vragen over de meetwaarden contact opnemen met uw meetbedrijf. * Heeft u een meet- en/of assurancerapport ingediend, dan nemen wij deze in behandeling. Bij vragen hierover nemen wij binnen acht weken contact met u op. LET OP! U kunt NIET op deze e-mail reageren.";
// Footer field shapes, not copied account numbers/contact records. Unknown
// prose anywhere in this suffix (including a P.S.) invalidates the template.
const VERTICER_FOOTER = /^Met vriendelijke groet, Servicedesk Verticer B\.V\. Postbus \d{1,6} \d{4} [A-Z]{2} [A-Z ]{2,60} servicedesk@verticer\.eu \[servicedesk@verticer\.eu\] www\.verticer\.eu \[https:\/\/verticer\.eu\/\] Handelsregister: [\p{L} -]{2,60} \d{6,12} IBAN: [A-Z]{2}\d{2}[A-Z\d]{10,30} Swift: BIC [A-Z\d]{8,11} VertiCer Logo\.png \* Denk aan het milieu\. Print dit bericht alleen als het noodzakelijk is\.$/u;

// This complete receipt has an unusually long commercial/legal signature.
// Its EDI identifiers are boilerplate, not a reply about the offered service.
// Keep field-shaped values and the terminal address: never swallow arbitrary
// signature prose or a buyer request added before/after the footer.
const PARTS_COMPANY_RECEIPT = /^Ваше письмо получено\. Скоро мы с Вами свяжемся\. Наша организация "[\p{L}\p{N} -]{2,80}" поставляет запчасти к дорожной, строительной и спецтехнике\. Данная компания включена в официальный реестр «Надежный поставщик» и настоящим получает право использования логотипа «Надежный поставщик»\. Сертификат серия \d{1,6} №\d{1,12}\. Оператор ООО "Компания "Тензор" ЭДО ид [a-z\d]{10,60} ЭТрН Тензор СБИС [a-z\d]{10,60} https?:\/\/[a-z\d.-]+\/o-kompanii\/ https?:\/\/[a-z\d.-]+\/kontakty\/ Тел: [\d ()+-]{7,30}, [\d ()+-]{7,30}\. https?:\/\/[a-z\d.-]+ [^\s@]+@[^\s@]+\.[^\s@]+ ИНН \d{10,12} г\.[\p{L}-]{2,40}, ул\.[\p{L} -]{2,60}, д\.\d{1,5}[а-яё]?\.?$/iu;

// Match the entire received body, including its footer, before signature or
// quote stripping. Friendly receipt boilerplate is not buyer interest, but
// any added human prose (also below a signature) must invalidate the envelope.
const COMPLETE_RUSSIAN_RECEIPTS = [
  /^Здравствуйте, Ваше сообщение получено\. Рады с Вами сотрудничать\. С уважением, компания \$[\p{L}\p{N} &.-]{2,80}\$$/iu,
  /^Спасибо за обращение! Ваше письмо будет рассмотрено в ближайшее время!$/iu,
  /^Спасибо за Ваше обращение! Постараемся ответить Вам сразу, как прочт[её]м Ваше письмо!$/iu,
  /^Благодарим за обращение! Ваш вопрос принят в работу специалистами Линии консультаций\. В соответствии с установленным регламентом срок подготовки ответа составляет один рабочий день\. В исключительных случаях, когда вопрос требует дополнительного анализа или не имеет однозначного регулирования в законодательстве, срок может быть увеличен до тр[её]х рабочих дней\. Благодарим за доверие к нашей компании\. Желаем продуктивного дня и отличного настроения! С уважением, Команда Линии консультаций\.$/iu,
  /^Здравствуйте! От лица всей команды Life благодарим вас за обращение\. Мы ценим ваше время и доверие\. Ваш запрос "[^"\r\n]{1,300}" под номером \d{1,12} был успешно зарегистрирован в нашей системе \d{2}\.\d{2}\.\d{2,4} в \d{2}:\d{2}\. Сейчас он направлен ответственному специалисту, который тщательно его изучит и подготовит для вас ответ\. Если у вас появятся срочные дополнения, ответьте на это сообщение \(не меняя тему\), и оно автоматически добавится к вашему обращению\. О завершении обработки мы сообщим вам отдельным уведомлением\. Искренне ваши, Команда поддержки корпоративных клиентов Life Мы на связи, чтобы вы были на связи!$/iu,
  /^Здравствуйте! Мы получили Ваше обращение и постараемся ответить на него в кратчайшие сроки\. Спасибо\. С уважением, PREMIUM тел\. [\d ()+-]{7,30} моб\. [\d ()+-]{7,30} адрес: [А-ЯЁа-яё -]{2,60} обл\. г\. [А-ЯЁа-яё -]{2,60}, ул\. [А-ЯЁа-яё -]{2,60}, д\. \d{1,5}[а-яё]? Это письмо создано автоматически, отвечать на него не нужно\.$/iu,
  /^Ваше письмо получено, ответ будет направлен Вам в ближайшее время\. Для связи с менеджерами компании "ЮТА-ТЕКС" обращайтесь по телефонам [\d/()-]{7,30}(?:,[\d/()-]{7,30}){1,5} Вся информация об ассортименте продукции, скидках и специальных предложениях на нашем сайте www\.uta-tex\.ru\. Спасибо, что выбираете Текстильную Компанию "ЮТА-ТЕКС"!$/iu,
  /^Здравствуйте, мы получили Ваше письмо и обязательно на него ответим! Предлагаем Вам скоротать время ожидания и подробнее познакомиться с нашими товарами и услугами: http:\/\/zimcom\.ru\/ - официальный сайт компании "ЗиМ" видео про наши работы https:\/\/rutube\.ru\/u\/zim\/ http:\/\/vk\.com\/zimcom - будьте в курсе, подпишитесь на наши новости -- С уважением к Вам и вашему делу, компания ООО "ЗиМ" тел\. [\d ()+-]{7,30}, [\d ()+-]{7,30}$/iu,
];

const SIMPLE_GREETING = /^(?:здравствуйте|добрый день|доброе утро|добрый вечер)[!,.]\s*/iu;
const RECEIPT_ONLY = /^ваше письмо получено[.!]?\s*/iu;
const GENERIC_CONTACT_PROMISE = /^(?:скоро\s+)?(?:(?:я|мы)\s+)?(?:обязательно\s+)?(?:свяжусь|свяжемся)\s+с\s+вами(?:\s+(?:позже|в\s+ближайшее\s+время))?[.!]?$/iu;
const GENERIC_REPLY_PROMISE = /^(?:(?:я|мы)\s+)?(?:позже\s+(?:вам\s+)?(?:отвечу|ответим)|(?:отвечу|ответим)\s+(?:вам\s+)?позже)[.!]?$/iu;
const NOTICE_EMAIL = String.raw`[a-z\d.!#$%&'*+/=?^_\x60{|}~-]+@[a-z\d.-]+\.[a-z]{2,}`;
const LEAVE_SUBSTITUTE_NOTICE = new RegExp(
  String.raw`^(?:с\s+\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+\d{4})?\s+)?(?:я\s+)?нахожусь\s+в\s+декретном\s+отпуске[.!]?\s+по\s+всем\s+вопросам\s+(?:прошу\s+)?обращаться\s+к\s+(?:региональному\s+менеджеру|менеджеру|моему\s+коллеге|коллеге)\s+[А-ЯЁ][а-яё-]{1,40}(?:\s+[А-ЯЁ][а-яё-]{1,40}){0,2}\s+\((${NOTICE_EMAIL})\)[,.]?\s*(?:тел\.?\s*[+:]?\s*[\d ()+-]{7,30})?[.!]?$`,
  'iu',
);
const NOTICE_PERSON = String.raw`[А-ЯЁ][а-яё-]{1,40}(?:\s+[А-ЯЁ][а-яё-]{1,40}){1,2}`;
const NOTICE_COMPANY = String.raw`(?:АО|ПАО|ООО)\s+(?:"[\p{L}\p{N} .&()/-]{1,100}"|«[\p{L}\p{N} .&()/-]{1,100}»)`;
const DEPARTURE_COMPANY_SIGNATURE = new RegExp(String.raw`^${NOTICE_COMPANY}$`, 'iu');
// A complete staff-change notice is administrative, even under a project's
// "shared a contact" criterion. Require the successor AND no-reply footer;
// additional human discussion must fail open, not disappear behind a keyword.
const DEPARTED_EMPLOYEE_NOTICE = new RegExp(
  String.raw`^${NOTICE_PERSON}\s+(?:(?:более|больше)\s+)?не\s+работает\s+в\s+${NOTICE_COMPANY},\s*(?:е[её]|его)\s+дела\s+переданы\s+${NOTICE_PERSON}\s+${NOTICE_EMAIL}\.?\s+(?:телефон\s+компании:\s*[+\d ()-]{7,30}\s+)?(?:данное|это)\s+(?:письмо|сообщение)\s+(?:не\s+)?ответа\s+не\s+требует[.!]?$`,
  'iu',
);
const UNAVAILABLE_DIRECTORY_SUBJECT = /^данная почта недоступна,\s*по всем вопросам обращайтесь пожалуйста к нужному специалисту:\s*(?:(?:re|fw|fwd):[\s\S]*)?$/iu;
const DIRECTORY_ROLE = String.raw`(?:административный специалист|бухгалтерия|отдел продаж|инструкции на прием порожних|импорт|экспорт|отдел по работе с клиентами)`;
const DIRECTORY_CONTACT = new RegExp(
  String.raw`^(?:${NOTICE_EMAIL}(?:\s*-\s*${DIRECTORY_ROLE})?|(?:запросы на возврат порожних|импорт|экспорт)\s*-\s*${NOTICE_EMAIL})$`, 'iu',
);

function isUnavailableMailboxDirectory(subject: string, body: string): boolean {
  if (!UNAVAILABLE_DIRECTORY_SUBJECT.test(subject.trim()) || body.length > 5_000) return false;
  const lines = body.replace(/\r\n?/gu, '\n').split('\n').map(line => line.trim()).filter(Boolean);
  if (/^команда [a-z -]{2,80}\.$/iu.test(lines.at(-1) ?? '') &&
      /^с уважением,$/iu.test(lines.at(-2) ?? '')) lines.splice(-2);
  // No arbitrary prose, signatures or buyer questions may hide in the list.
  const city = (line: string) => /^[А-ЯЁ][А-ЯЁа-яё-]{1,40}:$/u.test(line);
  return lines.filter(city).length >= 2 &&
    lines.filter(line => DIRECTORY_CONTACT.test(line)).length >= 4 &&
    lines.every(line => city(line) || DIRECTORY_CONTACT.test(line));
}

/** Only complete administrative notices or receipts, never a positive or negative
 * opinion about the offer. The caller supplies the authored (non-quoted) body
 * and checks for human additions hidden below a signature first. Unknown prose
 * fails open, including real deferred interest, questions and meeting times. */
export function classifyCompleteAuthoredServiceReply(
  authoredBody: string,
  subject = '',
  signatureTail = '',
): 'auto_reply' | 'service_acknowledgement' | null {
  if (isUnavailableMailboxDirectory(subject, authoredBody)) return 'auto_reply';
  const compact = authoredBody.replace(/\s+/gu, ' ').trim();
  if (!compact || compact.length > 1_000) return null;
  const content = compact.replace(SIMPLE_GREETING, '').trim();
  if (LEAVE_SUBSTITUTE_NOTICE.test(content)) return 'auto_reply';
  // The caller has removed the signature from authoredBody. For this terminal
  // shortcut, accept only an empty tail or the company field, never arbitrary
  // prose below "regards" (a buyer request need not have a question or P.S.).
  const signature = signatureTail.replace(/\s+/gu, ' ').trim();
  if (DEPARTED_EMPLOYEE_NOTICE.test(content) &&
      (!signature || DEPARTURE_COMPANY_SIGNATURE.test(signature))) return 'auto_reply';
  const withoutReceipt = content.replace(RECEIPT_ONLY, '').trim();
  if (withoutReceipt !== content &&
      (!withoutReceipt || GENERIC_CONTACT_PROMISE.test(withoutReceipt) ||
        GENERIC_REPLY_PROMISE.test(withoutReceipt))) return 'service_acknowledgement';
  return null;
}

/** A bare promise to answer is not evidence of automation. Use this only for
 * the default interest policy; custom rules may accept every human response. */
export function isCompleteHoldingReply(authoredBody: string): boolean {
  const compact = authoredBody.replace(/\s+/gu, ' ').trim();
  return compact.length <= 1_000 &&
    GENERIC_REPLY_PROMISE.test(compact.replace(SIMPLE_GREETING, '').trim());
}

export function isCompleteServiceReceipt(sender: string, body: string): boolean {
  // Do not strip image/data tokens for these templates: only whitespace may
  // differ from the complete envelope that was reviewed.
  const complete = body.replace(/\s+/gu, ' ').trim();
  if (COMPLETE_RUSSIAN_RECEIPTS.some(template => template.test(complete))) return true;
  const compact = body.replace(/\[data:image\/[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
  if (PARTS_COMPANY_RECEIPT.test(compact)) return true;
  if (sender === 'noreply@verticer.eu' && compact.startsWith(VERTICER_FAQ + ' ') &&
    VERTICER_FOOTER.test(compact.slice(VERTICER_FAQ.length).trim())) return true;
  // Zendesk's Dutch initial receipt. Later human ticket updates have a different
  // body and must not be mistaken for this acknowledgement.
  if (/^[^@]+@[^@]+\.zendesk\.com$/iu.test(sender) &&
    /^##- Typ uw reactie boven deze regel -## Geachte heer \/ mevrouw, Uw aanvraag met ticket nummer \(\d{1,12}\) is door ons in goede orde ontvangen en wordt door een van onze helpdesk medewerkers in behandeling genomen\. Als u aanvullende opmerkingen wilt toevoegen, reageer dan op dit e-mailbericht\. -{10,} Dit e-mailbericht is een service van [\p{L}\p{N} &-]{2,80}\. \[[A-Z0-9]{6}-[A-Z0-9]{5}\]$/u.test(compact)) return true;
  const dental = /^Благодарим Вас за обращение в стоматологию [\p{L}«»" -]{2,60}\. В ближайшее время наш администратор свяжется с вами\.\s+Наш адрес{1,2}: [^\n]{5,100}\nтел\. [\d ()+-]{7,30} viber \+\d{10,15} Whatsapp \+\d{10,15}\s*$/iu;
  if (dental.test(body.trim())) return true;
  const processing = /^Добрый день!\s+Благодарим за обращение в ООО "[^"\n]{2,60}"\.\s+Ваш запрос находится в обработке, наши менеджеры свяжутся с Вами в ближайшее время\.\s+Внимание! Если с Вами до конца рабочего дня не связался наш менеджер, сообщите нам удобным для Вас способом:\s+Тел\. \+?[\d ()-]{7,30}\s+\+?[\d ()-]{7,30} доб\.\d{1,6}(?:, \d{1,6}){0,5}\s+Эл\. Почта [^\s@,]+@[^\s@,]+(?:, [^\s@,]+@[^\s@,]+)*\.\s+С уважением,\s+отдел сервиса клиентов\.\s*$/iu;
  return processing.test(body.trim());
}
