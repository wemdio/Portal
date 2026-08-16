/**
 * Словарь ESP (email service providers) для детекта по SPF-записи домена.
 *
 * Механика (реверс Mailganer, подтверждён app/scripts/verify-spf-self-parse.mjs):
 * в v=spf1 TXT-записи домена ищем подстроки-маркеры (include:-хосты сервисов).
 * Найденный маркер = компания подключила этот сервис для отправки писем.
 *
 * Категории:
 *   marketing      — сервисы рассылок по своей базе. Единственная категория,
 *                    дающая score: точное попадание в питч «вы уже делаете
 *                    email-маркетинг — попробуйте аутрич».
 *   crm            — рассылки из CRM/support-платформ. Информационно.
 *   transactional  — транзакционная инфраструктура (письма-чеки, уведомления).
 *                    Информационно: само по себе ≠ рассылки по базе.
 *   corporate      — корпоративная почта (Google/M365/...). Информационно.
 *   security       — почтовые security-шлюзы. Информационно.
 *
 * Расширение: добавить запись в ESP_DICTIONARY (weight > 0 только для
 * marketing), тест-кейс в espScan.test.ts не обязателен, но приветствуется.
 * Маркеры — lowercase подстроки, достаточно специфичные, чтобы не ловить
 * ложные совпадения на чужих доменах.
 */

export type EspCategory =
  | 'marketing'
  | 'crm'
  | 'transactional'
  | 'corporate'
  | 'security';

export interface EspEntry {
  /** Уникальный slug (фильтр экспорта, поле matched[].key). */
  key: string;
  /** Человеческое название для вывода в базе. */
  label: string;
  category: EspCategory;
  /** Вклад в score. Ненулевой — только у category='marketing'. */
  weight: number;
  /** Lowercase-подстроки для поиска в сырой SPF-строке. */
  markers: string[];
}

/** Вес «платформа рассылок» — один сервис уже достаточный сигнал. */
export const ESP_WEIGHT_PLATFORM = 50;
/** Вес marketing-automation — сам по себе тоже сигнал, чуть слабее. */
export const ESP_WEIGHT_AUTOMATION = 40;

export const ESP_DICTIONARY: EspEntry[] = [
  // --- Платформы email-маркетинга (weight 50) ---
  { key: 'mailchimp', label: 'Mailchimp', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['servers.mcsv.net', 'mcsv.net', 'mailchimp.com'] },
  { key: 'klaviyo', label: 'Klaviyo', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['klaviyo'] },
  { key: 'campaign_monitor', label: 'Campaign Monitor', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['crsend.com', 'createsend.com', 'campaignmonitor.com'] },
  { key: 'dotdigital', label: 'Dotdigital', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['dotdigital', 'dotmailer'] },
  { key: 'brevo', label: 'Brevo (Sendinblue)', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['sendinblue', 'brevo'] },
  { key: 'getresponse', label: 'GetResponse', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['getresponse'] },
  { key: 'activecampaign', label: 'ActiveCampaign', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['activehosted', 'activecampaign'] },
  { key: 'constant_contact', label: 'Constant Contact', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['ctctsend', 'ccsend.com', 'constantcontact'] },
  { key: 'aweber', label: 'AWeber', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['aweber.com'] },
  { key: 'omnisend', label: 'Omnisend', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['omnisend'] },
  { key: 'mailerlite', label: 'MailerLite', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['mailerlite'] },
  { key: 'mad_mimi', label: 'Mad Mimi', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['madmimi'] },
  { key: 'emma', label: 'Emma', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['e2ma.net', 'myemma'] },
  { key: 'kit', label: 'Kit (ConvertKit)', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['convertkit', 'spf.kit.com'] },
  { key: 'flodesk', label: 'Flodesk', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['flodesk'] },
  { key: 'moosend', label: 'Moosend', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['moosend'] },
  { key: 'sender', label: 'Sender', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['sender.net'] },
  { key: 'mailjet', label: 'Mailjet', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['mailjet'] },
  { key: 'benchmark', label: 'Benchmark Email', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['benchmarkemail'] },
  { key: 'pure360', label: 'Pure360', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['pure360'] },
  { key: 'maropost', label: 'Maropost', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['maropost'] },
  { key: 'listrak', label: 'Listrak', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['listrak'] },
  { key: 'sailthru', label: 'Sailthru', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['sailthru'] },
  { key: 'bronto', label: 'Oracle Bronto', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['bronto.com'] },
  { key: 'unisender', label: 'Unisender', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['unisender'] },
  { key: 'sendpulse', label: 'SendPulse', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['sendpulse'] },
  { key: 'sendsay', label: 'Sendsay', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['sendsay'] },
  { key: 'dashamail', label: 'DashaMail', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['dashamail', 'dasha.mail.ru'] },
  { key: 'mindbox', label: 'Mindbox', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['mindbox'] },
  { key: 'esputnik', label: 'eSputnik', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['esputnik'] },
  { key: 'enkod', label: 'enKod', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['enkod'] },
  { key: 'zoho_campaigns', label: 'Zoho Campaigns', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['campaigns.zoho', 'maillist.zoho'] },
  { key: 'ontraport', label: 'Ontraport', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['ontraport'] },
  { key: 'keap', label: 'Keap (Infusionsoft)', category: 'marketing', weight: ESP_WEIGHT_PLATFORM, markers: ['infusionsoft', 'keapmail'] },

  // --- Marketing automation / CRM-маркетинг (weight 40) ---
  { key: 'hubspot', label: 'HubSpot', category: 'marketing', weight: ESP_WEIGHT_AUTOMATION, markers: ['hubspotemail.net', 'hubspot.net'] },
  { key: 'marketo', label: 'Adobe Marketo', category: 'marketing', weight: ESP_WEIGHT_AUTOMATION, markers: ['mktomail.com'] },
  { key: 'salesforce_mc', label: 'Salesforce Marketing Cloud', category: 'marketing', weight: ESP_WEIGHT_AUTOMATION, markers: ['exacttarget'] },
  { key: 'pardot', label: 'Salesforce Pardot', category: 'marketing', weight: ESP_WEIGHT_AUTOMATION, markers: ['pardot'] },
  { key: 'eloqua', label: 'Oracle Eloqua', category: 'marketing', weight: ESP_WEIGHT_AUTOMATION, markers: ['eloqua'] },
  { key: 'iterable', label: 'Iterable', category: 'marketing', weight: ESP_WEIGHT_AUTOMATION, markers: ['iterable'] },
  { key: 'braze', label: 'Braze', category: 'marketing', weight: ESP_WEIGHT_AUTOMATION, markers: ['braze.com'] },
  { key: 'customer_io', label: 'Customer.io', category: 'marketing', weight: ESP_WEIGHT_AUTOMATION, markers: ['customer.io'] },
  { key: 'act_on', label: 'Act-On', category: 'marketing', weight: ESP_WEIGHT_AUTOMATION, markers: ['act-on.com'] },

  // --- CRM / support-платформы (информационно, weight 0) ---
  { key: 'salesforce', label: 'Salesforce (CRM)', category: 'crm', weight: 0, markers: ['salesforce.com'] },
  { key: 'zendesk', label: 'Zendesk', category: 'crm', weight: 0, markers: ['zendesk'] },
  { key: 'freshdesk', label: 'Freshdesk', category: 'crm', weight: 0, markers: ['freshdesk'] },
  { key: 'intercom', label: 'Intercom', category: 'crm', weight: 0, markers: ['intercom'] },
  { key: 'atlassian', label: 'Atlassian', category: 'crm', weight: 0, markers: ['atlassian.net'] },
  { key: 'servicenow', label: 'ServiceNow', category: 'crm', weight: 0, markers: ['servicenow'] },

  // --- Транзакционная инфраструктура (информационно, weight 0) ---
  { key: 'sendgrid', label: 'SendGrid', category: 'transactional', weight: 0, markers: ['sendgrid'] },
  { key: 'mailgun', label: 'Mailgun', category: 'transactional', weight: 0, markers: ['mailgun'] },
  { key: 'amazon_ses', label: 'Amazon SES', category: 'transactional', weight: 0, markers: ['amazonses'] },
  { key: 'postmark', label: 'Postmark', category: 'transactional', weight: 0, markers: ['mtasv.net', 'postmarkapp'] },
  { key: 'mandrill', label: 'Mandrill', category: 'transactional', weight: 0, markers: ['mandrillapp'] },
  { key: 'sparkpost', label: 'SparkPost', category: 'transactional', weight: 0, markers: ['sparkpost'] },
  { key: 'resend', label: 'Resend', category: 'transactional', weight: 0, markers: ['resend.com'] },
  { key: 'elastic_email', label: 'Elastic Email', category: 'transactional', weight: 0, markers: ['elasticemail'] },
  { key: 'smtp2go', label: 'SMTP2GO', category: 'transactional', weight: 0, markers: ['smtp2go'] },
  { key: 'socketlabs', label: 'SocketLabs', category: 'transactional', weight: 0, markers: ['socketlabs'] },
  { key: 'pepipost', label: 'Pepipost', category: 'transactional', weight: 0, markers: ['pepipost'] },

  // --- Корпоративная почта (информационно, weight 0) ---
  { key: 'google_workspace', label: 'Google Workspace', category: 'corporate', weight: 0, markers: ['_spf.google.com'] },
  { key: 'microsoft_365', label: 'Microsoft 365', category: 'corporate', weight: 0, markers: ['spf.protection.outlook.com'] },
  { key: 'zoho_mail', label: 'Zoho Mail', category: 'corporate', weight: 0, markers: ['mail.zoho'] },
  { key: 'yandex_360', label: 'Yandex 360', category: 'corporate', weight: 0, markers: ['_spf.yandex'] },
  { key: 'icloud', label: 'iCloud Custom Domain', category: 'corporate', weight: 0, markers: ['icloud.com'] },

  // --- Security-шлюзы (информационно, weight 0) ---
  { key: 'proofpoint', label: 'Proofpoint', category: 'security', weight: 0, markers: ['pphosted'] },
  { key: 'mimecast', label: 'Mimecast', category: 'security', weight: 0, markers: ['mimecast'] },
  { key: 'barracuda', label: 'Barracuda', category: 'security', weight: 0, markers: ['barracuda'] },
  { key: 'cisco_esa', label: 'Cisco ESA', category: 'security', weight: 0, markers: ['iphmx'] },
  { key: 'trend_micro', label: 'Trend Micro', category: 'security', weight: 0, markers: ['trendmicro'] },
];

export const ESP_CATEGORY_LABELS: Record<EspCategory, string> = {
  marketing: 'Рассылки (ESP)',
  crm: 'CRM/поддержка',
  transactional: 'Транзакционные',
  corporate: 'Корпоративная почта',
  security: 'Security-шлюз',
};

/** Сортированный список marketing-ESP для UI-фильтров. */
export const ESP_MARKETING_KEYS = ESP_DICTIONARY.filter((e) => e.category === 'marketing')
  .map((e) => e.key)
  .sort();
