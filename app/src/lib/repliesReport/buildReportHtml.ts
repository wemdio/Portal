import type { RepliesReportResult, CampaignReplies, ReportReply } from './types';

/**
 * Собирает самодостаточный читаемый HTML «Ответы по кампаниям» (без тональности):
 * таблица метрик по кампаниям + лента ответов, сгруппированная по кампаниям,
 * с поиском и фильтром-чипами. Чистая функция (client-safe), порт скрипта
 * app/scripts/replies-by-campaign.mjs. Заголовок таблицы НЕ sticky (баг Chromium
 * с border-collapse) — липкими оставлена только панель поиска/чипов.
 */

const TZ = 'Europe/Moscow';

function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const fmtDT = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtRange = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
const dt = (s: string | null): string => (s ? fmtDT.format(new Date(s)) : '');
const pct = (part: number, whole: number): string => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '0%');

const STYLE = `
:root{--bg:#f4f5f7;--panel:#fff;--ink:#16181d;--muted:#6b7280;--line:#e6e8ec;--accent:#2f6df6;--shadow:0 1px 2px rgba(16,24,40,.07)}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--panel:#171a21;--ink:#e7e9ee;--muted:#98a1b3;--line:#262b35;--accent:#6ea0ff;--shadow:0 1px 2px rgba(0,0,0,.4)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:0 18px 64px}
header.top{position:sticky;top:0;z-index:5;background:linear-gradient(var(--bg),var(--bg) 80%,transparent);padding:22px 18px 10px;margin:0 -18px}
h1{font-size:21px;margin:0 0 4px}.sub{color:var(--muted);font-size:13px;margin-bottom:12px}
.mtable{width:100%;border-collapse:collapse;font-size:13px;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:6px}
.mtable th,.mtable td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
.mtable th{font-size:11px;color:var(--muted);font-weight:600;background:var(--panel)}
.mtable th:first-child,.mtable td:first-child{text-align:left;white-space:normal;overflow-wrap:anywhere}
.mtable tfoot td{font-weight:700;border-top:2px solid var(--line);border-bottom:none}
#q{width:100%;max-width:440px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--ink);font-size:14px;outline:none;box-shadow:var(--shadow)}
#q:focus{border-color:var(--accent)}
.chips{display:flex;flex-wrap:wrap;gap:7px;margin:12px 0 4px}
.chip{border:1px solid var(--line);background:var(--panel);color:var(--muted);border-radius:999px;padding:6px 12px;font-size:12.5px;cursor:pointer;box-shadow:var(--shadow);user-select:none}
.chip.active{background:var(--accent);border-color:var(--accent);color:#fff}
.camp{margin-top:26px}
.camp h2{position:sticky;top:150px;font-size:15px;margin:0 0 10px;padding:7px 0;background:var(--bg);border-bottom:2px solid var(--line)}
.camp h2 .c{color:var(--muted);font-weight:500;font-size:13px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:14px 16px;margin:9px 0;box-shadow:var(--shadow)}
.ch{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.nm{font-weight:650;overflow-wrap:anywhere}.wh{color:var(--muted);font-size:12.5px;white-space:nowrap}
.meta{color:var(--muted);font-size:12.5px;margin-top:6px;overflow-wrap:anywhere}.meta b{color:var(--ink)}
.subj{font-weight:600;margin-top:9px;overflow-wrap:anywhere}
.body{margin-top:7px;white-space:pre-wrap;overflow-wrap:anywhere}
.empty{display:none;text-align:center;color:var(--muted);padding:40px 0}
footer{color:var(--muted);font-size:12px;margin-top:30px;text-align:center}
`;

const SCRIPT = `
(function(){
 var q=document.getElementById('q'),chips=[].slice.call(document.querySelectorAll('.chip'));
 var camps=[].slice.call(document.querySelectorAll('.camp')),cards=[].slice.call(document.querySelectorAll('.card'));
 var emptyEl=document.getElementById('empty'),sel='__all',term='';
 function apply(){
   var shown=0;
   for(var c=0;c<camps.length;c++){
     var key=camps[c].getAttribute('data-camp');
     var campOk=(sel==='__all'||sel===key);
     var any=false; var cs=camps[c].querySelectorAll('.card');
     for(var i=0;i<cs.length;i++){
       var ok=campOk && (!term || cs[i].getAttribute('data-text').indexOf(term)!==-1);
       cs[i].style.display=ok?'':'none'; if(ok){any=true;shown++;}
     }
     camps[c].style.display=any?'':'none';
   }
   if(emptyEl)emptyEl.style.display=shown?'none':'block';
 }
 q.addEventListener('input',function(){term=(q.value||'').toLowerCase().trim();apply();});
 for(var i=0;i<chips.length;i++)chips[i].addEventListener('click',function(e){
   sel=e.currentTarget.getAttribute('data-c');
   for(var j=0;j<chips.length;j++)chips[j].classList.toggle('active',chips[j]===e.currentTarget);
   apply();
 });
 apply();
})();
`;

const MAX_BODY = 8000;

function card(r: ReportReply): string {
  const name = r.from_name || r.from_email || '(без имени)';
  const body = (r.body_text || '').length > MAX_BODY ? `${(r.body_text || '').slice(0, MAX_BODY)}\n\n…(обрезано)` : (r.body_text || '');
  const search = escapeHtml(`${name} ${r.from_email || ''} ${r.subject || ''} ${r.body_text || ''}`.toLowerCase());
  return [
    `<article class="card" data-text="${search}">`,
    `<div class="ch"><span class="nm">${escapeHtml(name)}</span><span class="wh">${escapeHtml(dt(r.timestamp))}</span></div>`,
    `<div class="meta">${escapeHtml(r.from_email || '')}${r.eaccount ? ` · на ящик <b>${escapeHtml(r.eaccount)}</b>` : ''}</div>`,
    r.subject ? `<div class="subj">${escapeHtml(r.subject)}</div>` : '',
    `<div class="body">${escapeHtml(body)}</div>`,
    `</article>`,
  ].join('');
}

function shortName(name: string): string {
  return name.replace(/_?БанкЕдыРусь_?/i, ' ').replace(/\s+/g, ' ').trim() || name;
}

export function buildRepliesReportHtml(result: RepliesReportResult, opts?: { title?: string }): string {
  const campaigns: CampaignReplies[] = [...result.campaigns];
  const totalReplies = campaigns.reduce((s, c) => s + c.replies.length, 0);
  const title = opts?.title || 'Ответы по кампаниям';

  const periodLabel = result.since || result.until
    ? `${result.since ? fmtRange.format(new Date(`${result.since}T00:00:00Z`)) : '…'} — ${result.until ? fmtRange.format(new Date(`${result.until}T23:59:59Z`)) : 'сейчас'}`
    : 'за всё время';
  const generated = fmtDT.format(new Date(result.generatedAt));

  // таблица метрик
  const tot = campaigns.reduce(
    (a, c) => ({
      contacts: a.contacts + c.metrics.contacts,
      emailsSent: a.emailsSent + c.metrics.emailsSent,
      opened: a.opened + c.metrics.opened,
      replies: a.replies + c.metrics.replies,
      fetched: a.fetched + c.replies.length,
    }),
    { contacts: 0, emailsSent: 0, opened: 0, replies: 0, fetched: 0 },
  );
  const mrow = (c: CampaignReplies) =>
    `<tr><td>${escapeHtml(c.name)}${c.failed ? ' ⚠' : ''}</td>` +
    `<td>${c.metrics.contacts}</td><td>${c.metrics.emailsSent}</td>` +
    `<td>${c.metrics.opened} · ${pct(c.metrics.opened, c.metrics.emailsSent)}</td>` +
    `<td>${c.metrics.replies} · ${pct(c.metrics.replies, c.metrics.contacts)}</td>` +
    `<td>${c.replies.length}${c.truncated ? '+' : ''}</td></tr>`;
  const metricsTable =
    `<table class="mtable"><thead><tr>` +
    `<th>Кампания</th><th>Контактов</th><th>Отправлено</th><th>Открытий · %</th><th>Ответов · %</th><th>Собрано ответов</th>` +
    `</tr></thead><tbody>${campaigns.map(mrow).join('')}</tbody>` +
    `<tfoot><tr><td>ИТОГО</td><td>${tot.contacts}</td><td>${tot.emailsSent}</td>` +
    `<td>${tot.opened} · ${pct(tot.opened, tot.emailsSent)}</td>` +
    `<td>${tot.replies} · ${pct(tot.replies, tot.contacts)}</td><td>${tot.fetched}</td></tr></tfoot></table>`;

  const chips = [`<span class="chip active" data-c="__all">Все (${totalReplies})</span>`]
    .concat(campaigns.map((c) => `<span class="chip" data-c="${escapeHtml(c.id)}">${escapeHtml(shortName(c.name))} (${c.replies.length})</span>`));

  const sections = campaigns
    .map((c) =>
      `<section class="camp" data-camp="${escapeHtml(c.id)}"><h2>${escapeHtml(c.name)} <span class="c">— ${c.replies.length} ответов${c.truncated ? ' (показаны первые ' + c.replies.length + ')' : ''}</span></h2>` +
      (c.replies.length ? c.replies.map(card).join('') : '<div class="meta" style="padding:6px 2px">Нет входящих ответов за период.</div>') +
      `</section>`,
    )
    .join('');

  return [
    '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><div class="wrap">`,
    '<header class="top">',
    `<h1>${escapeHtml(title)}</h1>`,
    `<div class="sub">Период: ${escapeHtml(periodLabel)} · всего ответов: ${totalReplies} · ${campaigns.length} кампаний · время ${escapeHtml(TZ)} · сформировано ${escapeHtml(generated)}</div>`,
    metricsTable,
    '<input id="q" type="search" placeholder="Поиск по тексту, теме, отправителю…" autocomplete="off">',
    `<div class="chips">${chips.join('')}</div>`,
    '</header>',
    sections,
    '<div class="empty" id="empty">Ничего не найдено.</div>',
    '<footer>Сгруппировано по кампаниям; внутри — от новых к старым. Метрики — из аналитики Instantly (за всё время); период применён к списку ответов.</footer>',
    '</div>',
    `<script>${SCRIPT}</script></body></html>`,
  ].join('');
}
