#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractHtmlUiSources, extractUiSources } from './i18n/catalogUtils.mjs';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appRoot = join(currentDir, '..');
const repoRoot = join(appRoot, '..');
const outputPath = join(appRoot, 'src', 'lib', 'clientTranslations.generated.js');
const declarationOutputPath = join(appRoot, 'src', 'lib', 'clientTranslations.generated.d.ts');
const landingSourcePath = join(repoRoot, 'landing', 'index.html');
const landingOutputPath = join(repoRoot, 'landing', 'translations.generated.js');
const hasLandingSource = existsSync(landingSourcePath);

const TARGETS = {
  en: 'English',
  es: 'Spanish',
};
const requested = new Set(
  (process.argv.find((arg) => arg.startsWith('--locales='))?.split('=')[1] ?? 'en,es')
    .split(',')
    .filter((locale) => locale in TARGETS),
);
const model = process.env.PORTAL_TRANSLATE_MODEL ?? 'openai/gpt-4o-mini';
const apiKey =
  process.env.PORTAL_TRANSLATE_API_KEY ??
  process.env.OPENROUTER_BRIEF_API_KEY ??
  process.env.OPENROUTER_API_KEY ??
  '';
const provider =
  process.argv.find((arg) => arg.startsWith('--provider='))?.split('=')[1] ??
  (apiKey.startsWith('sk-or-') ? 'openrouter' : 'google');

const MANUAL_OVERRIDES = {
  en: {
    'Кампании': 'Campaigns',
    'Воронка базы': 'List funnel',
    'Путь компаний от скоринга до подтверждённой передачи контактов в кампании.': 'From company scoring to confirmed contact handoff into campaigns.',
    'Отправки, открытия, ответы и лиды смотрите в разделе': 'View sends, opens, replies, and leads in',
    'Воронка:': 'Funnel:',
    'Кампания после передачи': 'Campaign after handoff',
    'Фильтр кампании действует с этапа передачи контактов.': 'The campaign filter applies from the contact handoff stage.',
    'Не удалось обновить воронку базы': 'Could not refresh the list funnel',
    'Загрузка воронки базы': 'Loading the list funnel',
    'Загружаем воронку…': 'Loading the funnel…',
    'Загружаем воронку базы…': 'Loading the list funnel…',
    'Сводим скоринг, поиск почт и передачу в кампании.': 'Combining scoring, email discovery, and campaign handoffs.',
    '01 → Обработка': '01 → Processing',
    'Этапы обработки базы': 'List processing stages',
    'Воронка компаний, отскоренных в период': 'Funnel for companies scored during the period',
    'Передано из этой когорты': 'Handed off from this cohort',
    'Принято из этой когорты': 'Accepted from this cohort',
    '02 → Передача': '02 → Handoff',
    'По кампаниям и скору': 'By campaign and score',
    '03 → Данные': '03 → Data',
    'Не удалось загрузить воронку базы': 'Could not load the list funnel',
    'Скоринг, передача и выгрузки базы': 'Scoring, handoff, and list exports',
    'ключ': 'key',
    'поле': 'field',
    'Смотреть демо': 'View demo',
    'Создать аккаунт': 'Create account',
    'Под ключ': 'Done for you',
    'Кейсы': 'Case studies',
    'Кейсы.': 'Results.',
    'Тарифы': 'Pricing',
    'Тарифы.': 'Pricing.',
    'Войти': 'Sign in',
    'Инфраструктура': 'The infrastructure',
    'аутрич агентства.': 'of an outreach agency.',
    'Теперь ваша.': 'Now it is yours.',
    'Что внутри.': 'What is included.',
    'Конструктор баз': 'List builder',
    'Конструктор баз в действии.': 'See the list builder in action.',
    'Парсеры': 'Data extractors',
    'Мастер запуска': 'Launch wizard',
    'Ответы и лиды': 'Replies and leads',
    'Бриф': 'Brief',
    'Поддержка': 'Support',
    'Свои ящики': 'Your mailboxes',
    'скоро': 'Soon',
    'Базы': 'Contact lists',
    'Запуск': 'Launch',
    'Поток': 'Flow',
    'Масштаб': 'Scale',
    'чаще берут': 'Most popular',
    'Индивидуально': 'Custom',
    'Обсудить задачу': 'Discuss your goals',
    'Зайдите в демо.': 'Try the demo.',
    'Решите внутри.': 'See how it works.',
    'писем за весну 2026': 'emails sent in spring 2026',
    'Демо открывается без регистрации.': 'No registration required.',
    'Каждый модуль работает как инструмент, которым вы пользуетесь сами. Менеджер нужен только чтобы настроить пресет.': 'Every module is a tool you can use directly. A manager only helps configure the initial setup.',
    'Лимит {0} строк. В файле {1} строк.': 'Limit: {0} rows. The file contains {1} rows.',
    'Орбита — розничные сети': 'Orbita: retail chains',
    'Орбита — 3PL и фулфилмент': 'Orbita: 3PL and fulfillment',
    'Орбита — продавцы на маркетплейсах': 'Orbita: marketplace sellers',
    'Орбита — производственные компании': 'Orbita: manufacturing companies',
    'Фактические расходы, заявки и отдельные лимиты разовых покупок и костов.': 'Actual expenses, requests, and separate limits for one-time purchases and costs.',
    'Контур бюджета': 'Budget category',
    'Косты': 'Costs',
    'Instantly, почты, базы и домены, лимит 650 000 ₽': 'Instantly, mailboxes, databases and domains; RUB 650,000 limit',
    'Категория костов': 'Cost category',
    'Выберите категорию': 'Select a category',
    'Почты': 'Mailboxes',
    'Базы': 'Databases',
    'Домены': 'Domains',
    'Другое': 'Other',
    'Записи со статусом «Оставить» уже приходят из календаря автоматически. Не дублируйте их вручную.': 'Entries marked “Keep” are imported from the calendar automatically. Do not add them manually again.',
    'В календаре почт не хватает курса валюты. Пока сумма не пересчитана в рубли, новый кост добавить нельзя.': 'A currency rate is missing in the mailbox calendar. New costs are blocked until the amount can be converted to RUB.',
    'Кост будет одобрен автоматически. После отправки сервер ещё раз проверит остаток.': 'The cost will be approved automatically. The server will verify the remaining budget once more after submission.',
    'Недоступно до пересчёта курса': 'Unavailable until the exchange rate is updated',
    'Недоступно сверх лимита': 'Unavailable above the limit',
    'Косты компании': 'Company costs',
    'Instantly, почты, базы и домены': 'Instantly, mailboxes, databases and domains',
    'Instantly, почты, базы, домены и другое': 'Instantly, mailboxes, databases, domains, and other costs',
    '«Оставить» из календаря почт учитывается автоматически: до даты списания в резерве, с даты списания в факте.': 'Mailbox calendar entries marked “Keep” are counted automatically: reserved before the billing date and paid from that date.',
    'Календарь почт попадает в «Почты», календарь технички в «Другое». «Оставить» до даты списания считается резервом, затем фактом.': 'The mailbox calendar goes to “Mailboxes” and the technician calendar to “Other”. Entries marked “Keep” are reserved until the billing date and counted as paid afterward.',
    'Календарь почт: оплачено {0}, резерв {1}.': 'Mailbox calendar: {0} paid, {1} reserved.',
    'Календарь технички: оплачено {0}, резерв {1}.': 'Technician calendar: {0} paid, {1} reserved.',
    'Не удалось пересчитать {0} платеж(а) из календарей в рубли. До обновления курса новые косты заблокированы, чтобы не превысить лимит незаметно.': '{0} calendar payment(s) could not be converted to RUB. New costs are blocked until the exchange rate is updated to prevent an unnoticed overrun.',
    'Продлить можно только подтверждённый сервис, дата списания которого уже наступила.': 'Only an approved service whose billing date has arrived can be renewed.',
    'Оплаченный цикл уже зафиксирован. Для следующего периода используйте продление.': 'The paid cycle is already recorded. Use renewal for the next period.',
    'Этот цикл уже сохранён в истории оплат. Обновите страницу.': 'This cycle is already saved in the payment history. Refresh the page.',
    'Не удалось сохранить решение': 'Could not save the decision',
    'Не удалось удалить сервис': 'Could not delete the service',
    'Лимит костов 650 000 ₽ на этот месяц будет превышен.': 'This month’s RUB 650,000 cost limit would be exceeded.',
    'Не удалось пересчитать календарные расходы в рубли. Обновите курсы и повторите.': 'Calendar costs could not be converted to RUB. Update the exchange rates and try again.',
    'Карточка сервиса уже изменилась. Обновите страницу и повторите.': 'This service has already changed. Refresh the page and try again.',
    'Сервис не найден.': 'Service not found.',
    'Версия карточки указана неверно': 'The service version is invalid.',
    'Обновите страницу и повторите': 'Refresh the page and try again.',
    'Сервис не найден': 'Service not found',
    'Не разобрал тело запроса': 'Could not parse the request body',
    'Данные неполные': 'Incomplete data',
    'Доступно {0}': '{0} available',
    'Превышение {0}': '{0} over limit',
    'Лимит костов': 'Cost limit',
    'Использовано лимита костов': 'Cost limit used',
    'По категориям, факт + резерв': 'By category, paid + reserved',
    'Из календаря почт: оплачено {0}, в резерве {1}.': 'From the mailbox calendar: {0} paid, {1} reserved.',
    'Не удалось пересчитать {0} платеж(а) из календаря в рубли. До обновления курса новые косты заблокированы, чтобы не превысить лимит незаметно.': '{0} calendar payment(s) could not be converted to RUB. New costs are blocked until the exchange rate is updated to prevent an unnoticed overrun.',
    'Превышает доступный остаток костов на {0}. Уменьшите сумму или перенесите расход.': 'This exceeds the available cost budget by {0}. Reduce the amount or move the expense.',
    'Превышает доступный остаток на {0}. Расход будет отправлен Ане.': 'This exceeds the available budget by {0}. The expense will be sent to Anya.',
    'Расход будет одобрен автоматически. После отправки сервер ещё раз проверит остаток.': 'The expense will be approved automatically. The server will verify the remaining budget once more after submission.',
    'Лимит костов 650 000 ₽ на этот месяц будет превышен. Измените сумму или дату.': 'This month’s RUB 650,000 cost limit would be exceeded. Change the amount or date.',
    'Не удалось пересчитать сумму в рубли: для даты списания нет курса валюты. Повторите после обновления курсов.': 'The amount could not be converted to RUB because no exchange rate is available for the billing date. Try again after rates are updated.',
    'Недостаточно прав для изменения календаря почт.': 'You do not have permission to change the mailbox calendar.',
    'Оплата для этого проекта на сегодня уже зарегистрирована.': 'A payment for this project has already been recorded today.',
    'Запись изменилась после открытия окна. Обновите календарь и проверьте данные перед повторным решением.': 'The entry changed after this window was opened. Refresh the calendar and review the data before deciding again.',
    'Не удалось сохранить изменение. Обновите данные и попробуйте ещё раз.': 'Could not save the change. Refresh the data and try again.',
  },
  es: {
    'Кампании': 'Campañas',
    'Воронка базы': 'Embudo de listas',
    'Путь компаний от скоринга до подтверждённой передачи контактов в кампании.': 'Desde la puntuación de empresas hasta la entrega confirmada de contactos a las campañas.',
    'Отправки, открытия, ответы и лиды смотрите в разделе': 'Consulta los envíos, aperturas, respuestas y leads en',
    'Воронка:': 'Embudo:',
    'Кампания после передачи': 'Campaña después de la entrega',
    'Фильтр кампании действует с этапа передачи контактов.': 'El filtro de campaña se aplica a partir de la entrega de contactos.',
    'Не удалось обновить воронку базы': 'No se pudo actualizar el embudo de listas',
    'Загрузка воронки базы': 'Cargando el embudo de listas',
    'Загружаем воронку…': 'Cargando el embudo…',
    'Загружаем воронку базы…': 'Cargando el embudo de listas…',
    'Сводим скоринг, поиск почт и передачу в кампании.': 'Combinando la puntuación, la búsqueda de correos y la entrega a campañas.',
    '01 → Обработка': '01 → Procesamiento',
    'Этапы обработки базы': 'Etapas de procesamiento de la lista',
    'Воронка компаний, отскоренных в период': 'Embudo de empresas puntuadas durante el período',
    'Передано из этой когорты': 'Entregados de esta cohorte',
    'Принято из этой когорты': 'Aceptados de esta cohorte',
    '02 → Передача': '02 → Entrega',
    'По кампаниям и скору': 'Por campaña y puntuación',
    '03 → Данные': '03 → Datos',
    'Не удалось загрузить воронку базы': 'No se pudo cargar el embudo de listas',
    'Скоринг, передача и выгрузки базы': 'Puntuación, entrega y exportaciones de listas',
    'ключ': 'clave',
    'поле': 'campo',
    'Смотреть демо': 'Ver demo',
    'Создать аккаунт': 'Crear cuenta',
    'Под ключ': 'Servicio integral',
    'Кейсы': 'Casos',
    'Кейсы.': 'Resultados.',
    'Тарифы': 'Precios',
    'Тарифы.': 'Precios.',
    'Войти': 'Iniciar sesión',
    'Инфраструктура': 'La infraestructura',
    'аутрич агентства.': 'de una agencia de outreach.',
    'Теперь ваша.': 'Ahora es tuya.',
    'Что внутри.': 'Qué incluye.',
    'Конструктор баз': 'Constructor de listas',
    'Конструктор баз в действии.': 'El constructor de listas en acción.',
    'Парсеры': 'Extractores de datos',
    'Мастер запуска': 'Asistente de lanzamiento',
    'Ответы и лиды': 'Respuestas y leads',
    'Бриф': 'Brief',
    'Поддержка': 'Soporte',
    'Свои ящики': 'Tus buzones',
    'скоро': 'Próximamente',
    'Базы': 'Listas de contactos',
    'Запуск': 'Lanzamiento',
    'Поток': 'Flujo',
    'Масштаб': 'Escala',
    'чаще берут': 'Más elegido',
    'Индивидуально': 'A medida',
    'Обсудить задачу': 'Hablar de tus objetivos',
    'Зайдите в демо.': 'Prueba la demo.',
    'Решите внутри.': 'Descubre cómo funciona.',
    'писем за весну 2026': 'emails enviados en primavera de 2026',
    'Демо открывается без регистрации.': 'No requiere registro.',
    'Каждый модуль работает как инструмент, которым вы пользуетесь сами. Менеджер нужен только чтобы настроить пресет.': 'Cada módulo es una herramienta que puedes usar directamente. Un manager solo ayuda a configurar el ajuste inicial.',
    'Лимит {0} строк. В файле {1} строк.': 'Límite: {0} filas. El archivo contiene {1} filas.',
    'Орбита — розничные сети': 'Orbita: cadenas minoristas',
    'Орбита — 3PL и фулфилмент': 'Orbita: 3PL y fulfillment',
    'Орбита — продавцы на маркетплейсах': 'Orbita: vendedores en marketplaces',
    'Орбита — производственные компании': 'Orbita: empresas manufactureras',
    'Фактические расходы, заявки и отдельные лимиты разовых покупок и костов.': 'Gastos reales, solicitudes y límites separados para compras puntuales y costes.',
    'Контур бюджета': 'Categoría presupuestaria',
    'Косты': 'Costes',
    'Instantly, почты, базы и домены, лимит 650 000 ₽': 'Instantly, buzones, bases de datos y dominios; límite de 650.000 RUB',
    'Категория костов': 'Categoría de costes',
    'Выберите категорию': 'Selecciona una categoría',
    'Почты': 'Buzones',
    'Базы': 'Bases de datos',
    'Домены': 'Dominios',
    'Другое': 'Otro',
    'Записи со статусом «Оставить» уже приходят из календаря автоматически. Не дублируйте их вручную.': 'Las entradas marcadas como «Mantener» ya se importan automáticamente del calendario. No las añadas de nuevo manualmente.',
    'В календаре почт не хватает курса валюты. Пока сумма не пересчитана в рубли, новый кост добавить нельзя.': 'Falta un tipo de cambio en el calendario de buzones. No se pueden añadir costes hasta convertir el importe a RUB.',
    'Кост будет одобрен автоматически. После отправки сервер ещё раз проверит остаток.': 'El coste se aprobará automáticamente. El servidor volverá a comprobar el saldo disponible al enviarlo.',
    'Недоступно до пересчёта курса': 'No disponible hasta actualizar el tipo de cambio',
    'Недоступно сверх лимита': 'No disponible por encima del límite',
    'Косты компании': 'Costes de la empresa',
    'Instantly, почты, базы и домены': 'Instantly, buzones, bases de datos y dominios',
    'Instantly, почты, базы, домены и другое': 'Instantly, buzones, bases de datos, dominios y otros costes',
    '«Оставить» из календаря почт учитывается автоматически: до даты списания в резерве, с даты списания в факте.': 'Las entradas «Mantener» del calendario de buzones se contabilizan automáticamente: como reserva antes de la fecha de cobro y como pago desde esa fecha.',
    'Календарь почт попадает в «Почты», календарь технички в «Другое». «Оставить» до даты списания считается резервом, затем фактом.': 'El calendario de buzones se incluye en «Buzones» y el calendario técnico en «Otro». Las entradas «Mantener» se reservan hasta la fecha de cobro y después se contabilizan como pagadas.',
    'Календарь почт: оплачено {0}, резерв {1}.': 'Calendario de buzones: {0} pagado, {1} reservado.',
    'Календарь технички: оплачено {0}, резерв {1}.': 'Calendario técnico: {0} pagado, {1} reservado.',
    'Не удалось пересчитать {0} платеж(а) из календарей в рубли. До обновления курса новые косты заблокированы, чтобы не превысить лимит незаметно.': 'No se pudieron convertir {0} pago(s) de los calendarios a RUB. Los nuevos costes quedan bloqueados hasta actualizar el tipo de cambio y evitar superar el límite sin advertencia.',
    'Продлить можно только подтверждённый сервис, дата списания которого уже наступила.': 'Solo se puede renovar un servicio aprobado cuya fecha de cobro ya haya llegado.',
    'Оплаченный цикл уже зафиксирован. Для следующего периода используйте продление.': 'El ciclo pagado ya está registrado. Usa la renovación para el siguiente periodo.',
    'Этот цикл уже сохранён в истории оплат. Обновите страницу.': 'Este ciclo ya está guardado en el historial de pagos. Actualiza la página.',
    'Не удалось сохранить решение': 'No se pudo guardar la decisión',
    'Не удалось удалить сервис': 'No se pudo eliminar el servicio',
    'Лимит костов 650 000 ₽ на этот месяц будет превышен.': 'Se superaría el límite mensual de costes de 650.000 RUB.',
    'Не удалось пересчитать календарные расходы в рубли. Обновите курсы и повторите.': 'No se pudieron convertir los costes del calendario a RUB. Actualiza los tipos de cambio e inténtalo de nuevo.',
    'Карточка сервиса уже изменилась. Обновите страницу и повторите.': 'Este servicio ya ha cambiado. Actualiza la página e inténtalo de nuevo.',
    'Сервис не найден.': 'Servicio no encontrado.',
    'Версия карточки указана неверно': 'La versión del servicio no es válida.',
    'Обновите страницу и повторите': 'Actualiza la página e inténtalo de nuevo.',
    'Сервис не найден': 'Servicio no encontrado',
    'Не разобрал тело запроса': 'No se pudo interpretar el cuerpo de la solicitud',
    'Данные неполные': 'Datos incompletos',
    'Доступно {0}': '{0} disponible',
    'Превышение {0}': '{0} por encima del límite',
    'Лимит костов': 'Límite de costes',
    'Использовано лимита костов': 'Límite de costes utilizado',
    'По категориям, факт + резерв': 'Por categoría, pagado + reservado',
    'Из календаря почт: оплачено {0}, в резерве {1}.': 'Del calendario de buzones: {0} pagado, {1} reservado.',
    'Не удалось пересчитать {0} платеж(а) из календаря в рубли. До обновления курса новые косты заблокированы, чтобы не превысить лимит незаметно.': 'No se pudieron convertir {0} pago(s) del calendario a RUB. Los nuevos costes quedan bloqueados hasta actualizar el tipo de cambio y evitar superar el límite sin advertencia.',
    'Превышает доступный остаток костов на {0}. Уменьшите сумму или перенесите расход.': 'Supera el presupuesto de costes disponible en {0}. Reduce el importe o mueve el gasto.',
    'Превышает доступный остаток на {0}. Расход будет отправлен Ане.': 'Supera el presupuesto disponible en {0}. El gasto se enviará a Anya.',
    'Расход будет одобрен автоматически. После отправки сервер ещё раз проверит остаток.': 'El gasto se aprobará automáticamente. El servidor volverá a comprobar el saldo disponible al enviarlo.',
    'Лимит костов 650 000 ₽ на этот месяц будет превышен. Измените сумму или дату.': 'Se superaría el límite mensual de costes de 650.000 RUB. Cambia el importe o la fecha.',
    'Не удалось пересчитать сумму в рубли: для даты списания нет курса валюты. Повторите после обновления курсов.': 'No se pudo convertir el importe a RUB porque no hay un tipo de cambio para la fecha de cobro. Inténtalo de nuevo cuando se actualicen los tipos.',
    'Недостаточно прав для изменения календаря почт.': 'No tienes permisos para modificar el calendario de buzones.',
    'Оплата для этого проекта на сегодня уже зарегистрирована.': 'Ya se ha registrado hoy un pago para este proyecto.',
    'Запись изменилась после открытия окна. Обновите календарь и проверьте данные перед повторным решением.': 'La entrada cambió después de abrir esta ventana. Actualiza el calendario y revisa los datos antes de volver a decidir.',
    'Не удалось сохранить изменение. Обновите данные и попробуйте ещё раз.': 'No se pudo guardar el cambio. Actualiza los datos e inténtalo de nuevo.',
  },
};

const clientSources = extractUiSources({
  roots: [
    join(appRoot, 'src', 'app', 'client'),
    join(appRoot, 'src', 'components', 'client'),
    join(appRoot, 'src', 'components', 'client-brief'),
    join(appRoot, 'src', 'components', 'client-replies'),
    join(appRoot, 'src', 'components', 'base-constructor'),
    join(appRoot, 'src', 'components', 'email-sequence-v2'),
  ],
  extraFiles: [
    join(appRoot, 'src', 'components', 'PortalLoadingProvider.tsx'),
    join(appRoot, 'src', 'components', 'parsers', 'HHParserView.tsx'),
    join(appRoot, 'src', 'components', 'parsers', 'HHParserForm.tsx'),
    join(appRoot, 'src', 'components', 'parsers', 'JobsList.tsx'),
    join(appRoot, 'src', 'components', 'parsers', 'VacancyResults.tsx'),
    join(appRoot, 'src', 'components', 'parsers', 'SearchParserView.tsx'),
    join(appRoot, 'src', 'components', 'parsers', 'SearchParserForm.tsx'),
    join(appRoot, 'src', 'components', 'parsers', 'JobStatus.tsx'),
    join(appRoot, 'src', 'components', 'parsers', 'YandexMapsParserView.tsx'),
    join(appRoot, 'src', 'components', 'parsers', 'YandexMapsParserForm.tsx'),
    join(appRoot, 'src', 'lib', 'clientBrief', 'constants.ts'),
    join(appRoot, 'src', 'lib', 'clientBrief', 'sectionProgress.ts'),
    join(appRoot, 'src', 'lib', 'clientBrief', 'validate.ts'),
    join(appRoot, 'src', 'lib', 'emailSequenceV2', 'valuesChips.ts'),
    join(appRoot, 'src', 'lib', 'emailSequenceV2', 'letterDirtyGuard.ts'),
    join(appRoot, 'src', 'lib', 'tools', 'baseConstructorClientGuard.ts'),
    join(appRoot, 'src', 'lib', 'tools', 'baseConstructorEta.ts'),
    join(appRoot, 'src', 'lib', 'tools', 'columnMappingWarnings.ts'),
    join(appRoot, 'src', 'lib', 'clientLaunch', 'timezones.ts'),
    join(appRoot, 'src', 'lib', 'legal', 'offerText.ts'),
    join(appRoot, 'src', 'lib', 'clientNav.ts'),
    join(appRoot, 'src', 'lib', 'i18n.ts'),
    join(appRoot, 'src', 'lib', 'pageTitle.ts'),
  ],
  seedSources: Object.keys(MANUAL_OVERRIDES.en),
});
const landingSources = hasLandingSource
  ? extractHtmlUiSources(readFileSync(landingSourcePath, 'utf8'))
  : [];
const sources = [...new Set([...clientSources, ...landingSources])]
  .sort((left, right) => left.localeCompare(right, 'ru'));

function readExistingCatalogs() {
  const catalogs = { en: {}, es: {} };
  const parsedCatalogs = [];
  if (existsSync(outputPath)) {
    const source = readFileSync(outputPath, 'utf8');
    try {
      const packed = source.match(/const CLIENT_TRANSLATION_CATALOGS_JSON(?:: string)? = ("[\s\S]*");/);
      const object = source.match(/export const CLIENT_TRANSLATION_CATALOGS[^=]*=\s*(\{[\s\S]*\})(?: as const)?;/);
      if (packed) parsedCatalogs.push(JSON.parse(JSON.parse(packed[1])));
      else if (object) parsedCatalogs.push(JSON.parse(object[1]));
    } catch {
      // A malformed generated app catalog is rebuilt from the landing catalog.
    }
  }
  if (hasLandingSource && existsSync(landingOutputPath)) {
    const source = readFileSync(landingOutputPath, 'utf8');
    const match = source.match(/window\.OUTREACHOS_LANDING_TRANSLATIONS = (\{[\s\S]*\});/);
    if (match) {
      try {
        parsedCatalogs.push(JSON.parse(match[1]));
      } catch {
        // A malformed generated landing catalog is rebuilt from the app catalog.
      }
    }
  }
  for (const parsed of parsedCatalogs) {
    Object.assign(catalogs.en, parsed.en ?? {});
    Object.assign(catalogs.es, parsed.es ?? {});
  }
  return catalogs;
}

function parseJsonObject(content) {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return {};
    return JSON.parse(match[0]);
  }
}

async function translateBatchWithOpenRouter(batch, locale) {
  const payload = Object.fromEntries(batch.map((source, index) => [String(index), source]));
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://app.outreachos.pro',
      'X-Title': 'outreachOS static client localization',
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            `Translate Russian B2B SaaS interface copy into concise, natural ${TARGETS[locale]}.`,
            'Return only a JSON object with the same numeric keys.',
            'Preserve placeholders such as {0}, {1}, %s and {{count}} exactly.',
            'Preserve punctuation, line-break intent, symbols, product names and technical tokens.',
            'Use outreach terminology: база = contact list/database, ЦА = ICP/target audience, бриф = brief, цепочка писем = email sequence.',
            'Never add explanations and never leave Cyrillic in the translation.',
          ].join('\n'),
        },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
  }
  const body = await response.json();
  const parsed = parseJsonObject(body?.choices?.[0]?.message?.content ?? '');
  const output = {};
  batch.forEach((source, index) => {
    const target = parsed[String(index)];
    if (typeof target === 'string' && target.trim() && !/[А-Яа-яЁё]/.test(target)) {
      output[source] = target.trim();
    }
  });
  return output;
}

async function translateBatchWithGoogle(batch, locale) {
  const marked = batch.map((source, index) => `[[I18N_${index}]] ${source}`).join('\n');
  const params = new URLSearchParams({
    client: 'gtx',
    sl: 'ru',
    tl: locale,
    dt: 't',
    q: marked,
  });

  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch('https://translate.googleapis.com/translate_a/single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: params,
    });
    if (response.ok) break;
    if (![429, 500, 502, 503, 504].includes(response.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
  }
  if (!response?.ok) throw new Error(`Google Translate ${response?.status ?? 'no response'}`);

  const body = await response.json();
  const translated = Array.isArray(body?.[0])
    ? body[0].map((segment) => segment?.[0] ?? '').join('')
    : '';
  const output = {};
  const marker = /\[\[I18N_(\d+)\]\]\s*([\s\S]*?)(?=\n?\[\[I18N_\d+\]\]|$)/g;
  for (const match of translated.matchAll(marker)) {
    const index = Number(match[1]);
    const source = batch[index];
    const target = match[2]?.trim();
    if (source && target && !/[А-Яа-яЁё]/.test(target)) output[source] = target;
  }
  return output;
}

function translateBatch(batch, locale) {
  if (provider === 'openrouter') return translateBatchWithOpenRouter(batch, locale);
  if (provider === 'google') return translateBatchWithGoogle(batch, locale);
  throw new Error(`Unknown translation provider: ${provider}`);
}

async function runPool(items, worker, concurrency = 3) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function translateMissing(catalog, locale) {
  const missing = sources.filter((source) => !(source in catalog));
  if (missing.length === 0) return;
  if (provider === 'openrouter' && !apiKey) {
    throw new Error('No OpenRouter key configured for missing translations');
  }

  const batches = [];
  const batchSize = provider === 'google' ? 24 : 40;
  for (let index = 0; index < missing.length; index += batchSize) {
    batches.push(missing.slice(index, index + batchSize));
  }
  let completed = 0;
  await runPool(batches, async (batch) => {
    Object.assign(catalog, await translateBatch(batch, locale));
    completed += batch.length;
    console.log(`[${locale}] ${Math.min(completed, missing.length)}/${missing.length}`);
  });

  const unresolved = sources.filter((source) => !(source in catalog));
  if (unresolved.length > 0) {
    console.log(`[${locale}] retrying ${unresolved.length} unresolved strings`);
    for (let index = 0; index < unresolved.length; index += 12) {
      Object.assign(catalog, await translateBatch(unresolved.slice(index, index + 12), locale));
    }
  }
}

function writeCatalogs(catalogs) {
  const ordered = {};
  for (const locale of Object.keys(TARGETS)) {
    ordered[locale] = {};
    for (const source of clientSources) {
      const target = catalogs[locale][source];
      if (typeof target === 'string' && target.trim()) ordered[locale][source] = target.trim();
    }
  }
  const packedCatalog = JSON.stringify(JSON.stringify(ordered));
  const file = [
    '// Generated by app/scripts/generate-client-translations.mjs. Do not edit by hand.',
    `const CLIENT_TRANSLATION_CATALOGS_JSON = ${packedCatalog};`,
    'export const CLIENT_TRANSLATION_CATALOGS = JSON.parse(CLIENT_TRANSLATION_CATALOGS_JSON);',
    '',
  ].join('\n');
  writeFileSync(outputPath, file, 'utf8');
  writeFileSync(
    declarationOutputPath,
    [
      '// Generated by app/scripts/generate-client-translations.mjs. Do not edit by hand.',
      "export declare const CLIENT_TRANSLATION_CATALOGS: Readonly<Record<'en' | 'es', Readonly<Record<string, string>>>>;",
      '',
    ].join('\n'),
    'utf8',
  );

  const landingCatalogs = {};
  for (const locale of Object.keys(TARGETS)) {
    landingCatalogs[locale] = {};
    for (const source of landingSources) {
      const target = catalogs[locale][source];
      if (typeof target === 'string' && target.trim()) {
        landingCatalogs[locale][source] = target.trim();
      }
    }
  }
  if (hasLandingSource) {
    writeFileSync(
      landingOutputPath,
      [
        '/* Generated by app/scripts/generate-client-translations.mjs. */',
        `window.OUTREACHOS_LANDING_TRANSLATIONS = ${JSON.stringify(landingCatalogs, null, 2)};`,
        '',
      ].join('\n'),
      'utf8',
    );
  }
}

const catalogs = readExistingCatalogs();
Object.assign(catalogs.en, MANUAL_OVERRIDES.en);
Object.assign(catalogs.es, MANUAL_OVERRIDES.es);

for (const locale of requested) {
  await translateMissing(catalogs[locale], locale);
}
writeCatalogs(catalogs);

for (const locale of Object.keys(TARGETS)) {
  const clientCount = clientSources.filter((source) => source in catalogs[locale]).length;
  const landingCount = landingSources.filter((source) => source in catalogs[locale]).length;
  console.log(`${locale}: client ${clientCount}/${clientSources.length}; landing ${landingCount}/${landingSources.length}`);
  const unresolved = sources.filter((source) => !(source in catalogs[locale]));
  if (unresolved.length > 0) {
    console.error(`${locale}: unresolved sources:\n${unresolved.map((source) => `- ${source}`).join('\n')}`);
    process.exitCode = 1;
  }
}
