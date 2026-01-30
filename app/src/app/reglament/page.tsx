'use client';
/* eslint-disable react/no-unescaped-entities, @next/next/no-img-element */

import { useState, useRef, useEffect } from 'react';
import type { LucideIcon } from 'lucide-react';
import { 
  CheckCircle2, CheckCircle, Clock, Database, Mail, FileText, Pin, Globe, 
  BarChart3, AlertCircle, User, Calendar, MessageSquare, 
  Users, Shield, BookOpen, ExternalLink, ArrowRight, PenTool, 
  Video, Book, CheckSquare, Image as ImageIcon, Search,
  Zap, ShieldAlert, XCircle, UserCheck, Sparkles, Server, Ban,
  HardDrive, Monitor, Map, Briefcase, MessageCircle, Link, Download,
  Table, Code, Bot, Wand2, Copy, Trash2, Filter, Calculator, 
  ClipboardList, Plane, Target, FileImage, DollarSign, Megaphone,
  Settings, MousePointer, LineChart
} from 'lucide-react';

interface SearchResult {
  id: string;
  title: string;
  context: string;
  sectionId: string;
  searchText: string;
}

type ContentLink = {
  text: string;
  url: string;
};

type DetailsItem = {
  icon: LucideIcon;
  title: string;
  content: string;
  links?: ContentLink[];
};

export default function ReglamentPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Поиск по всему тексту
  const searchInContent = (query: string): SearchResult[] => {
    if (!query.trim() || !contentRef.current) return [];

    const results: SearchResult[] = [];
    const queryLower = query.toLowerCase();
    const sections = contentRef.current.querySelectorAll('section[id]');

    sections.forEach((section) => {
      const sectionElement = section as HTMLElement;
      const sectionId = sectionElement.id;
      const sectionTitle = sectionElement.querySelector('h2')?.textContent || '';
      
      // Получаем весь текст раздела
      const walker = document.createTreeWalker(
        sectionElement,
        NodeFilter.SHOW_TEXT,
        null
      );

      const textNodes: Text[] = [];
      let node;
      while (node = walker.nextNode()) {
        if (node.textContent && node.textContent.trim()) {
          textNodes.push(node as Text);
        }
      }

      // Ищем вхождения в тексте
      textNodes.forEach((textNode) => {
        const text = textNode.textContent || '';
        const textLower = text.toLowerCase();
        let index = textLower.indexOf(queryLower);
        
        while (index !== -1 && results.length < 20) {
          // Получаем контекст (50 символов до и после)
          const start = Math.max(0, index - 50);
          const end = Math.min(text.length, index + query.length + 50);
          let context = text.substring(start, end);
          
          // Добавляем многоточие если обрезали
          if (start > 0) context = '...' + context;
          if (end < text.length) context = context + '...';
          
          // Выделяем найденное слово
          const matchIndex = context.toLowerCase().indexOf(queryLower);
          if (matchIndex !== -1) {
            const beforeMatch = context.substring(0, matchIndex);
            const match = context.substring(matchIndex, matchIndex + query.length);
            const afterMatch = context.substring(matchIndex + query.length);
            
            results.push({
              id: `${sectionId}-${results.length}-${index}`,
              title: sectionTitle || 'Раздел',
              context: beforeMatch + match + afterMatch,
              sectionId: sectionId,
              searchText: query
            });
          }
          
          // Ищем следующее вхождение
          index = textLower.indexOf(queryLower, index + 1);
        }
      });
    });

    // Ограничиваем до 5 результатов
    return results.slice(0, 5);
  };

  // Поиск по разделам
  const updateSearch = (value: string) => {
    setSearchQuery(value);

    if (!value.trim()) {
      setSearchResults([]);
      setShowResults(false);
      return;
    }

    const results = searchInContent(value);
    setSearchResults(results);
    setShowResults(true);
  };

  // Плавная прокрутка к найденному тексту
  const scrollToResult = (result: SearchResult) => {
    const query = result.searchText.toLowerCase();
    setShowResults(false);
    updateSearch('');
    
    // Небольшая задержка для закрытия выпадающего меню
    setTimeout(() => {
      const section = document.getElementById(result.sectionId);
      if (!section) {
        return;
      }
      
      // Ищем текст в разделе
      const allText = section.innerText || section.textContent || '';
      console.log('Section text length:', allText.length);
      
      if (!allText.toLowerCase().includes(query)) {
        console.log('Text not found in section, scrolling to section');
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      
      // Ищем текстовый узел с нужным текстом
      const walker = document.createTreeWalker(
        section,
        NodeFilter.SHOW_TEXT,
        null
      );
      
      let foundNode: Text | null = null;
      let foundOffset = -1;
      
      let node;
      while (node = walker.nextNode()) {
        const text = node.textContent || '';
        const textLower = text.toLowerCase();
        const index = textLower.indexOf(query);
        
        if (index !== -1) {
          foundNode = node as Text;
          foundOffset = index;
          console.log('Found text node at offset:', index);
          break;
        }
      }
      
      if (foundNode && foundOffset !== -1) {
        try {
          // Создаем Range
          const range = document.createRange();
          range.setStart(foundNode, foundOffset);
          range.setEnd(foundNode, foundOffset + query.length);
          
          // Получаем координаты
          const rect = range.getBoundingClientRect();
          console.log('Range rect:', rect);
          
          // Находим родительский элемент для прокрутки
          let scrollTarget: HTMLElement | null = foundNode.parentElement;
          while (scrollTarget && scrollTarget !== section && scrollTarget !== document.body) {
            const tagName = scrollTarget.tagName;
            if (['P', 'DIV', 'LI', 'SPAN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(tagName)) {
              break;
            }
            scrollTarget = scrollTarget.parentElement;
          }
          
          if (scrollTarget && scrollTarget !== document.body) {
            // Прокручиваем к элементу
            scrollTarget.scrollIntoView({ 
              behavior: 'smooth', 
              block: 'center',
              inline: 'nearest'
            });
          } else {
            // Fallback: используем координаты
            const currentScrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
            const targetScrollY = currentScrollY + rect.top - 150;
            window.scrollTo({
              top: Math.max(0, targetScrollY),
              behavior: 'smooth'
            });
          }
          
          // Подсвечиваем текст после прокрутки
          setTimeout(() => {
            try {
              const highlightRange = document.createRange();
              highlightRange.setStart(foundNode!, foundOffset);
              highlightRange.setEnd(foundNode!, foundOffset + query.length);
              
              try {
                const highlight = document.createElement('mark');
                highlight.style.backgroundColor = 'rgba(255, 255, 0, 0.6)';
                highlight.style.padding = '2px 0';
                highlightRange.surroundContents(highlight);
                
                setTimeout(() => {
                  if (highlight.parentNode) {
                    const parent = highlight.parentNode;
                    const textNode = document.createTextNode(highlight.textContent || '');
                    parent.replaceChild(textNode, highlight);
                    parent.normalize();
                  }
                }, 2000);
              } catch {
                const parent = foundNode!.parentElement;
                if (parent) {
                  parent.style.transition = 'background-color 0.3s';
                  parent.style.backgroundColor = 'rgba(255, 255, 0, 0.4)';
                  setTimeout(() => {
                    parent.style.backgroundColor = '';
                    parent.style.transition = '';
                  }, 2000);
                }
              }
            } catch {
              // Игнорируем ошибки подсветки
            }
          }, 600);
        } catch {
          section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } else {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 50);
  };

  // Закрытие результатов при клике вне
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchInputRef.current && !searchInputRef.current.contains(event.target as Node)) {
        setShowResults(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="mb-8">
        <h1 className="text-4xl font-bold mb-2 text-gray-900">Регламент работы</h1>
        <p className="text-gray-600">Руководство по работе для специалистов Polza Agency</p>
        
        {/* Поиск */}
        <div className="mt-6 relative" ref={searchInputRef}>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-5 w-5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => updateSearch(e.target.value)}
              onFocus={() => searchQuery && setShowResults(true)}
              placeholder="Поиск по тексту..."
              className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          
          {/* Результаты поиска */}
          {showResults && searchResults.length > 0 && (
            <div className="absolute z-50 w-full mt-2 bg-white border border-gray-200 rounded-lg shadow-lg max-h-80 overflow-y-auto">
              {searchResults.map((result) => (
                <button
                  key={result.id}
                  onClick={() => scrollToResult(result)}
                  className="w-full text-left px-4 py-3 hover:bg-blue-50 border-b border-gray-100 last:border-b-0 transition-colors"
                >
                  <div className="font-medium text-gray-900 mb-1">{result.title}</div>
                  <div className="text-sm text-gray-600 line-clamp-2">
                    {result.context.split(new RegExp(`(${searchQuery})`, 'gi')).map((part, i) => 
                      part.toLowerCase() === searchQuery.toLowerCase() ? (
                        <mark key={i} className="bg-yellow-200 font-semibold">{part}</mark>
                      ) : (
                        <span key={i}>{part}</span>
                      )
                    )}
                  </div>
                </button>
              ))}
              {searchResults.length >= 5 && (
                <div className="px-4 py-2 text-xs text-gray-500 text-center bg-gray-50">
                  Показано 5 результатов. Прокрутите для просмотра всех.
                </div>
              )}
            </div>
          )}
          
          {showResults && searchQuery && searchResults.length === 0 && (
            <div className="absolute z-50 w-full mt-2 bg-white border border-gray-200 rounded-lg shadow-lg p-4">
              <p className="text-gray-500 text-center">Ничего не найдено</p>
            </div>
          )}
        </div>
      </div>
      
      <div ref={contentRef} className="space-y-6">
        {/* Этапы работы */}
        <section id="etapy-raboty" className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl shadow-md border border-blue-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-blue-600 rounded-lg">
              <CheckCircle2 className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Этапы работы</h2>
          </div>
          <div className="bg-white rounded-lg p-6 shadow-sm">
            <ul className="space-y-3">
              {[
                'создать/настроить почты, с которых будем отправлять письма',
                'собрать базу контактов, спарсить и верифицировать их',
                'написать цепочку писем, добавить utm метки в ссылки на сайт клиента',
                'согласование материалов с наставником, отправка клиенту и принятие правок от клиента',
                'оформить и отправить рассылку',
                'передать лидов клиенту'
              ].map((item, idx) => (
                <li key={idx} className="flex items-start gap-3 text-gray-700">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-sm font-semibold mt-0.5">
                    {idx + 1}
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <div className="mt-6 p-4 bg-amber-50 border-l-4 border-amber-400 rounded-r-md">
              <p className="text-sm text-amber-900">
                <span className="font-semibold">Примечание:</span> В первые 2 недели обучения специалиста все материалы и запуски проверяет наставник, далее руководитель проекта (посмотреть, кто на проекте рук можно в таблице учета)
              </p>
            </div>
          </div>
        </section>

        {/* Подробнее */}
        <section id="podrobnee" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-indigo-600 rounded-lg">
              <BookOpen className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Подробнее</h2>
          </div>
          
          <div className="space-y-5">
            {([
              { icon: Clock, title: 'Рабочий день', content: 'Рабочий день начинается с 10:00 по МСК до 19:00 по МСК с определения своих задач и проблем по проектам, список которых нужно отправить в общий чат Polza в Телеграм. В течение рабочего дня записываем все, что сделано и как решили проблемы. В конце дня отправляем в общий чат этот список. Каждый день в 12ч. по мск общий звонок в Гугл мит.' },
              { icon: Calendar, title: 'Таймлайн проекта', content: 'В чате с клиентом всегда по датам расписаны шаги (заполнение брифа клиентом, сбор базы, создание цепочки писем, запуск). Если неизвестно, сколько времени займет задача, лучше начать ее выполнение за 1-2 дня до назначенного срока (при условии, что клиент заполнил бриф).' },
              { icon: Database, title: 'База', content: 'Собираем базу компаний, которым будем отправлять рассылку. Есть разные способы собрать базу: HH, карты 2gis, 70+, экспортбэйс (дорого), LinkedIn и Аполло (для иностранных баз), кворк и др. Если база компаний состоит из сайтов, а имейлов в ней нет, получаем имейлы в экстракторе. Согласовываем базу с руководителем, после чего отправляем на согласование клиенту в чат. Важно: если понимаете, что по итогу сбора баз выходит меньше 200 контактов, то нужно написать клиенту уточняющие вопросы по расширению критериев для их поиска, т.к. они неосознанно сами же могут урезать возможность для выборки (из вариантов: шире география, доп отрасли, конкретные оквэды, инн и т.д). Верифицировать собранные базы - проверять на актуальность рабочие/не рабочие (или даже если они из готовых баз) нужно через letsextract.' },
              { icon: Mail, title: 'Оффер', content: 'В чате с клиентом берем заполненный клиентом бриф, изучаем его, определяем целевую аудиторию и пишем цепочку писем (оффер). Отправляем цепочку на проверку своему наставнику по обучению. Потом нужно будет сделать правки и отправить оффер на согласование клиенту в чат и внести правки от клиента.' },
            ] as DetailsItem[]).map((item, idx) => (
              <div key={idx} className="group border border-gray-200 rounded-lg p-5 hover:border-indigo-300 hover:shadow-md transition-all duration-200 bg-gray-50">
                <div className="flex items-start gap-4">
                  <div className="p-2 bg-indigo-100 rounded-lg group-hover:bg-indigo-200 transition-colors">
                    <item.icon className="h-5 w-5 text-indigo-600" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-2 text-lg">{item.title}</h3>
                    <p className="text-gray-700 leading-relaxed">
                      {item.content.split(/(https?:\/\/[^\s]+|тут|ссылка|Отчет спецов по проблемным проектам|Учет проектов внутреннее от 20\.10|🛑 BlockList \| Instantly \(Черный список\))/).map((part, i) => {
                        const link = item.links?.find(l => part.includes(l.text) || part.includes(l.url));
                        if (link) {
                          return (
                            <a 
                              key={i}
                              href={link.url} 
                              target="_blank" 
                              rel="noopener noreferrer" 
                              className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium"
                            >
                              {link.text}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          );
                        }
                        return <span key={i}>{part}</span>;
                      })}
                    </p>
                  </div>
                </div>
              </div>
            ))}

            {([
              { icon: FileText, title: 'Таблица лидов', content: 'Создаем в Гугл шитс таблицу по шаблону (нужно сделать копию), в которую потом будем вносить лиды, отчет (после окончания тестового периода и после достижения кпи), расходы, гипотезы. Перемещаем эту таблицу в папку своего проекта на диске Пользы.' },
              { icon: Pin, title: 'Закреп', content: 'Создаем закрепленное сообщение в чате с клиентом, в котором прописываем ближайшие 2-4 гипотезы с датами, кпи, у клиента для пересылки лидов и ссылку на таблицу лидов. (рядом с гипотезами, которые всё ещё крутятся, ставим статус "в работе", а завершённые кампании убираем из закрепа). Обновляем закрепы каждую пятницу.' },
              { icon: Globe, title: 'Домены и почты для отправки рассылки', content: 'Если в договоре проекта указано про именные домены: Покупаем именной домен, а потом в Гугл воркспейс (https://admin.google.com/) или на альтернативном сервисе создаем именные почты (пользователей) на купленном домене. Если не указано про именные, то используем готовые почты с нашего почтового сервера (в Instantly они под тегами указаны (почтовые сервера 1, 2, 3, 4, 5). Когда выбрали почты и поставили тег, отмечаем в этой таблице, какие почты для какого проекта взяли (лист "Свободные" - как только выбрали почты переносим их на лист "Заняты").', links: [{ text: 'https://admin.google.com/', url: 'https://admin.google.com/' }] },
              { icon: Mail, title: 'Instantly', content: 'Это сервис для отправки рассылки. Нужно проверить, добавлены ли здесь выбранные для проекта почты. Если почты не добавлены (например, их только создали), добавляем их и ставим на прогрев (в регламенте нужно про прогрев подробнее). Создаем новую кампанию. Про добавление картинок в письмо написано здесь.', links: [{ text: 'https://instantly.ai/', url: 'https://instantly.ai/' }] },
              { icon: BarChart3, title: 'Учет проектов', content: 'В конце каждой недели в пятницу вносим количество лидов в эту таблицу, а также вносим расходы на сбор баз (кроме экстрактора), покупку доменов, создание пользователей в эту форму (все расходы отображаются здесь). Сделать это нужно до нашего общего звонка.' },
              { icon: FileText, title: 'Еженедельный отчёт по проектам', content: 'Раз в неделю по понедельникам (желательно до 16:00 по МСК) специалистам необходимо заполнять еженедельный отчет по своим проектам и отправлять его в чат с заказчиком. Заполнять его нужно в таблице самого проекта, куда вносим лиды и доп расход (нужна вкладка "Email Otreach, отчет"). Отчёт формируется при помощи скрипта, подробнее про него и как им пользоваться тут.', links: [{ text: 'тут', url: 'https://docs.google.com/document/d/1-npB_6xhbgHCfuhF6GHpXIx6xUhgZIXNZHzji8fzchk/edit?pli=1&tab=t.0#heading=h.tquuykum3mqb' }] },
              { icon: AlertCircle, title: 'Отчёт по проблемным проектам', content: 'Когда по проекту плохо идут лиды и есть сложности в генерации гипотез, то нужно заполнять Отчет спецов по проблемным проектам, чтобы рассчитать сколько ещё нужно мощностей, писем в цепочке, дней для достижения KPI и т.д.', links: [{ text: 'Отчет спецов по проблемным проектам', url: 'https://docs.google.com/spreadsheets/u/0/d/1RaGZmDH6mZJS8yvwy94OSorqYFTeKGNJg-Mpt-qZi1Q/edit' }] },
              { icon: User, title: 'Личный KPI', content: 'Всем специалистам нужно поддерживать актуальной информацию по себе на листе "Личный KPI" в таблице Учет проектов внутреннее от 20.10. Инструкции по заполнению есть в самой таблице.', links: [{ text: 'Учет проектов внутреннее от 20.10', url: 'https://docs.google.com/spreadsheets/d/1dh5oK-Uhz7a4QvcLn4Wvzr_S2kVuP4KoQRawPUFzL58/edit?usp=sharing' }] },
              { icon: BookOpen, title: 'Журнал тестов', content: 'Раз в месяц нужно заполнять в таблице учета проектов лист "Журнал тестов" по гипотезам, которые сработали по разным проектам. Формат такой: пишем сферу компании, суть гипотезы и какой результат.', links: [{ text: 'ссылка', url: 'https://docs.google.com/spreadsheets/d/1RIlIcheJoFzp63t0QPVWnGc8e7GKDzCGKhIz8-UO0xg/edit?gid=527804907#gid=527804907' }] },
              { icon: Shield, title: 'BlockList', content: 'Необходимо добавлять домены действующих наших клиентов в таблицу: 🛑 BlockList | Instantly (Черный список). Это нужно для того, чтобы наши аутрич письма не отправлялись нашим действующим клиентам. Таблица подключена в Instantly, ссылку важно обновлять, когда добавляете новые домены в неё: заходим в настройки Instantly → блок лист, ссылка на нашу таблицу, нажимаем «Set block list». Готово!', links: [{ text: '🛑 BlockList | Instantly (Черный список)', url: 'https://docs.google.com/spreadsheets/d/1GYKM2X44pBodVrwnim1bgye5fI9k1F_dx7kjwe_Ey8s/edit?usp=sharing' }] },
              { icon: CheckCircle2, title: 'Проверка кампаний в Instantly', content: 'Каждую пятницу до 15:00 по мск нужно успеть проверить все свои кампании по проектам: в завершенных, чтобы не было контактов, а в запущенных не было ошибок и всё исправно работало, если же есть какие-то технические проблемы, то нужно сразу написать об этом в чат аутрича "Поломка", отметить Дениса и описать суть (лучше ещё приложить соответствующие скрины).' },
              { icon: Users, title: 'Нагрузка по проектам', content: 'Распределение проектов делаем из расчета того, сколько специалист может вести параллельно. Задача спеца здесь - вовремя сигнализировать руководителям, когда вы не справляетесь с нагрузкой, чтобы с вас сняли проект и передали следующему человеку. Важно: если понимаете, что тяжело дается ведение нескольких проектов - не молчите до последнего, чтобы не страдала ваша менталка и качество работы на самом проекте. Как передавать проекты правильно, расписано тут.' }
            ] as DetailsItem[]).map((item, idx) => (
              <div key={idx} className="group border border-gray-200 rounded-lg p-5 hover:border-indigo-300 hover:shadow-md transition-all duration-200 bg-gray-50">
                <div className="flex items-start gap-4">
                  <div className="p-2 bg-indigo-100 rounded-lg group-hover:bg-indigo-200 transition-colors">
                    <item.icon className="h-5 w-5 text-indigo-600" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-2 text-lg">{item.title}</h3>
                    <p className="text-gray-700 leading-relaxed">
                      {item.content.split(/(https?:\/\/[^\s]+|тут|ссылка|Отчет спецов по проблемным проектам|Учет проектов внутреннее от 20\.10|🛑 BlockList \| Instantly \(Черный список\))/).map((part, i) => {
                        const link = item.links?.find(l => part.includes(l.text) || part.includes(l.url));
                        if (link) {
                          return (
                            <a 
                              key={i}
                              href={link.url} 
                              target="_blank" 
                              rel="noopener noreferrer" 
                              className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium"
                            >
                              {link.text}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          );
                        }
                        return <span key={i}>{part}</span>;
                      })}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Регламент по работе с клиентами */}
        <section id="reglament-klienty" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-purple-600 rounded-lg">
              <Users className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">
              Регламент по работе с клиентами
            </h2>
            <span className="text-sm text-gray-500">для специалистов и руководителей проектов Polza Agency</span>
          </div>

          <div className="space-y-6">
            {/* Раздел 1 */}
            <div className="border-l-4 border-purple-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <Calendar className="h-5 w-5 text-purple-600" />
                1. Начало работы по проекту (День 0-1)
              </h3>
              <div className="space-y-4">
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">1.1. Первичный анализ и onboarding:</h4>
                  <p className="text-gray-700 mb-3">
                    После передачи проекта от отдела продаж или руководителя, специалист обязан в течение одного рабочего дня:
                  </p>
                  <ul className="space-y-2 ml-4">
                    {[
                      'Провести первичный разбор проекта (отсмотреть запись звонка, изучить бриф, пообщаться с GPT для полного (!) понимания продукта).',
                      'Сформировать со старшим специалистом/лидом предварительный таймлайн (помним, что в двухмесячные тарифы ОП (отдел продаж) называет сроки подготовки в 2 недели - используйте это в своих целях для повышения лояльности с точки зрения быстрого запуска, ЛИБО готовьтесь дольше, но качественнее).',
                      'Быть добавленным в общий чат с клиентом.',
                      'Поприветствовать клиента в день передачи проекта (смотри скрипт ниже).'
                    ].map((item, i) => (
                      <li key={i} className="flex items-start gap-2 text-gray-700">
                        <CheckCircle2 className="h-4 w-4 text-green-500 mt-1 flex-shrink-0" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">1.2. Первое сообщение клиенту:</h4>
                  <div className="bg-blue-50 border-l-4 border-blue-500 p-4 rounded-r-md">
                    <p className="text-gray-700 italic leading-relaxed">
                      Добрый день, Имя Клиента!<br/>
                      Меня зовут Имя Специалиста - специалист Polza Agency по запуску имейл-аутрича и ответственное лицо за Ваш проект. В ближайшее время приступаю к детальному анализу брифа, вернусь к Вам с вопросами и уточнениями.<br/><br/>
                      Также, по всем вопросам Вы можете обращаться ко мне.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Раздел 2 */}
            <div className="border-l-4 border-purple-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <MessageSquare className="h-5 w-5 text-purple-600" />
                2. Планирование и гипотезы (День 2)
              </h3>
              <div className="space-y-4">
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">2.1. Формирование гипотез:</h4>
                  <p className="text-gray-700 mb-3">
                    На второй рабочий день специалист предоставляет клиенту список первоначальных гипотез для тестирования.
                  </p>
                  <div className="bg-amber-50 border-l-4 border-amber-400 p-3 rounded-r-md">
                    <p className="text-gray-700">
                      <span className="font-semibold">Важно:</span> Если информации в брифе недостаточно для формирования гипотез, специалист в обязательном порядке инициирует и согласовывает с клиентом ознакомительный звонок, что в двухмесячных тарифах является ОБЯЗАТЕЛЬСТВОМ, в одномесячных - индивидуальной инициативой. В идеале, такой звонок должен проводиться для каждого нового проекта.
                    </p>
                  </div>
                </div>

                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">2.2. Проведение звонка:</h4>
                  <p className="text-gray-700 mb-3">На звонке необходимо:</p>
                  <ul className="space-y-2 ml-4">
                    {[
                      'Детально проговорить специфику бизнеса клиента простым языком и добиться полного понимания основных продаваемых выгод, процессов, УТП.',
                      'Сформировать и согласовать гипотезы для дальнейшей работы.',
                      'Уточнить все неясные моменты брифа, помочь клиенту с незаполненными разделами.'
                    ].map((item, i) => (
                      <li key={i} className="flex items-start gap-2 text-gray-700">
                        <CheckCircle2 className="h-4 w-4 text-green-500 mt-1 flex-shrink-0" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>

            {/* Раздел 3 */}
            <div className="border-l-4 border-purple-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <Database className="h-5 w-5 text-purple-600" />
                3. Операционная работа
              </h3>
              <div className="space-y-4">
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">3.1. Работа с базами данных:</h4>
                  <p className="text-gray-700 mb-3">
                    Перед отправкой клиенту база данных должна быть проверена на наличие задвоенных строк и других ошибок, почищена (инструмент: Google Таблицы, раздел "Данные", функция "Очистка от повторов" &gt; выбор нужного столбца. Если намерены оставить по несколько адресов для одной компании для увеличения отклика - сообщайте клиенту сразу).
                  </p>
                  <p className="text-gray-700">
                    Базы проверяет и согласовывает старший специалист - Настя, в подчате "Анна (наставник)". Тегаем Настю, присылаем базу с комментариями по сегменту: кого собирали, на какой продукт. Перед сдачей - проверяем базу самостоятельно.
                  </p>
                </div>

                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">3.2. Согласование базы с клиентом:</h4>
                  <p className="text-gray-700 mb-3">База отправляется на согласование клиенту в следующем формате:</p>
                  <div className="bg-blue-50 border-l-4 border-blue-500 p-4 rounded-r-md">
                    <p className="text-gray-700 italic leading-relaxed">
                      Имя Клиента, отправляю Вам базу по Гипотезе 1 "Название гипотезы".<br/>
                      Собрали её по следующим критериям: Например: Выручка от 50 млн., ОКВЭД 52.10.<br/><br/>
                      Жду вашего подтверждения для запуска следующего этапа.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Раздел 4 */}
            <div className="border-l-4 border-purple-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <MessageSquare className="h-5 w-5 text-purple-600" />
                4. Ежедневная коммуникация и отчетность
              </h3>
              <div className="space-y-4">
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">4.1. Ежедневный статус проекта:</h4>
                  <p className="text-gray-700 mb-3">
                    Специалист обязан ежедневно информировать клиента о статусе проекта в общем чате. Примеры сообщений:
                  </p>
                  <div className="bg-blue-50 border-l-4 border-blue-500 p-4 rounded-r-md space-y-3">
                    {[
                      '«Сегодня собираем базу по Гипотезе 2. Отправлю Вам её на согласование завтра.»',
                      '«Запустили кампанию по Гипотезе 2. Ожидаем ответы и приступаем параллельно к подготовке следующей базы и цепочке писем.»',
                      '«Сегодня от запуска по Гипотезе 2 были получены столько-то ответов, с упоминанием контактов ЛПР/запросов о подробностях/сообщениях о неактуальности. Потенциально интересных передал в таблицу, раздел "Потенциальные лиды".»'
                    ].map((msg, i) => (
                      <p key={i} className="text-gray-700 italic">"{msg}"</p>
                    ))}
                  </div>
                </div>

                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">4.2. Обязательные услуги по тарифу:</h4>
                  <p className="text-gray-700 mb-3">
                    Специалист и руководитель проекта несут ответственность за выполнение ВСЕХ услуг, упакованных в тариф клиента.
                  </p>
                  <p className="text-gray-700 mb-3">
                    Особое внимание уделить часто пропускаемым пунктам (двух- и трехмесячные тарифы, за 149к и 215к руб соответственно):
                  </p>
                  <ul className="space-y-2 ml-4">
                    {[
                      'TenChat Outreach. Запуск спустя неделю после запуска аутрич-кампаний.',
                      'Еженедельная встреча-отчёт (с расшифровками метрик, оценкой относительно ожидаемого результата, подтверждением гипотез и дальнейших шагов).',
                      'Встреча-консультация со специалистами перед запуском проекта.',
                      'KPI со второго месяца (если проект изначально заводился без гарантий). Звонок проводится по истечению месяца с первого запуска.'
                    ].map((item, i) => (
                      <li key={i} className="flex items-start gap-2 text-gray-700">
                        <CheckCircle2 className="h-4 w-4 text-green-500 mt-1 flex-shrink-0" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">4.3. Работа с обратной связью по лидам:</h4>
                  <p className="text-gray-700">
                    Еженедельно призывать клиента к заполнению форм/предоставлению ОС по лидам.
                  </p>
                </div>
              </div>
            </div>

            {/* Раздел 5 */}
            <div className="border-l-4 border-purple-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <User className="h-5 w-5 text-purple-600" />
                5. Построение отношений и контроль качества
              </h3>
              <div className="space-y-4">
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">5.1. Доверительные отношения:</h4>
                  <ul className="space-y-2 ml-4">
                    {[
                      'Выстраивать с клиентом партнерские, доверительные отношения. Делиться апдейтами, запрашивать дополнительные материалы, сообщать об ответах, откровенничать о непонимании каких-то нюансов продукта/услуги.',
                      'Проявлять внимание к деталям: исправлять опечатки в офферах, следить за дедлайнами и минимизировать их срывы.'
                    ].map((item, i) => (
                      <li key={i} className="flex items-start gap-2 text-gray-700">
                        <CheckCircle2 className="h-4 w-4 text-green-500 mt-1 flex-shrink-0" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">5.2. Объяснение логики работы:</h4>
                  <p className="text-gray-700">
                    По каждому этапу (формирование базы, создание оффера, выбор гипотез) специалист должен доступно объяснять клиенту логику своих действий, чтобы повысить его вовлеченность и понимание процесса. Это также позволит углубиться в понимание продвигаемого продукта/услуг за счет комментариев клиента.
                  </p>
                </div>
              </div>
            </div>

            {/* Раздел 6 */}
            <div className="border-l-4 border-purple-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-purple-600" />
                6. Эскалация проблем
              </h3>
              <div className="bg-red-50 border-l-4 border-red-500 rounded-lg p-4">
                <h4 className="font-semibold text-gray-700 mb-3">6.1. Реакция на негатив:</h4>
                <ul className="space-y-2 ml-4 mb-3">
                  <li className="flex items-start gap-2 text-gray-700">
                    <AlertCircle className="h-4 w-4 text-red-500 mt-1 flex-shrink-0" />
                    <span>При появлении любого недопонимания, негатива или конфликтной ситуации с клиентом, специалист/руководитель проекта в обязательном порядке обязан немедленно эскалировать вопрос к Егору (@ROP_PolzaAgency).</span>
                  </li>
                </ul>
                <p className="text-gray-700 font-medium">
                  Цель эскалации — совместно разобрать ситуацию и найти оперативное решение, не потеряв лояльность.
                </p>
              </div>
            </div>

            {/* Раздел 7 */}
            <div className="border-l-4 border-purple-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <Shield className="h-5 w-5 text-purple-600" />
                7. Обязанности руководителя, ОП и общие правила
              </h3>
              <div className="space-y-4">
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">7.1. Обязанности руководителя:</h4>
                  <p className="text-gray-700 mb-3">ОП на стартовых встречах с клиентом обязан четко проговаривать:</p>
                  <ul className="space-y-2 ml-4">
                    {[
                      'Необходимость проверить качественное заполнение брифа клиентом. В противном случае, пригласить на звонок с командой для выяснения нюансов.',
                      'Процесс передачи проекта специалисту (отписка в чат "Передача проектов" с комментариями по индивидуальным договоренностям, создание общего чата, назначение ответственного, объяснение специалисту специфики бизнеса клиента).'
                    ].map((item, i) => (
                      <li key={i} className="flex items-start gap-2 text-gray-700">
                        <CheckCircle2 className="h-4 w-4 text-green-500 mt-1 flex-shrink-0" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">7.2. Изучение записи встречи с лидом:</h4>
                  <p className="text-gray-700">
                    Просмотр записи встречи отдела продаж с клиентом (лидом) является обязательным для специалиста перед началом работы над проектом. Ссылку можно получить у лида. Это приравнивается к одному из этапов изучения брифа и значительно упрощает понимание задач и контекста.
                  </p>
                </div>
              </div>
            </div>

            {/* Важная ссылка */}
            <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border-l-4 border-blue-500 p-5 rounded-r-md">
              <div className="flex items-start gap-3">
                <FileText className="h-6 w-6 text-blue-600 flex-shrink-0 mt-1" />
                <div>
                  <p className="text-gray-900 font-semibold mb-2">
                    Ссылка на презентацию с обязательными услугами по всем проектам (обязательно к изучению!):
                  </p>
                  <a 
                    href="https://drive.google.com/file/d/1sJLI9cRuyVzT3S-yLB48JxQJUZskexBT/view?usp=sharing" 
                    target="_blank" 
                    rel="noopener noreferrer" 
                    className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-2 font-medium"
                  >
                    Презентация Polza Agency.pdf
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </div>
              </div>
            </div>

            {/* Написание цепочки */}
            <div id="napisanie-cepochki" className="border-l-4 border-purple-500 pl-6 py-2 mt-6">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <PenTool className="h-5 w-5 text-purple-600" />
                Написание цепочки
              </h3>
              <div className="space-y-4">
                {/* Ресурсы для изучения */}
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3 flex items-center gap-2">
                    <Book className="h-4 w-4 text-emerald-600" />
                    Ресурсы для изучения
                  </h4>
                  <div className="space-y-3 text-sm">
                    <p className="text-gray-700">
                      Примеры цепочек и советы по их написанию можно посмотреть здесь:
                    </p>
                    <div>
                      <p className="text-gray-700 mb-2">
                        <span className="font-semibold">Настоятельно рекомендуем</span> прочитать главу 3.3 "Текст о себе и компании" в книге:{' '}
                        <a href="https://drive.google.com/file/d/15ZJ6CUw0PlcD1oDzJaIV9cbjLGQNwOy5/view?usp=sharing" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium">
                          Пиши - Сокращай.pdf
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </p>
                    </div>
                    <div>
                      <p className="text-gray-700 mb-1">Видео мастер-класс Олеси по написанию цепочек писем:</p>
                      <a href="https://youtu.be/pLEdg-YJJn4" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium text-sm">
                        https://youtu.be/pLEdg-YJJn4
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                    <div>
                      <p className="text-gray-700 mb-1">Видео мастер-класс по написанию цепочки с помощью ChatGPT:</p>
                      <a href="https://drive.google.com/file/d/1atsZSUUulEIK_V16T68x29XzpfIeSh2f/view" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium text-sm">
                        Написание оффера в GPT.mp4
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                    <div>
                      <p className="text-gray-700 mb-1">Сервис для проверки текстов и уменьшения количества "воды":</p>
                      <a href="https://glvrd.ru/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium text-sm">
                        https://glvrd.ru/
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                    <div>
                      <p className="text-gray-700 mb-1">Как можно ещё себя проверить - пройтись по чек-листу и ответить на вопросы (2 слайд):</p>
                      <a href="https://drive.google.com/file/d/1d6_R-0uYq8VQk9iEJMbqB4kslvbed1br/view" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium text-sm">
                        Чек-лист для проверки
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </div>
                </div>

                {/* Основные принципы */}
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3 flex items-center gap-2">
                    <CheckSquare className="h-4 w-4 text-emerald-600" />
                    Основные принципы
                  </h4>
                  <div className="space-y-3 text-sm">
                    <p className="text-gray-700">
                      Цепочка в основном состоит из <span className="font-semibold">4-х – 6-ти писем</span> и одного шаблонного ответного письма. 
                      <span className="font-semibold text-emerald-700"> Важно!</span> Писать лучше более простым и разговорным языком.
                    </p>
                    <div>
                      <p className="text-gray-700 font-semibold mb-2">Главная цель аутрича заключается в том, чтобы:</p>
                      <ul className="space-y-1 ml-4">
                        {[
                          'письмо в организации прочитал тот человек, который заинтересован в ваших услугах или товарах;',
                          'вы должны обойти «дворецких»: hr\'ов, ассистентов, офис-менеджеров;',
                          'письмо должно вызвать интерес и желание пообщаться с вами.'
                        ].map((item, i) => (
                          <li key={i} className="flex items-start gap-2 text-gray-700">
                            <CheckCircle2 className="h-3 w-3 text-emerald-500 mt-1 flex-shrink-0" />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p className="text-gray-700 font-semibold mb-2">Триггеры, которые лучше всего работают:</p>
                      <div className="flex flex-wrap gap-2">
                        {['любопытство', 'искренность', 'польза', 'выгода', 'кейсы', 'подарок'].map((trigger, i) => (
                          <span key={i} className="px-2 py-1 bg-emerald-100 text-emerald-700 rounded text-xs font-medium">
                            {trigger}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* A/B тестирование */}
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-2 flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-blue-600" />
                    A/B тестирование
                  </h4>
                  <p className="text-gray-700 text-sm">
                    Для тестирования гипотез можно использовать <span className="font-semibold">А/Б тест</span>, прописать несколько разных писем и в настройках рассылки открутить сначала пару дней один вариант, а затем второй и посмотреть статистику.
                  </p>
                </div>

                {/* Пример блок-схемы */}
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3 flex items-center gap-2">
                    <ImageIcon className="h-4 w-4 text-emerald-600" />
                    Пример блок-схемы цепочки писем
                  </h4>
                  <p className="text-gray-700 mb-3 text-sm">
                    Ниже приведен пример как на блок схеме может выглядеть цепочка писем:
                  </p>
                  <div className="border border-gray-300 rounded-lg overflow-hidden bg-white">
                    <img 
                      src="/images/email-chain-diagram.png"
                      alt="Блок-схема цепочки писем"
                      className="w-full h-auto"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Структура письма и работа с ЦА */}
        <section id="struktura-pisma" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-teal-600 rounded-lg">
              <Mail className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Структура письма и работа с ЦА</h2>
          </div>

          <div className="space-y-6">
            {/* 1. Определение целевой аудитории */}
            <div className="border-l-4 border-teal-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <Users className="h-5 w-5 text-teal-600" />
                1. Определение целевой аудитории
              </h3>
              <div className="space-y-4">
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-gray-700 mb-3">
                    Для начала нужно понять кто наша ЦА и до кого конкретно мы хотим донести свое предложение. На масштабе в тысячи компаний у нас не будет возможности адаптировать письмо под каждого клиента, поэтому база, по которой мы пишем письма, должна быть однородной и понятной для нас. Гипотезы и ЦА, которые мы тестируем, должны быть конкретными. Мы должны понимать потребности и боли пользователей.
                  </p>
                </div>

                <div className="bg-blue-50 border-l-4 border-blue-500 rounded-lg p-4">
                  <p className="text-gray-700 font-semibold mb-2">Критерий однородности базы:</p>
                  <p className="text-gray-700 mb-3">
                    В начале письма по своей базе мы должны объяснить клиенту, почему решили написать именно в его компанию. Например:
                  </p>
                  <ul className="space-y-2 ml-4">
                    <li className="flex items-start gap-2 text-gray-700">
                      <CheckCircle2 className="h-4 w-4 text-blue-500 mt-1 flex-shrink-0" />
                      <span>«Видел, что вы ищите С-level специалиста…»</span>
                    </li>
                    <li className="flex items-start gap-2 text-gray-700">
                      <CheckCircle2 className="h-4 w-4 text-blue-500 mt-1 flex-shrink-0" />
                      <span>«Видел, что ваша выручка за 2022 год выросла на 20%…»</span>
                    </li>
                  </ul>
                  <p className="text-gray-700 mt-3">
                    <span className="font-semibold">Важно:</span> Если написать такое интро не получается, база сильно разношерстная, гипотезы надо переупаковывать.
                  </p>
                </div>

                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-gray-700">
                    Мы должны иметь четкий оффер и план, четкое понимание того, что и как хотите продать. Или должны иметь набор гипотез/офферов/планов, чтобы их осознанно протестировать.
                  </p>
                </div>
              </div>
            </div>

            {/* 2. Что можно добавить в письмо */}
            <div className="border-l-4 border-teal-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <FileText className="h-5 w-5 text-teal-600" />
                2. Что можно добавить в письмо?
              </h3>
              <div className="bg-gray-50 rounded-lg p-4">
                <p className="text-gray-700 mb-3">
                  Для того, чтобы информация в письме была наиболее полезной можно воспользоваться <span className="font-semibold">social proof'ами</span> из готового списка.
                </p>
                <p className="text-gray-700 font-semibold mb-2">Также можно использовать:</p>
                <ul className="space-y-2 ml-4">
                  {[
                    'картинки (товаров, отзывов и т.п.)',
                    'видео',
                    'ссылки на аудио (мы добавляли ссылку на soundcloud с аудиозаписью нашей работы с клиентом)',
                    'ссылки на статьи',
                    'ссылки на ваши контакты (сайт, телефон, телеграм, вотсапп)',
                    'ссылки на кейсы (из похожей или такой же сферы)'
                  ].map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-gray-700">
                      <CheckCircle2 className="h-4 w-4 text-teal-500 mt-1 flex-shrink-0" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* 3. Структура письма */}
            <div className="border-l-4 border-teal-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <Mail className="h-5 w-5 text-teal-600" />
                3. Структура письма
              </h3>
              <div className="space-y-4">
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-gray-700 mb-3">
                    Первым делом идет <span className="font-semibold">"открывашка"</span> или же <span className="font-semibold">краткий запрос</span>. В нем мы задаем уточняющий вопрос основываясь на ЦА так, чтобы этот вопрос был актуальным. Это вынуждает пользователя ответить нам.
                  </p>
                </div>

                <div className="bg-white rounded-lg p-4 border border-gray-300">
                  <h4 className="font-semibold text-gray-700 mb-3">Пример открывашки:</h4>
                  <div className="border border-gray-300 rounded-lg overflow-hidden bg-white">
                    <img 
                      src="/images/email-opener-example.png"
                      alt="Пример открывашки письма"
                      className="w-full h-auto"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Варианты первого письма */}
        <section id="varianty-pervogo" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-cyan-600 rounded-lg">
              <Mail className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Варианты первого письма</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-blue-50 border-l-4 border-blue-500 rounded-lg p-4">
              <p className="text-gray-700">
                <span className="font-semibold">Пример для рассылки в компании, которые искали себе маркетолога в штат.</span> Тут мы конкретно обращаемся с заинтересованным для них предложением.
              </p>
            </div>

            {/* Варианты из текста */}
            <div className="space-y-4">
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-3">Вариант 1</h3>
                <div className="bg-white rounded p-3 text-sm text-gray-700 leading-relaxed">
                  <p>Я пытаюсь связаться с вашим специалистом по обработке и защите персональных данных «{'{'}{'{'}companyName{'}'}{'}'}», но кажется, что мне передали неправильный контакт.</p>
                  <p className="mt-2">Обычно, HR знают всех в компании и, надеюсь, вы сможете мне помочь.</p>
                  <p className="mt-2">Я хочу предложить попробовать наше новое решение по управлению реестром персональных данных (и помочь сэкономить кучу рабочего времени для других задач).</p>
                  <p className="mt-2">Буду очень благодарен, если перешлете это сообщение ответственному лицу или передадите мне его у, чтобы я мог с ним связаться.</p>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-3">Вариант 2</h3>
                <div className="bg-white rounded p-3 text-sm text-gray-700 leading-relaxed">
                  <p>Здравствуйте.</p>
                  <p className="mt-2">Я пытаюсь связаться с вашим специалистом по ... в «{'{'}{'{'}companyName{'}'}{'}'}», но кажется, что мне передали неправильный контакт.</p>
                  <p className="mt-2">Обычно, HR знают всех в компании и, надеюсь, вы сможете мне помочь.</p>
                  <p className="mt-2">Буду очень благодарен, если перешлете это сообщение ответственному лицу или передадите мне его у, чтобы я мог с ним связаться.</p>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-3">Вариант 3</h3>
                <div className="bg-white rounded p-3 text-sm text-gray-700 leading-relaxed">
                  <p>Здравствуйте!</p>
                  <p className="mt-2">Подскажите, пожалуйста, как могу связаться с ... в «{'{'}{'{'}companyName{'}'}{'}'}»?</p>
                  <p className="mt-2">Хочу показать/рассказать, как (пример: наше решение) может помочь (пример: эффективно закрыть задачу оптимизации отпусков).</p>
                  <p className="mt-2">Буду благодарен, если передадите мой контакт или перешлете данное письмо ответственному лицу.</p>
                  <p className="mt-2">Надеюсь на скорый ответ.</p>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-3">Вариант 4</h3>
                <div className="bg-white rounded p-3 text-sm text-gray-700 leading-relaxed">
                  <p>Добрый день! Возможно вы мне сможете помочь.</p>
                  <p className="mt-2">Подскажите, с кем можно связаться по вопросу….?</p>
                  <p className="mt-2">Буду благодарен, если сообщите емейл ответственного лица. Либо будет замечательно если он сам напишет мне в ответ на это письмо.</p>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-3">Вариант 5</h3>
                <div className="bg-white rounded p-3 text-sm text-gray-700 leading-relaxed">
                  <p>Здравствуйте,</p>
                  <p className="mt-2">Могли бы вы помочь мне с контактной информацией? Я хочу связаться со специалистом, который отвечает за ... в «{'{'}{'{'}companyName{'}'}{'}'}».</p>
                  <p className="mt-2">Буду благодарен за любую помощь.</p>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-3">Вариант 6</h3>
                <div className="bg-white rounded p-3 text-sm text-gray-700 leading-relaxed">
                  <p>Добрый день,</p>
                  <p className="mt-2">У меня есть информация о ... для «{'{'}{'{'}companyName{'}'}{'}'}». Могли бы вы связать меня с сотрудником, отвечающим за этот процесс?</p>
                  <p className="mt-2">Заранее спасибо за помощь.</p>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-3">Вариант 7</h3>
                <div className="bg-white rounded p-3 text-sm text-gray-700 leading-relaxed">
                  <p>Добрый день,</p>
                  <p className="mt-2">Я ищу контактные данные сотрудника, с которым могу пообщаться по поводу ... в «{'{'}{'{'}companyName{'}'}{'}'}». Буду признателен, если отправите мне его у.</p>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-3">Вариант 8</h3>
                <div className="bg-white rounded p-3 text-sm text-gray-700 leading-relaxed">
                  <p>Добрый день,</p>
                  <p className="mt-2">С кем я могу пообщаться на счет ... в «{'{'}{'{'}companyName{'}'}{'}'}»? Возможно, у вас есть а этого специалиста?</p>
                  <p className="mt-2">Заранее спасибо за информацию.</p>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-3">Вариант 9 (с темой: ошибки в маркетинговой стратегии)</h3>
                <div className="bg-white rounded p-3 text-sm text-gray-700 leading-relaxed">
                  <p className="font-semibold">Тема письма: ошибки в маркетинговой стратегии</p>
                  <p className="mt-2">Здравствуйте!</p>
                  <p className="mt-2">В ходе анализа вашей последней кампании мы обнаружили несколько ключевых моментов, которые могут значительно повысить ее эффективность. Я бы хотел обсудить их с вашим специалистом по маркетингу. Не могли бы вы уточнить контактные данные соответствующего сотрудника?</p>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-3">Вариант 10 (с темой: маркетинговое исследование)</h3>
                <div className="bg-white rounded p-3 text-sm text-gray-700 leading-relaxed">
                  <p className="font-semibold">Тема письма: маркетинговое исследование</p>
                  <p className="mt-2">Добрый день!</p>
                  <p className="mt-2">Моя компания, [Название вашей компании], проводит исследование в сфере маркетинга, которое будет интересно вашей команде. Мы бы хотели включить вашу компанию в список участников. Кто в вашей компании отвечает за такие инициативы?</p>
                  <p className="mt-2">Благодарю за сотрудничество</p>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-3">Вариант 11</h3>
                <div className="bg-white rounded p-3 text-sm text-gray-700 leading-relaxed">
                  <p>Добрый день!</p>
                  <p className="mt-2">Можете подсказать, к кому лучше обратиться по вопросу ...? Буду признателен за контакт ответственного лица или за пересылку моего запроса ему.</p>
                  <p className="mt-2">Спасибо заранее!</p>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-3">Вариант 12</h3>
                <div className="bg-white rounded p-3 text-sm text-gray-700 leading-relaxed">
                  <p>Здравствуйте!</p>
                  <p className="mt-2">Я пытаюсь связаться с вашим специалистом по ... в «{'{'}{'{'}companyName{'}'}{'}'}». Обычно этим занимается руководитель ... отдела/департамента.</p>
                  <p className="mt-2">Я хочу предложить попробовать наше решение по ..., чтобы помочь ... (пример: сэкономить кучу рабочего времени для других задач).</p>
                  <p className="mt-2">Буду очень благодарен, если перешлете это сообщение ответственному лицу или передадите мне его у, чтобы я мог с ним связаться.</p>
                  <p className="mt-2">Надеюсь на скорый ответ.</p>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-3">Вариант 13 (судебное дело)</h3>
                <div className="bg-white rounded p-3 text-sm text-gray-700 leading-relaxed">
                  <p className="font-semibold">Тема: Запрос по поводу суда «{'{'}{'{'}companyName{'}'}{'}'}» с «{'{'}{'{'}Istec{'}'}{'}'}»</p>
                  <p className="mt-2">Добрый день!</p>
                  <p className="mt-2">Мне необходимо проинформировать руководителя компании «{'{'}{'{'}companyName{'}'}{'}'}» о подаче к ней иска на сумму {'{'}{'{'}Summa{'}'}{'}'}. {'{'}{'{'}Name{'}'}{'}'} должен знать, что судебное дело {'{'}{'{'}Nomer{'}'}{'}'} инициировано компанией {'{'}{'{'}Istec{'}'}{'}'}.</p>
                  <p className="mt-2">Вам сейчас может понадобиться консультация юристов.</p>
                  <p className="mt-2">Пожалуйста, дайте адрес электронной ы руководителя и номер телефона, чтобы я мог направить пакет документов и проконсультировать.</p>
                  <p className="mt-2">Надеюсь на скорый ответ</p>
                  <p className="mt-2">С уважением,</p>
                  <p>Дм</p>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-3">Вариант 14</h3>
                <div className="bg-white rounded p-3 text-sm text-gray-700 leading-relaxed">
                  <p>Добрый день!</p>
                  <p className="mt-2">Зашел на сайт {'{'}{'{'}companyName{'}'}{'}'}, хотел написать вашему маркетологу или руководителю отдела продаж, но не нашел их контактов.</p>
                  <p className="mt-2">Можете пожалуйста прислать email адреса этих специалистов ответным письмом?</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Второе письмо - основной оффер */}
        <section id="vtoroe-pismo" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-orange-600 rounded-lg">
              <Mail className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Второе письмо - основной оффер</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-blue-50 border-l-4 border-blue-500 rounded-lg p-4">
              <p className="text-gray-700">
                Вторым письмом идет <span className="font-semibold">основной оффер</span>, который включает в себя <span className="font-semibold">social proof'ы</span> и все, что находится во втором пункте (картинки, видео, ссылки на аудио, статьи, контакты, кейсы).
              </p>
            </div>

            {/* Структура второго письма */}
            <div className="border-l-4 border-orange-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <FileText className="h-5 w-5 text-orange-600" />
                Структура второго письма
              </h3>
              <div className="space-y-4">
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">1. Вступление</h4>
                  <p className="text-gray-700">
                    Сначала мы указываем на то, что мы недавно писали ему, но не получили ответ и уже от этого выстраиваем структуру вступления.
                  </p>
                </div>

                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">2. Основная часть</h4>
                  <p className="text-gray-700 mb-3">Затем мы можем расписать про:</p>
                  <ul className="space-y-2 ml-4">
                    {[
                      'Нашу компанию и кто мы такие;',
                      'Потребности, боли, желания аудитории;',
                      'Свойства продукта, услуги, его преимущество;'
                    ].map((item, i) => (
                      <li key={i} className="flex items-start gap-2 text-gray-700">
                        <CheckCircle2 className="h-4 w-4 text-orange-500 mt-1 flex-shrink-0" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">3. Призыв к действию</h4>
                  <p className="text-gray-700">
                    В конце выводим человека на контакт и предоставляем разные варианты связи с нами.
                  </p>
                </div>
              </div>
            </div>

            {/* Примеры второго письма */}
            <div className="border-l-4 border-orange-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <ImageIcon className="h-5 w-5 text-orange-600" />
                Примеры второго письма
              </h3>
              <div className="space-y-4">
                <div className="bg-white rounded-lg p-4 border border-gray-300">
                  <div className="border border-gray-300 rounded-lg overflow-hidden bg-white">
                    <img 
                      src="/images/second-email-example-1.png"
                      alt="Пример второго письма - основная часть"
                      className="w-full h-auto"
                    />
                  </div>
                </div>
                <div className="bg-white rounded-lg p-4 border border-gray-300">
                  <div className="border border-gray-300 rounded-lg overflow-hidden bg-white">
                    <img 
                      src="/images/second-email-example-2.png"
                      alt="Пример второго письма - контакты и призыв к действию"
                      className="w-full h-auto"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Третье письмо */}
        <section id="trete-pismo" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-amber-600 rounded-lg">
              <Mail className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Третье письмо</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-gray-700">
                Третьим письмом мы можем подробнее рассказать про то, <span className="font-semibold">как именно мы работаем</span>, какие инструменты используем, что входит в наши обязанности и в конце вывести человека на контакт.
              </p>
            </div>

            {/* Учет открытия письма */}
            <div className="border-l-4 border-amber-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-amber-600" />
                Учет открытия письма
              </h3>
              <div className="space-y-4">
                <div className="bg-green-50 border-l-4 border-green-500 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-2">Если он открыл и не ответил:</h4>
                  <p className="text-gray-700">
                    Возможно ему не хватило информации в прошлом письме, значит нужно постараться добавить в это сообщение <span className="font-semibold">больше подробностей и новой информации</span>.
                  </p>
                </div>

                <div className="bg-blue-50 border-l-4 border-blue-500 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-2">Если же он его не открывал:</h4>
                  <p className="text-gray-700">
                    Не боимся повторяться и использовать <span className="font-semibold">ключевые моменты из нашего прошлого письма</span>, добавляем к ним свежую информацию.
                  </p>
                </div>
              </div>
            </div>

            {/* Структура третьего письма */}
            <div className="border-l-4 border-amber-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <FileText className="h-5 w-5 text-amber-600" />
                Структура третьего письма
              </h3>
              <div className="bg-gray-50 rounded-lg p-4">
                <p className="text-gray-700">
                  В целом структура похожа на предыдущее письмо. Можем рассказать про:
                </p>
                <ul className="space-y-2 ml-4 mt-3">
                  {[
                    'Как именно мы работаем',
                    'Какие инструменты используем',
                    'Что входит в наши обязанности',
                    'Дополнительные детали и преимущества'
                  ].map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-gray-700">
                      <CheckCircle2 className="h-4 w-4 text-amber-500 mt-1 flex-shrink-0" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-gray-700 mt-3">
                  В конце выводим человека на контакт с призывом к действию.
                </p>
              </div>
            </div>

            {/* Пример третьего письма */}
            <div className="border-l-4 border-amber-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <ImageIcon className="h-5 w-5 text-amber-600" />
                Пример третьего письма
              </h3>
              <div className="bg-white rounded-lg p-4 border border-gray-300">
                <p className="text-gray-700 mb-4">
                  Ниже приведен пример такого письма:
                </p>
                <div className="border border-gray-300 rounded-lg overflow-hidden bg-white">
                  <img 
                    src="/images/third-email-example.png"
                    alt="Пример третьего письма"
                    className="w-full h-auto"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Четвертое письмо - FOMO */}
        <section id="chetvertoe-pismo" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-red-600 rounded-lg">
              <Mail className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Четвертое письмо - FOMO</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-red-50 border-l-4 border-red-500 rounded-lg p-4">
              <p className="text-gray-700">
                Четвертое письмо должно содержать в себе информацию о том, что это <span className="font-semibold">последнее наше сообщение и предложение (FOMO)</span>.
              </p>
            </div>

            {/* Структура четвертого письма */}
            <div className="border-l-4 border-red-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <FileText className="h-5 w-5 text-red-600" />
                Структура четвертого письма
              </h3>
              <div className="space-y-4">
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">1. FOMO - сообщение о последнем письме</h4>
                  <p className="text-gray-700">
                    Первым делом мы сообщаем ему об этом - что это последнее наше сообщение.
                  </p>
                </div>

                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">2. Краткое резюме предыдущих писем</h4>
                  <p className="text-gray-700">
                    Затем в общих чертах пишем о том, что мы писали ему до этого и с какой целью обращались.
                  </p>
                </div>

                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">3. Уникальные торговые предложения (УТП)</h4>
                  <p className="text-gray-700">
                    Добавляем пару УТП - ключевые преимущества и выгоды нашего предложения.
                  </p>
                </div>

                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">4. Призыв к контакту</h4>
                  <p className="text-gray-700">
                    В конце опять же выводим его на контакт с четким призывом к действию и вариантами связи.
                  </p>
                </div>
              </div>
            </div>

            {/* Пример четвертого письма */}
            <div className="border-l-4 border-red-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <ImageIcon className="h-5 w-5 text-red-600" />
                Пример четвертого письма
              </h3>
              <div className="bg-white rounded-lg p-4 border border-gray-300">
                <p className="text-gray-700 mb-4">
                  Ниже приведен пример такого письма:
                </p>
                <div className="border border-gray-300 rounded-lg overflow-hidden bg-white">
                  <img 
                    src="/images/fourth-email-example.png"
                    alt="Пример четвертого письма с FOMO"
                    className="w-full h-auto"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Шаблонное письмо */}
        <section className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-violet-600 rounded-lg">
              <Mail className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Шаблонное письмо</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-violet-50 border-l-4 border-violet-500 rounded-lg p-4">
              <p className="text-gray-700">
                Шаблонное письмо это по сути то же самое, что и <span className="font-semibold">второе сообщение</span> из нашей цепочки, рассказывающее о всех преимуществах, но отправляется оно в том случае, если <span className="font-semibold">пользователь ответил нам на сообщение из рассылки с каким-то уточняющим вопросом</span>.
              </p>
            </div>

            {/* Пример шаблонного письма */}
            <div className="border-l-4 border-violet-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <ImageIcon className="h-5 w-5 text-violet-600" />
                Пример шаблонного письма
              </h3>
              <div className="bg-white rounded-lg p-4 border border-gray-300">
                <p className="text-gray-700 mb-4">
                  Ниже приведен пример такого письма:
                </p>
                <div className="border border-gray-300 rounded-lg overflow-hidden bg-white">
                  <img 
                    src="/images/template-email-example.png"
                    alt="Пример шаблонного письма"
                    className="w-full h-auto"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Вариант цепочки из 6 писем - сторителлинг о команде */}
        <section id="variant-6-pisem" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-indigo-600 rounded-lg">
              <Users className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Вариант цепочки из 6 писем</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-indigo-50 border-l-4 border-indigo-500 rounded-lg p-4">
              <p className="text-gray-700">
                Если писать цепочку из <span className="font-semibold">6-ти писем</span>, то четвертое письмо (закрывашка с FOMO) уйдет в конец, а вместо него можно <span className="font-semibold">рассказать про команду, сделать небольшой сторителлинг</span>.
              </p>
            </div>

            {/* Пример письма о команде */}
            <div className="border-l-4 border-indigo-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <ImageIcon className="h-5 w-5 text-indigo-600" />
                Пример письма о команде (сторителлинг)
              </h3>
              <div className="bg-white rounded-lg p-4 border border-gray-300">
                <p className="text-gray-700 mb-4">
                  Ниже приведен пример такого письма:
                </p>
                <div className="border border-gray-300 rounded-lg overflow-hidden bg-white">
                  <img 
                    src="/images/team-storytelling-email.png"
                    alt="Пример письма о команде со сторителлингом"
                    className="w-full h-auto"
                  />
                </div>
              </div>
            </div>

          </div>
        </section>

        {/* Пятое письмо - кейс */}
        <section id="pyatoe-pismo" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-emerald-600 rounded-lg">
              <Mail className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Пятое письмо</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-gray-700">
                Пятым письмом можно <span className="font-semibold">расписать подробнее про кейс</span>, который наиболее релевантен для аудитории рассылки.
              </p>
            </div>

            {/* Пример пятого письма */}
            <div className="border-l-4 border-emerald-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <ImageIcon className="h-5 w-5 text-emerald-600" />
                Пример пятого письма
              </h3>
              <div className="bg-white rounded-lg p-4 border border-gray-300">
                <p className="text-gray-700 mb-4">
                  Ниже приведен пример такого письма:
                </p>
                <div className="border border-gray-300 rounded-lg overflow-hidden bg-white">
                  <img 
                    src="/images/fifth-email-case-study.png"
                    alt="Пример пятого письма с кейсом"
                    className="w-full h-auto"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Проверка офферов через Главред */}
        <section id="proverka-glavred" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-slate-600 rounded-lg">
              <FileText className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">4. Проверка офферов через Главред</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-gray-700 mb-3">
                При помощи сервиса Главред (<a href="https://glvrd.ru/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium">
                  https://glvrd.ru/
                  <ExternalLink className="h-3 w-3" />
                </a>) можно оценить и улучшить свой текст, упростить его, добавить конкретики, избавиться от штампов и т.п.. Так вы по другому посмотрите на текст, поймёте, какие ошибки возникают при написании, и будете учитывать все эти моменты в последующих цепочках.
              </p>
              <p className="text-gray-700">
                Он не просто отмечает ошибки, но и сразу указывает на правила, которые помогают избегать их (+к этому прикрепляются ссылки на статьи, в которых более подробно разбирается та или иная тема, чтобы закрепить материал):
              </p>
            </div>

            {/* Пример проверки через Главред */}
            <div className="border-l-4 border-slate-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <ImageIcon className="h-5 w-5 text-slate-600" />
                Пример проверки через Главред
              </h3>
              <div className="bg-white rounded-lg p-4 border border-gray-300">
                <div className="border border-gray-300 rounded-lg overflow-hidden bg-white">
                  <img 
                    src="/images/glavred-check-example.png"
                    alt="Пример проверки текста через сервис Главред"
                    className="w-full h-auto"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Письма на иностранном языке */}
        <section className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-rose-600 rounded-lg">
              <Globe className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">5. Письма на иностранном языке</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-gray-700 mb-4">
                Если необходимо написать цепочку писем на иностранном языке, алгоритм действий следующий:
              </p>
              <ol className="space-y-3 ml-4">
                <li className="flex items-start gap-3 text-gray-700">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center text-sm font-semibold mt-0.5">
                    1
                  </span>
                  <span>
                    Берем уже написанную цепочку из писем на русском и переводим в переводчике (
                    <a href="https://www.deepl.com/ru/translator" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium">
                      https://www.deepl.com/ru/translator
                      <ExternalLink className="h-3 w-3" />
                    </a>), либо в самом GPT по промпту: <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">"Translate this text without changing the meaning or changing its structure into English in a slightly more conversational style similar to human speech: [text]"</span>;
                  </span>
                </li>
                <li className="flex items-start gap-3 text-gray-700">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center text-sm font-semibold mt-0.5">
                    2
                  </span>
                  <span>
                    Итог из переводчика или GPT закидываем еще раз чату GPT с запросом <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">"proofread the text below: наш текст из переводчика"</span>;
                  </span>
                </li>
                <li className="flex items-start gap-3 text-gray-700">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center text-sm font-semibold mt-0.5">
                    3
                  </span>
                  <span>
                    То что получили в чате GPT прогоняем через грамматику (
                    <a href="https://quillbot.com/grammar-check" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium">
                      https://quillbot.com/grammar-check
                      <ExternalLink className="h-3 w-3" />
                    </a>).
                  </span>
                </li>
              </ol>
            </div>
          </div>
        </section>

        {/* Как можно упростить работу */}
        <section id="uproshchenie-raboty" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-cyan-600 rounded-lg">
              <MessageSquare className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">6. Как можно упростить работу?</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-gray-700 mb-4">
                Для упрощения работы можно использовать Chat GPT. Например, его можно попросить определить сегмент аудитории, определить их потребности и боли. Он также может навести на мысли какие УТП мы забыли упомянуть.
              </p>
              <p className="text-gray-700 mb-4">
                Чтобы это сделать необходимо прописать ему в запросе информацию про ваш бизнес, написать какие-то ключевые моменты и детали, а после попросить его сформулировать то, что нужно.
              </p>
              <p className="text-gray-700 mb-4">
                Также, если ничего не приходит в голову и нет идей, как все связать в иностранном оффере, то можно написать данный промпт:
              </p>
              <div className="bg-gray-100 rounded-lg p-4 border border-gray-300 mb-4">
                <code className="text-sm text-gray-800 whitespace-pre-wrap">
                  "Now I'm going to send you information about my company in parts, your job is to remember all of this information from each of my messages and after each message you receive, write: "I've remembered". Do you understand? If so, then write, "Let's get started.""
                </code>
              </div>
              <p className="text-gray-700 mb-4">
                После этого следующим запросом отправляем всю информацию о нашей компании клиента в первом лице. Если информации слишком много, то пишем уже следующим сообщением такой промпт:
              </p>
              <div className="bg-gray-100 rounded-lg p-4 border border-gray-300 mb-4">
                <code className="text-sm text-gray-800 whitespace-pre-wrap">
                  "Continued information about my company. Your job is to remember it like my past messages. All you have to do is write back, "I remember.": [text about company]"
                </code>
              </div>
              <p className="text-gray-700 mb-4">
                После чего в конец этого же промпта добавляем продолжение информации по нашей компании. Все последующие разы начинаем с этого же промпта!
              </p>
              <p className="text-gray-700 mb-4">
                Как только мы передали всю основную информацию по компании или нашему предложению, пишем такой промпт и получаем готовые аутрич письма, из которых можно брать какие-то блоки и части. Это может натолкнуть на идеи о чем писать. Промпт:
              </p>
              <div className="bg-gray-100 rounded-lg p-4 border border-gray-300 mb-4">
                <code className="text-sm text-gray-800 whitespace-pre-wrap">
                  "Write a short chain of 3 different emails about [вид деятельности, название компании] with the most important information, with different topics and no more than 150 words long for Cold Email Outreach, based on the information above, write in a more conversational style similar to human communication, in English. Try to write more naturally so it's more personalized and doesn't feel like spam. You can use abbreviations and emoticons, but don't use emoticons too often or too much. Try to have more simple and complex words in your text. Very important, our line of business is [посыл оффера / направление деятельности]. Our target audience: [описание нашей ЦА в деталях]. Put an emphasis on just that."
                </code>
              </div>
              <div className="bg-blue-50 border-l-4 border-blue-500 rounded-lg p-4">
                <p className="text-gray-700">
                  После этого GPT будет знать всю инфу о нашей компании, поэтому ему можно будет задавать любые вопросы, например: "какая у нас ЦА" и т.п., на которые он теперь более точно даст ответ.
                </p>
              </div>
            </div>

            {/* ТГ бот для написания цепочек */}
            <div id="tg-bot" className="border-l-4 border-cyan-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <MessageSquare className="h-5 w-5 text-cyan-600" />
                6.1 (НОВИНКА) ТГ бот для написания цепочек, оффера
              </h3>
              <div className="space-y-4">
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-gray-700 mb-3">
                    Мы разработали собственного бота, который по ссылке на бриф (упрощённый) собирает дополнительную информацию о ЦА, болях и конкурентов клиента. И на основе этой информации наш бот и пишет цепочки, которые могут послужить хорошей основой или идейным наполнением к вашему офферу.
                  </p>
                  <p className="text-gray-700 mb-3">
                    Ссылка на ТГ бота - <span className="font-semibold">@polzaaiagent_bot</span>
                  </p>
                  <div className="bg-amber-50 border-l-4 border-amber-400 rounded-lg p-4 mt-4">
                    <p className="text-gray-700 font-semibold mb-2">Как использовать? - ПРОЧИТАЙТЕ ПОЛНОСТЬЮ</p>
                    <ol className="space-y-3 ml-4">
                      <li className="flex items-start gap-3 text-gray-700">
                        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-sm font-semibold mt-0.5">
                          1
                        </span>
                        <span>
                          Составить упрощенный бриф с только основной информацией о проекте. Т.е вам нужно вынести в отдельный документ основной текст брифа, обязательно в вашем брифе должна быть ссылка на сайт клиента и фигурировать название. Вот пример того как должен выглядеть бриф для нейросети -{' '}
                          <a href="https://docs.google.com/document/d/1UiqDFc7P0uKZxFaVFotMqKAokKbyY5QOhSyqDrUL6LQ/edit?usp=sharing" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium">
                            ОПИСАНИЕ КОМПАНИИ
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </span>
                      </li>
                      <li className="flex items-start gap-3 text-gray-700">
                        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-sm font-semibold mt-0.5">
                          2
                        </span>
                        <span>
                          После того, как вы перенесли бриф, скопируйте ссылку на него (не забудьте открыть доступ). И эту ссылку вставьте в бота. <span className="font-semibold">ОБЯЗАТЕЛЬНО - вставляйте просто ссылку БЕЗ дополнительного текста.</span>
                        </span>
                      </li>
                      <li className="flex items-start gap-3 text-gray-700">
                        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-sm font-semibold mt-0.5">
                          3
                        </span>
                        <span>
                          Подождите 5-15 минут, когда бот будет собирать информацию из интернета и обрабатывать бриф. В процессе работы бот должен прислать результаты работы:
                        </span>
                      </li>
                      <li className="flex items-start gap-3 text-gray-700">
                        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-sm font-semibold mt-0.5">
                          4
                        </span>
                        <div className="flex-1">
                          <p className="text-gray-700 mb-3">
                            Как только бот получит всю информацию, он отправит вас ссылку на всю дополнительную информацию, которую он собрал
                          </p>
                          <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                            <img 
                              src="/images/tg-bot-results-example.png"
                              alt="Пример результатов работы ТГ бота"
                              className="w-full h-auto"
                            />
                          </div>
                          <p className="text-gray-700 mb-3">
                            Информация загружена, нейросеть просканировала информацию из интернета и обработала её. Можно приступать к написанию писем.
                          </p>
                          <p className="text-gray-700 mb-3">
                            Дополнительная информация записана в этом документе{' '}
                            <a href="https://docs.google.com/document/d/1Lg5f8_bA6GEYqPF7mzk8teFdq_SqjTd3nQqW1A0jrAg/edit?usp=sharing" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium">
                              https://docs.google.com/document/d/1Lg5f8_bA6GEYqPF7mzk8teFdq_SqjTd3nQqW1A0jrAg/edit?usp=sharing
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </p>
                          <div className="bg-red-50 border-l-4 border-red-400 rounded-lg p-3">
                            <p className="text-gray-700 text-sm">
                              <span className="font-semibold">(ЕСЛИ БОТ ГДЕ-ТО НАКОСЯЧИЛ В ЭТОМ ДОКУМЕНТЕ ВЫ САМОСТОЯТЕЛЬНО ПОПРАВИТЬ ИНФОРМАЦИЮ)</span>
                            </p>
                          </div>
                        </div>
                      </li>
                      <li className="flex items-start gap-3 text-gray-700">
                        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-sm font-semibold mt-0.5">
                          5
                        </span>
                        <div className="flex-1">
                          <p className="text-gray-700 mb-3">
                            После того, как бот обработал всю информацию можно переходить к написанию писем.
                          </p>
                          <p className="text-gray-700 mb-3">
                            Бот пишет только по одному письму за раз по вашему запросу. Т.е если вы хотите чтобы бот написал первое письмо, то напишите "Напиши первое письмо"
                          </p>
                          <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                            <img 
                              src="/images/tg-bot-first-email.png"
                              alt="Пример запроса первого письма боту"
                              className="w-full h-auto"
                            />
                          </div>
                          <p className="text-gray-700 mb-3">
                            Если вы хотите сгенерировать письмо по другому, то напишите о своем желании поменять письмо, НО ГЛАВНОЕ даже при повторном запросе уточните какое письмо вы хотите редактировать.
                          </p>
                          <div className="border border-gray-300 rounded-lg overflow-hidden bg-white w-1/2">
                            <img 
                              src="/images/tg-bot-edit-email.png"
                              alt="Пример редактирования письма ботом"
                              className="w-full h-auto"
                            />
                          </div>
                        </div>
                      </li>
                      <li className="flex items-start gap-3 text-gray-700">
                        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-sm font-semibold mt-0.5">
                          7
                        </span>
                        <div className="flex-1">
                          <p className="text-gray-700 font-semibold mb-3">КАКИЕ МОГУТ БЫТЬ ПРОБЛЕМЫ</p>
                          <p className="text-gray-700 mb-3">
                            Параллельное использование бота не является возможным - юзеры будут мешать друг другу. Это происходит из-за того, что бот загружает информацию о брифах в один гугл документ, на который потом опирается при генерации писем. Так что просьба писать в общий чат при намерении генерации письма
                          </p>
                        </div>
                      </li>
                    </ol>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Персонализация */}
        <section id="personalizaciya" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-pink-600 rounded-lg">
              <User className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">7. Персонализация</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-gray-700 mb-4">
                Персонализация отличная тема повышающая реплай в разы. Существует несколько вариантов персонализации, которые стоит использовать:
              </p>
              <ul className="space-y-2 ml-4 mb-4">
                <li className="flex items-start gap-2 text-gray-700">
                  <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">{"{{companyName}}"}</span>
                  <span> - для обращения по названию компании;</span>
                </li>
                <li className="flex items-start gap-2 text-gray-700">
                  <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">{"{{website}}"}</span>
                  <span> - для обращения к сайту лида;</span>
                </li>
                <li className="flex items-start gap-2 text-gray-700">
                  <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">{"{{firstName}}"}</span>
                  <span> - для обращению по имени;</span>
                </li>
                <li className="flex items-start gap-2 text-gray-700">
                  <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">{"{{Personalization}}"}</span>
                  <span> - любая информация по лиду;</span>
                </li>
              </ul>
              <p className="text-gray-700">
                Как получить такие данные описано в пункте ниже.
              </p>
            </div>

            {/* Формулы для персонализации */}
            <div className="border-l-4 border-pink-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                <FileText className="h-5 w-5 text-pink-600" />
                Формулы для персонализации
              </h3>
              <div className="space-y-4">
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-gray-700 mb-3">
                    Имеется также пару формул, для персонализации, к примеру:
                  </p>
                  <div className="space-y-3">
                    <div>
                      <p className="text-gray-700 mb-2">
                        <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">{"{{переменная | текст}}"}</span> - если выполняется первое условие то будет показано именно оно, если значение в нем отсутствует, то покажется альтернативный текст.
                      </p>
                      <p className="text-gray-700 text-sm ml-4">
                        Например: "Краткий запрос в <span className="font-mono bg-gray-100 px-1 rounded">{"{{companyName | вашу компанию}}"}</span>". Если у нас имеется информация по названию компании лида, то в результате будет: "Краткий запрос в Polza Agency". Если же информации нет, то лиду отправится "Краткий запрос в вашу компанию".
                      </p>
                    </div>
                    <div>
                      <p className="text-gray-700 mb-2">
                        <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">{"{{RANDOM | текст | текст}}"}</span> - выбирает рандомно фразу или слово;
                      </p>
                    </div>
                    <div>
                      <p className="text-gray-700 mb-2">
                        <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">{"{% if last_email_opened %} текст, если он открыл прошлое письмо {% else %} текст, если он не открыл прошлое письмо {% endif %}"}</span>;
                      </p>
                    </div>
                    <div>
                      <p className="text-gray-700 mb-2">
                        <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">{"{% if sequence_email_opened %} текст, если он открыл хоть какое-то письмо из цепочки {% else %} текст, если он не открыл ни одно письмо {% endif %}"}</span>;
                      </p>
                    </div>
                  </div>
                </div>

                {/* Пример использования переменных if else */}
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 mb-3">Пример использования переменных if else:</h4>
                  <div className="bg-gray-100 rounded-lg p-4 border border-gray-300">
                    <code className="text-sm text-gray-800 whitespace-pre-wrap">
                      Не получил от вас ответ{"{% if sequence_email_opened %}"}, но видел, что вы читали мое предыдущее письмо, поэтому кратко расскажу вам о своем предложении. {"{% else %}"} и видел, что вы не читали мое прошлое письмо, поэтому сразу расскажу о своем предложении, чтобы у Вас осталась эта информация.{"{% endif %}"}
                    </code>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Как достать данные для персонализации? */}
        <section id="data-extraction" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-blue-600 rounded-lg">
              <Database className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">8. Как достать данные для персонализации?</h2>
          </div>

          <div className="space-y-6">
            <div className="border-l-4 border-blue-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                1. Персонализация с HH
              </h3>
              <div className="space-y-4">
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-gray-700 mb-3">
                    Если мы используем парсера hh, то нам нужно изначально очистить полученную от него базу от дубликатов (Выделяем все столбцы → Данные → Удалить дубликаты). Затем копируем в экстрактор (про него в разделе экстрактор) ссылки на компании, ждем от него документ с ами и затем вставляем в изначальную таблицу, которую прислал парсер, колонки email_1 и query. Сравниваем по колонкам со ссылками все ли ровно встало.
                  </p>
                  <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                    <img 
                      src="/images/personalization-hh-example.png"
                      alt="Пример таблицы с данными для персонализации"
                      className="w-full h-auto"
                    />
                  </div>

                  <p className="text-gray-700 mb-3">
                    Если все стоит ровно, то просто удаляем столбец query, он нам был нужен только для того чтобы отследить верность расположения .
                    Теперь выделяем столбец emai_1 и нажимаем на главной вкладке «Сортировка и фильтры» → Фильтр.
                  </p>
                  <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                    <img 
                      src="/images/filter-button-example.png"
                      alt="Кнопка Сортировка и фильтры"
                      className="w-full h-auto"
                    />
                  </div>
                  <p className="text-gray-700 mb-3">
                    Теперь нажимаем на стрелку около email_1, мотаем в самый низ и снимаем галочку с (пустые).
                  </p>
                  <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/3">
                    <img 
                      src="/images/filter-menu-example.png"
                      alt="Меню фильтрации"
                      className="w-full h-auto"
                    />
                  </div>
                  <p className="text-gray-700 mb-3">
                    Назовем новую колонку firstName, она нам еще понадобится.
                    Теперь следует быстро почистить названия компаний. Для этого выделяем колонку с названиями и нажимаем ctrl+f. 
                    Ищем данные по следующим критериям:
                  </p>
                  <ul className="list-disc list-inside text-gray-700 mb-3 pl-4">
                    <li>ИП</li>
                    <li>ООО</li>
                    <li>ТОО</li>
                    <li>,</li>
                    <li>«</li>
                    <li>»</li>
                    <li>Группа компаний</li>
                    <li>ГК</li>
                    <li>ТМ</li>
                    <li>ТД</li>
                  </ul>
                  <p className="text-gray-700 mb-3">
                    Жмем “найти все”
                  </p>
                  <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                    <img 
                      src="/images/find-replace-example.png"
                      alt="Поиск и замена"
                      className="w-full h-auto"
                    />
                  </div>
                  <p className="text-gray-700 mb-3">
                    Двигаем в конец ползунок результата и ищем значения, к примеру ИП [ФИО].
                  </p>
                  <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                    <img 
                      src="/images/search-results-example.png"
                      alt="Результаты поиска"
                      className="w-full h-auto"
                    />
                  </div>
                  <p className="text-gray-700 mb-3">
                    Жмем на нее и удаляем из ячейки всю лишнюю информацию, а имя записываем в колонку firstName.
                    Далее по 4-ый пункт делаем тоже самое по всем критериям, чтобы оставить только название компаний.
                    С 5-го пункта можно воспользоваться вкладкой заменить и моментально очистить колонку от ненужной инфы. Не забываем ставить галочку «учитывать регистр»!
                  </p>
                  <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                    <img 
                      src="/images/replace-all-example.png"
                      alt="Замена с учетом регистра"
                      className="w-full h-auto"
                    />
                  </div>
                  <p className="text-gray-700 mb-3">
                    Следующим шагом в очистке нам нужно быстро просмотреть базу на наличие ФИО. Если замечаем такие ячейки, то удаляем их и переносим эти данные в колонку firstName, оставляем только имя.
                  </p>
                  <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                    <img 
                      src="/images/firstname-move-example.png"
                      alt="Перенос имени в firstName"
                      className="w-full h-auto"
                    />
                  </div>
                  <p className="text-gray-700 mb-3">
                    Последним пунктом по очистке будет просмотр ячеек с длинным названием. Например:
                  </p>
                  <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                    <img 
                      src="/images/long-name-example.png"
                      alt="Пример длинного названия"
                      className="w-full h-auto"
                    />
                  </div>
                  <p className="text-gray-700 mb-3">
                    Такое название можно сократить вручную до НИИДПО. Либо же если в названии много лишней информации, то просто удаляем ее и оставляем только название. Ручной труд, но не нужно сильно вглядываться в каждую ячейку, достаточно просто включить перенос строк и тогда искать станет легче.
                  </p>
                  <p className="text-gray-700">
                    В целом такая очистка занимает около 15 минут.
                    После того как мы все сделали, переименовываем соответствующие колонки в website, companyName, email. Если имеется уникальная информация для каждого лида, то можно создать колонку Personalization, в которую ее вписать.
                  </p>
                </div>
              </div>
            </div>

            <div className="border-l-4 border-blue-500 pl-6 py-2">
              <h3 className="text-xl font-semibold mb-4 text-gray-800 flex items-center gap-2">
                2. Персонализация с карты
              </h3>
              <div className="space-y-4">
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-gray-700 mb-3">
                    Тут все проще. После получения базы с парсера переносим колонку «Веб-сайт 1» ближе к «E-mail 1» для удобства. Должно получится так:
                  </p>
                  <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                    <img 
                      src="/images/website-column-arrangement.png"
                      alt="Расположение колонок Веб-сайт 1 рядом с E-mail 1"
                      className="w-full h-auto"
                    />
                  </div>
                  <p className="text-gray-700 mb-3">
                    Теперь выделяем эти 3 колонки и удаляем дубликаты. После этого создаем на колонке «Веб-сайт 1» фильтр, и убираем пустые ячейки. Копируем ссылки и отправляем их в экстрактор. После выгрузки базы из экстрактора просто вставляем две колонки «query» и «email_1» в нашу изначальную базу и также как с базой из HH.ru мы сравниваем чтобы все стояло ровно. Если все стоит как надо удаляем лишний столбец «query» и старый столбец «E-mail 1». На выходе должны быть только 3 столбца данных, это:
                  </p>
                  <ul className="list-disc list-inside text-gray-700 mb-3 pl-4">
                    <li>«Наименование»</li>
                    <li>«Веб-сайт 1»</li>
                    <li>«email_1»</li>
                  </ul>
                  <p className="text-gray-700">
                    Пробегаем глазами по названиям и чистим при необходимости согласно предыдущему пункту «Персонализация с HH».
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Импорт персонализированной базы в Instantly */}
        <section id="instantly-import" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-blue-600 rounded-lg">
              <Database className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">9. Импорт персонализированной базы в Instantly</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-gray-700 mb-3">
                Создаем таблицу в Google Sheets и импортируем туда нашу очищенную базу. Теперь нам нужно открыть доступ для просмотра таблицы и скопировать ссылку на нее. Открываем нужную кампанию в Instantly, заходим во вкладку Leads → Import → Google Sheets и вставляем нашу ссылку. Теперь смотрим на правильность определения колонок, если все окей жмем Upload All.
              </p>
              <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                <img 
                  src="/images/instantly-import-mapping.png"
                  alt="Проверка определения колонок в Instantly"
                  className="w-full h-auto"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Нехватка места для лидов в instantly */}
        <section id="instantly-space" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-orange-600 rounded-lg">
              <Database className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Нехватка места для лидов в instantly</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-gray-700 mb-4">
                Если при загрузке лидов в instantly возникает ошибка нехватки места, то необходимо освободить место под лиды в своих кампаниях. Или попросить других специалистов очистить место в их кампаниях.
              </p>
              <p className="text-gray-700 mb-4">
                Чтобы очистить место под лиды нужно:
              </p>
              <ol className="list-decimal list-inside text-gray-700 mb-4 pl-4 space-y-3">
                <li>
                  Заходим во вкладку лиды в кампании
                </li>
                <li>
                  Если кампания ещё не завершена на 100% - вместо "All statuses" выбираем "Completed". Если кампания уже полностью проработала - можно сразу переходить к следующему пункту (3)
                  <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 mt-3 w-1/2">
                    <img 
                      src="/images/instantly-completed-filter.png"
                      alt="Выбор статуса Completed в фильтре"
                      className="w-full h-auto"
                    />
                  </div>
                </li>
                <li>
                  Выбираем все "Completed" контакты, нажав на верхнюю "галочку", затем "Select all"
                  <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 mt-3 w-1/2">
                    <img 
                      src="/images/instantly-select-all.png"
                      alt="Выбор всех контактов через Select all"
                      className="w-full h-auto"
                    />
                  </div>
                </li>
                <li>
                  Чтобы выгрузить контакты файлом нажимаем кнопку Download
                  <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 mt-3 w-1/2">
                    <img 
                      src="/images/instantly-download-leads.png"
                      alt="Кнопка Download для выгрузки контактов"
                      className="w-full h-auto"
                    />
                  </div>
                </li>
                <li>
                  Затем нужно будет загрузить полученный файл на диск (выберете нужную папку по нише и переименуйте файл, чтобы был понятен источник базы и её логика сбора или сфера) <a href="https://drive.google.com/drive/folders/1AuBbUIeTEBJk3vsABSgWUdlcm0Zzn62k?usp=sharing" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">https://drive.google.com/drive/folders/1AuBbUIeTEBJk3vsABSgWUdlcm0Zzn62k?usp=sharing</a>
                  <p className="text-gray-700 text-sm mt-2">
                    В такой базе будет статус отработавших контактов, и в будущем можно будет повторно взять базу в работу без bounced контактов, что существенно улучшит эффективность кампании.
                  </p>
                </li>
                <li>
                  Затем как выгрузили удаляем из старой кампании в instantly базу лидов, тем самым освобождая место под новые.
                  <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 mt-3 w-1/2">
                    <img 
                      src="/images/instantly-delete-leads.png"
                      alt="Удаление лидов из кампании"
                      className="w-full h-auto"
                    />
                  </div>
                </li>
              </ol>
            </div>
          </div>
        </section>

        {/* Проверка персонализации */}
        <section id="personalization-check" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-green-600 rounded-lg">
              <Database className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">10. Проверка персонализации</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-gray-700 mb-3">
                Чтобы узнать как будет выглядеть персонализация и все ли в ней правильно нажимаем на значок глаза внутри редактора цепочки писем кампании.
              </p>
              <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/3">
                <img 
                  src="/images/preview-email-icon.png"
                  alt="Значок глаза для предпросмотра письма"
                  className="w-full h-auto"
                />
              </div>
              <p className="text-gray-700 mb-3">
                Теперь мы можем вписать значение для проверки в окно персонализации, например, companyName. Выбираем получателя тестового письма, например, личную почту. Выбираем почту отправителя и нажимаем синюю кнопку «Send test email».
              </p>
              <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                <img 
                  src="/images/test-email-preview.png"
                  alt="Предпросмотр тестового письма с персонализацией"
                  className="w-full h-auto"
                />
              </div>
              <p className="text-gray-700 mb-3">
                Также имеется возможность проверить как будет выглядеть письмо при открытии или не открытии его лидом (если мы используем эту формулу). Для этого переключаем значения False и True в соответствующем окне слева.
              </p>
              <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/3">
                <img 
                  src="/images/last-email-opened-toggle.png"
                  alt="Переключение значений last_email_opened"
                  className="w-full h-auto"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Шаблон первого письма в GPT для зарубежных проектов */}
        <section id="gpt-template" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-purple-600 rounded-lg">
              <Database className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">11. Шаблон первого письма в GPT для зарубежных проектов</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-gray-700 mb-3">
                Чтобы GPT понимал лучше суть проекта необходимо установить плагин WebPilot для чтения ссылок из интернета.
              </p>
              <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                <img 
                  src="/images/webpilot-plugin.png"
                  alt="Установка плагина WebPilot в GPT"
                  className="w-full h-auto"
                />
              </div>
              <p className="text-gray-700 mb-3">
                Теперь даем GPT - ссылку на сайт нашего проекта с промптом:
              </p>
              <div className="bg-gray-100 rounded-lg p-4 border border-gray-300 mb-3">
                <code className="text-sm text-gray-800">
                  Pull all the information from the website and explain it here:<br />
                  [ссылка на сайт]
                </code>
              </div>
              <p className="text-gray-700 mb-3">
                После того как мы получили ответ, мы должны скормить GPT наш бриф. Изначально представляемся, даем несколько подробностей про себя и нашу компанию, чтобы GPT понимал от чьего лица писать. Дальше начинаем идти по пунктам из брифа прям в этом же промпте.
              </p>
              <div className="bg-gray-100 rounded-lg p-4 border border-gray-300 mb-3">
                <code className="text-sm text-gray-800 whitespace-pre-wrap">
                  Here&apos;s some information about me and my project. Your job is to memorize everything and write &quot;I memorized&quot;:

                  My name [имя], I am [должность] at [название компании], [описание деятельности компании]

                  Our target audience: …

                  Description of our service: …

                  5 advantages of our service: …

                  Impressive numbers: …

                  Our customers&apos; problems and pains: …

                  Special offer: …

                  Warranties: …
                </code>
              </div>
              <p className="text-gray-700 mb-3 text-sm">
                5 проблем при работе с нашими клиентами обычно не даю GPT, чтобы он по ошибке не спутал их с нашими проблемами в компании.
              </p>
              <p className="text-gray-700 mb-3">
                Вот как это примерно выглядит:
              </p>
              <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                <img 
                  src="/images/gpt-brief-example.png"
                  alt="Пример брифа для GPT"
                  className="w-full h-auto"
                />
              </div>
              <p className="text-gray-700 mb-3">
                Теперь нам нужно достать боли и проблемы потенциальных клиентов. Для этого можно обратить внимание на блок «Проблемы, с которыми к вам приходят ваши клиенты» из брифа. Но этого зачастую недостаточно, поэтому обращаемся к GPT.
              </p>
              <div className="bg-gray-100 rounded-lg p-4 border border-gray-300 mb-3">
                <code className="text-sm text-gray-800">
                  Write the 10 most frequent pains and problems of [наша ЦА] that we can solve. For each problem, write how we solve it.
                </code>
              </div>
              <p className="text-gray-700 mb-3">
                После того как мы получили список болей, проверяем и изучаем их, чтобы самим лучше понимать с чем сталкиваются клиенты. Выделяем для себя 4-5 основных проблемы аудитории, которые кажутся нам наиболее сильными.
              </p>
              <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                <img 
                  src="/images/gpt-pains-problems.png"
                  alt="Список болей и проблем от GPT"
                  className="w-full h-auto"
                />
              </div>
              <p className="text-gray-700 mb-3">
                Теперь переходим к написанию самого первого письма. Копируем и отправляем GPT следующий промпт:
              </p>
              <div className="bg-gray-100 rounded-lg p-4 border border-gray-300 mb-3">
                <code className="text-sm text-gray-800 whitespace-pre-wrap">
                  According to the information about my company and the pains and problems solved by my company that I have sent above, write the first message for my WhatsApp message, strictly following the structure below. Self-identify the &quot;pains&quot; of our target audience, think in advance about objections and how my company can benefit them/what I will benefit them. Write in a slightly conversational form, as close to human interaction as possible. It shouldn&apos;t come across as a sales pitch, the letter should build on the benefit to the client. Try to write more naturally so that the letter is more personalized and doesn&apos;t look like spam. The test should be strictly no more than 110 words or 620 characters.
                  The call to action should make the person want to respond to the letter, addressing his needs but not committing to anything. He should see how he will benefit by responding to the letter. We must give something in return for his response. For example, advice on an issue he cares about. The message should be aimed at relieving the client of certain pains, solving his problems. That is, to hit the client&apos;s existing exact problems. Don&apos;t use curly braces {"{{"} {"}}"}  in your reply.

                  Be sure to follow a paragraph structure, you don&apos;t have to write in solid text

                  Message structure:

                  {"{{greeting}}"}

                  {"{{In one sentence introduce yourself. Say what company I'm from, what it does and for who, use Impressive figures, talk briefly and factually about our benefits and hit on our target audience area. Don't ask any questions of the person in the paragraph. Do a spunk before the next abaz}}"}

                  {"{{In one sentence we say what we can give to our client and what they will get from our offer, what is the benefit to them, mention what problem of the client we are solving with our offer. Don't ask any questions to the person in this paragraph. Do a spunk before the next abaz}}"}

                  {"{{In one sentence, talk about Special offer if any and also mention guarantees. Do not ask any questions to the person in this paragraph. Do a spook before the next abazzer}}"}

                  {"{{Call to action. In one sentence ask a question in which we describe his pains, problems that won't be and ask if he would be interested. You can also describe the benefit the person will receive}}"}
                </code>
              </div>
              <p className="text-gray-700 mb-3">
                В результате получаем практически готовое сообщение, которое требует минимальных доработок (иногда необходимо подкорректировать call to action, чтобы он был более разговорным, добавить уточнение по должностям нашей ЦА, убрать воду и лишние прилагательные).
              </p>
              <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                <img 
                  src="/images/gpt-first-message-result.png"
                  alt="Результат генерации первого письма от GPT"
                  className="w-full h-auto"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Продвинутый шаблон первого письма в GPT */}
        <section id="gpt-advanced-template" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-purple-600 rounded-lg">
              <Database className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">12. Продвинутый шаблон первого письма в GPT</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-gray-700 mb-3">
                Для того чтобы написать качественное первое письмо в GPT, необходимо перейти в соответствующий тред: <a href="https://chat.openai.com/share/eda115e4-defc-4ff7-8807-5a12eeb89c7d" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">https://chat.openai.com/share/eda115e4-defc-4ff7-8807-5a12eeb89c7d</a>
              </p>
              <p className="text-gray-700 mb-3">
                Теперь первым делом нам необходимо вытащить информацию из сайта клиента. Если сайт не относится к сегменту / теме нашего письма, то можно использовать информацию из брифа, а именно:
              </p>
              <div className="bg-gray-100 rounded-lg p-4 border border-gray-300 mb-3">
                <code className="text-sm text-gray-800 whitespace-pre-wrap">
                  My name [имя], I am [должность] at [название компании], [описание деятельности компании]
                  Our target audience: …
                  Description of our service/good:: …
                  Our 5 benefits: …
                  Unique selling proposition: …
                  Impressive numbers: …
                  Our customers&apos; problems and pains: …
                  Special offer: …
                  Warranties: …
                </code>
              </div>
              <p className="text-gray-700 mb-3">
                Если сайт нам подходит, то чтобы вытащить информацию с него, корректируем следующее сообщение и заменяем ссылку на нужную:
              </p>
              <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                <img 
                  src="/images/gpt-extract-website-info.png"
                  alt="Извлечение информации с сайта через GPT"
                  className="w-full h-auto"
                />
              </div>
              <p className="text-gray-700 mb-3">
                После этого мы можем отправить информацию из брифа, если еще этого не сделали:
              </p>
              <div className="bg-gray-100 rounded-lg p-4 border border-gray-300 mb-3">
                <code className="text-sm text-gray-800">
                  Here&apos;s a bit of information about me and my project based on the brief. Your job is to memorize everything and write &quot;I memorized&quot;:
                </code>
              </div>
              <p className="text-gray-700 mb-3">
                Чтобы GPT мог лучше понимать боли нашей ЦА при написании письма, просим его написать список из 10 проблем.
              </p>
              <div className="bg-gray-100 rounded-lg p-4 border border-gray-300 mb-3">
                <code className="text-sm text-gray-800">
                  Write the 10 most frequent pains and problems of [наша ЦА] that we can solve. For each problem, write how we solve it.
                </code>
              </div>
              <p className="text-gray-700 mb-3">
                Теперь можно отправлять промпт на написание 1-го письма:
              </p>
              <div className="bg-gray-100 rounded-lg p-4 border border-gray-300 mb-3">
                <code className="text-sm text-gray-800">
                  Write the first Cold Email Outreach letter for our target audience [наша ЦА], based on all the information above, the structure you sent, the examples of my letters, the information from my company&apos;s website and the information from my company&apos;s brief. Important clarification, don&apos;t write useless sentences, you don&apos;t need to write a bunch of different adjectives. Speak in facts and keep it to no more than 130 words. Also, in the last sentence with a question, try to hit as specific as possible painful customer problems that we can solve.
                </code>
              </div>
              <p className="text-gray-700 mb-3">
                Как результат получаем компактное сообщение без особой воды, требующее минимальных корректировок:
              </p>
              <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                <img 
                  src="/images/gpt-advanced-result.png"
                  alt="Результат продвинутого промпта GPT"
                  className="w-full h-auto"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Написание RU цепочек с помощью ChatGPT */}
        <section id="chatgpt-ru-chains" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-red-600 rounded-lg">
              <Database className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">13. Написание RU цепочек с помощью ChatGPT</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-gray-700 mb-3">
                <strong>Старое видео:</strong><br />
                <a href="https://www.youtube.com/watch?v=NzGNX1LUymo" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">https://www.youtube.com/watch?v=NzGNX1LUymo</a>
              </p>
              <p className="text-gray-700">
                <strong>Новое видео:</strong><br />
                <a href="https://drive.google.com/file/d/1atsZSUUulEIK_V16T68x29XzpfIeSh2f/view" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Написание оффера в GPT.mp4</a>
              </p>
            </div>
          </div>
        </section>

        {/* UTM метки в ссылки в письмах */}
        <section id="utm-tags" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-teal-600 rounded-lg">
              <Database className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">14. UTM метки в ссылки в письмах</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-gray-700 mb-3">
                <strong>Шаблон UTM метки:</strong>
              </p>
              <div className="bg-gray-100 rounded-lg p-4 border border-gray-300 mb-3">
                <code className="text-sm text-gray-800">
                  /?utm_source=polzaagency&amp;utm_medium=outreach&amp;utm_campaign=name
                </code>
              </div>
              <p className="text-gray-700 mb-3">
                Добавляется к ссылке и меняется только последнее слово [name] на название кампании / базы одним словом и на английском
              </p>
              <p className="text-gray-700 mb-3">
                <strong>Пример:</strong>
              </p>
              <div className="bg-gray-100 rounded-lg p-4 border border-gray-300 mb-3">
                <code className="text-sm text-gray-800">
                  https://polzaagency.ru/?utm_source=polzaagency&amp;utm_medium=outreach&amp;utm_campaign=b2bsales
                </code>
              </div>
            </div>
          </div>
        </section>

        {/* Настройка мощности для именных почт */}
        <section id="email-power-settings" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-yellow-600 rounded-lg">
              <Database className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">6.1 Настройка мощности для именных почт</h2>
          </div>

          <div className="space-y-6">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-gray-700">
                Начальную мощность ставить - 20 писем в день, и каждую неделю повышать на 10 писем в день. Максимальное количество писем в день - 80 для гугловских (наши и именные), 40 - для наших не именных почт (с почтовых серверов)
              </p>
            </div>
          </div>
        </section>

        {/* Создание кампаний */}
        <section id="campaign-creation" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-indigo-600 rounded-lg">
              <Database className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">7. Создание кампаний</h2>
          </div>

          <div className="space-y-5">
            {/* Видео */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-indigo-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="p-2 bg-indigo-100 rounded-lg group-hover:bg-indigo-200 transition-colors">
                  <FileText className="h-5 w-5 text-indigo-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Видео про создание кампаний в Instantly</h3>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    <a href="https://youtu.be/Y-J2HEjtl1E" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium">
                      https://youtu.be/Y-J2HEjtl1E
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </p>
                  <div className="bg-amber-50 border-l-4 border-amber-400 rounded-r-md p-4">
                    <p className="text-sm text-amber-900">
                      <span className="font-semibold">Поправка к видео:</span> по поводу времени работы кампании - лучше всегда делать с 9 утра до 18 вечера, чтобы instantly точно успел отправить необходимое количество писем. (если в базе сборная солянка из городов, то лучше поставить до 3х дня по мск)
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Шаг 1: Создание кампании */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-indigo-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center font-bold text-lg group-hover:bg-indigo-200 transition-colors">1</div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Создание кампании и импорт базы</h3>
                  <p className="text-gray-700 leading-relaxed mb-4">
                    После того как мы добавили почты в instantly (пункт 5 в работе с почтами), собрали базу и написали цепочку, мы приступаем к созданию кампаний в instantly. Для этого переходим в соответствующую вкладку на сайте, нажимаем «+ADD NEW» и называем кампанию. Нас перебросит в окно «Leads», где нам необходимо импортировать базу емэйлов. Для этого жмем синюю кнопку «Import» → Emails Manually, вставляем список спарсеных емэйлов и жмем на кнопку «Import Emails».
                  </p>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    При добавлении контактов из Гугл Таблиц, выбираем google sheets (мы сейчас всегда импортируем через гугл таблицы)
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white w-1/2">
                    <img 
                      src="/images/instantly-import-options.png"
                      alt="Опции импорта в Instantly"
                      className="w-full h-auto"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Шаг 2: Sequences */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-indigo-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center font-bold text-lg group-hover:bg-indigo-200 transition-colors">2</div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Настройка цепочки писем (Sequences)</h3>
                  <p className="text-gray-700 leading-relaxed mb-4">
                    После добавления базы емэйлов переходим во вкладку «Sequences», вписываем тему письма: Краткий запрос, вставляем и форматируем текст (добавляем ссылки в слова, выделяем жирным и убираем форматирование), затем нажимаем на шестеренку и вписываем количество дней ожидания. Обычно связка дней строится по системе: 1/3/5/7. Жмем «Save». В следующих письмах добавлять название темы не нужно. Чтобы добавить новое письмо жмем «Add step».
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white mb-4 w-1/2">
                    <img 
                      src="/images/instantly-sequences-editor.png"
                      alt="Редактор цепочки писем в Instantly"
                      className="w-full h-auto"
                    />
                  </div>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Чтобы убрать форматирование текста выделяем его и нажимаем как показано на скриншоте ниже:
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white w-1/3">
                    <img 
                      src="/images/clear-formatting-button.png"
                      alt="Кнопка очистки форматирования"
                      className="w-full h-auto"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Шаг 3: Schedule */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-indigo-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center font-bold text-lg group-hover:bg-indigo-200 transition-colors">3</div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Настройка расписания (Schedule)</h3>
                  <p className="text-gray-700 leading-relaxed mb-4">
                    После того как все письма добавлены и сохранены переходим ко следующей вкладке «Schedule». Выбираем дни рассылки без выходных, устанавливаем временной пояс получателя и жмем «Save».
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white w-1/2">
                    <img 
                      src="/images/instantly-schedule-settings.png"
                      alt="Настройки расписания в Instantly"
                      className="w-full h-auto"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Шаг 4: Options и запуск */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-indigo-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-green-100 text-green-600 rounded-full flex items-center justify-center font-bold text-lg group-hover:bg-green-200 transition-colors">4</div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Выбор аккаунтов и запуск (Options)</h3>
                  <p className="text-gray-700 leading-relaxed mb-4">
                    В следующей вкладке «Options» выбираем аккаунты для рассылки, которые мы создали и добавили. В самом низу страницы не забываем сохранить. После того как все проделано, можно запускать по кнопке «Launch».
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white mb-4 w-1/2">
                    <img 
                      src="/images/instantly-accounts-select.png"
                      alt="Выбор аккаунтов для рассылки"
                      className="w-full h-auto"
                    />
                  </div>
                  <div className="bg-red-50 border-l-4 border-red-500 rounded-r-md p-4">
                    <p className="text-sm text-red-900">
                      <span className="font-semibold">Важный момент!</span> Если пользователь отвечает на нашу рассылку, то он больше не будет получать письма из нее.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Улучшение и проверка письма через инструменты instantly */}
        <section id="instantly-ai-tools" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-cyan-600 rounded-lg">
              <Database className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">7.1 Улучшение и проверка письма через инструменты instantly</h2>
          </div>

          <div className="space-y-5">
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-cyan-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="p-2 bg-cyan-100 rounded-lg group-hover:bg-cyan-200 transition-colors">
                  <CheckCircle2 className="h-5 w-5 text-cyan-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">AI Spintax Writer</h3>
                  <p className="text-gray-700 leading-relaxed mb-4">
                    Используйте эти функции, чтобы увеличить доставляемость и уменьшить фактор спама. Сделать это можно с помощью автоматической рандомизации частей письма.
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white mb-4 w-1/2">
                    <img 
                      src="/images/instantly-ai-tools.png"
                      alt="AI Tools в Instantly"
                      className="w-full h-auto"
                    />
                  </div>
                  <p className="text-gray-700 leading-relaxed mb-4">
                    Выберите &quot;Ai spintax writer&quot;, эта функция автоматически найдёт части письма, которые можно разбавить несколькими синонимичными фразами, что очень снижает фактор спама.
                  </p>
                  <div className="bg-amber-50 border-l-4 border-amber-400 rounded-r-md p-4 mb-4">
                    <p className="text-sm text-amber-900">
                      <span className="font-semibold">ОБЯЗАТЕЛЬНО</span> перечитайте что вышло в итоге и удалите неграмотные варианты.
                    </p>
                  </div>
                  <p className="text-gray-700 leading-relaxed mb-3">Как выглядит в итоге:</p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white mb-4 w-1/2">
                    <img 
                      src="/images/instantly-spintax-result.png"
                      alt="Результат работы AI Spintax Writer"
                      className="w-full h-auto"
                    />
                  </div>
                  <p className="text-gray-700 leading-relaxed">
                    И при отправлении будут случайным образом использоваться разные части синонимичных фраз, через кнопку preview можете посмотреть на результат, при каждом новом нажатии будет по сути новое сообщение.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Добавление картинок в письмо в Instantly (через imgur) */}
        <section id="instantly-images" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-green-600 rounded-lg">
              <Database className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">8. Добавление картинок в письмо в Instantly (через imgur)</h2>
          </div>

          <div className="space-y-5">
            {/* Шаг 1: Вход в Imgur */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-green-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-green-100 text-green-600 rounded-full flex items-center justify-center font-bold text-lg group-hover:bg-green-200 transition-colors">1</div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Вход в Imgur</h3>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Зайти в <a href="https://imgur.com" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium">https://imgur.com <ExternalLink className="h-3 w-3" /></a>
                  </p>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Можно залогинится через гугл со своей почтой или sorichev@polzaagency.ru
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white w-1/4">
                    <img 
                      src="/images/imgur-login.png"
                      alt="Вход в Imgur"
                      className="w-full h-auto"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Шаг 2: Загрузка изображения */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-green-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-green-100 text-green-600 rounded-full flex items-center justify-center font-bold text-lg group-hover:bg-green-200 transition-colors">2</div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Загрузка изображения</h3>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Загрузить изображение. Для этого нажимаем New post
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white mb-4 w-1/2">
                    <img 
                      src="/images/imgur-new-post.png"
                      alt="Кнопка New post в Imgur"
                      className="w-full h-auto"
                    />
                  </div>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Загрузите любым удобным способом изображение. После того как изображение будет загружено, копируйте ссылку на это изображение через нажатие по картинке правой кнопкой мыши, после чего &quot;скопировать адрес изображения&quot;
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white w-1/2">
                    <img 
                      src="/images/imgur-copy-link.png"
                      alt="Копирование ссылки на изображение"
                      className="w-full h-auto"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Шаг 3: Вставка в Instantly */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-green-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-green-100 text-green-600 rounded-full flex items-center justify-center font-bold text-lg group-hover:bg-green-200 transition-colors">3</div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Вставка в письмо Instantly</h3>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Для того, чтобы добавить картинку в письмо, откройте more rich
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white mb-4 w-1/2">
                    <img 
                      src="/images/instantly-more-rich.png"
                      alt="Кнопка More rich в Instantly"
                      className="w-full h-auto"
                    />
                  </div>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    И выберете специальную функцию вставки изображения
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white mb-4 w-1/2">
                    <img 
                      src="/images/instantly-insert-image-button.png"
                      alt="Кнопка вставки изображения"
                      className="w-full h-auto"
                    />
                  </div>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    И вставьте ссылку
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white w-1/3">
                    <img 
                      src="/images/instantly-insert-image-url.png"
                      alt="Вставка ссылки на изображение"
                      className="w-full h-auto"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Проверка входящих и использование готовых шаблонов в Instantly */}
        <section id="instantly-unibox" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-violet-600 rounded-lg">
              <Mail className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">9. Проверка входящих и использование готовых шаблонов в Instantly</h2>
          </div>

          <div className="space-y-5">
            {/* Общая информация */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-violet-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="p-2 bg-violet-100 rounded-lg group-hover:bg-violet-200 transition-colors">
                  <Mail className="h-5 w-5 text-violet-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Unibox и почтовые клиенты</h3>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Чтобы проверять входящие можно использовать Unibox, но лучше скачать и настроить почтовый клиент (например Thunderbird), т.к. некоторые письма могут не доходить до юнибокса.
                  </p>
                  <p className="text-gray-700 leading-relaxed">
                    Как создавать, сохранять шаблоны ответов в unibox, как отвечать на сообщения показали и рассказали в этом видео.
                  </p>
                </div>
              </div>
            </div>

            {/* Примеры шаблонов */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-violet-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="p-2 bg-violet-100 rounded-lg group-hover:bg-violet-200 transition-colors">
                  <FileText className="h-5 w-5 text-violet-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-3 text-lg">Какие могут быть примеры шаблонов:</h3>
                  
                  <div className="space-y-3">
                    <div className="bg-white border border-gray-200 rounded-lg p-4 hover:border-violet-200 transition-colors">
                      <div className="flex items-start gap-3">
                        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-violet-100 text-violet-600 flex items-center justify-center text-sm font-semibold">1</span>
                        <p className="text-gray-700 leading-relaxed">
                          Когда мы отвечаем на первое письмо и меняем первую часть сообщения, например, вам ответили &quot;Что вы хотели предложить?/Что вы хотели?&quot; и т.п., и вы отвечаете не &quot;спасибо за ответ&quot; и дальше предложение, а &quot;Хочу рассказать подробнее о своем предложении, чтобы у вас осталась эта информация&quot; и после этого предложение идёт. То есть персонализируем как нам нужно, делаем пару таких вариантов и сохраняем такой шаблон.
                        </p>
                      </div>
                    </div>
                    
                    <div className="bg-white border border-gray-200 rounded-lg p-4 hover:border-violet-200 transition-colors">
                      <div className="flex items-start gap-3">
                        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-violet-100 text-violet-600 flex items-center justify-center text-sm font-semibold">2</span>
                        <p className="text-gray-700 leading-relaxed">
                          Когда нужно уточнить, какая информация нам нужна, например, вместо почты в ответ на первое письмо, вам прислали только номер телефона, в таком случае лучше сохранить себе такой шаблон: &quot;Можете, пожалуйста, прислать мне актуальную почту, чтобы я мог отправить свое предложение в текстовом формате? Заранее спасибо)&quot; - и не забываем подпись &quot;С уважением, ФИО&quot;
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="bg-amber-50 border-l-4 border-amber-400 rounded-r-md p-4 mt-4">
                    <p className="text-sm text-amber-900">
                      <span className="font-semibold">Важный момент перед отправкой сообщения лиду:</span> в переменную <span className="font-mono bg-white px-1 rounded border border-amber-200">{"{{companyName}}"}</span> автоматически не подставляется название компании, его нужно менять вручную или вообще убирать и оставлять формулировку, например, &quot;в вашей компании&quot;, &quot;для вашей компании&quot; и т.п. (для экономии времени и удобства использования шаблонов лучше использовать второй вариант).
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Настройки прогрева в instantly для улучшения прогрева */}
        <section id="instantly-warmup-settings" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-pink-600 rounded-lg">
              <BarChart3 className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">10. Настройки прогрева в instantly для улучшения прогрева</h2>
          </div>

          <div className="space-y-5">
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-pink-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="p-2 bg-pink-100 rounded-lg group-hover:bg-pink-200 transition-colors">
                  <BarChart3 className="h-5 w-5 text-pink-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-3 text-lg">Рекомендуемые настройки прогрева</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white hover:shadow-md transition-shadow">
                      <img 
                        src="/images/instantly-warmup-settings-1.png"
                        alt="Настройки прогрева 1"
                        className="w-full h-auto"
                      />
                    </div>
                    <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white hover:shadow-md transition-shadow">
                      <img 
                        src="/images/instantly-warmup-settings-2.png"
                        alt="Настройки прогрева 2"
                        className="w-full h-auto"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Отложенный старт кампаний */}
        <section id="delayed-start" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-slate-600 rounded-lg">
              <Calendar className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">11. Отложенный старт кампаний</h2>
          </div>

          <div className="bg-slate-50 rounded-lg p-4 mb-5 border border-slate-200">
            <p className="text-gray-700 leading-relaxed">
              Как поставить кампании на паузу, например на время праздников, чтобы они автоматически начали работать утром нужного дня?
            </p>
          </div>

          <div className="space-y-5">
            {/* Шаг 1 */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-slate-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-slate-100 text-slate-600 rounded-full flex items-center justify-center font-bold text-lg group-hover:bg-slate-200 transition-colors">1</div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Поставить кампанию на паузу</h3>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    В первую очередь ставим кампанию на паузу.
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white w-1/2">
                    <img 
                      src="/images/instantly-pause-campaign.png"
                      alt="Пауза кампании"
                      className="w-full h-auto"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Шаг 2 */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-slate-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-slate-100 text-slate-600 rounded-full flex items-center justify-center font-bold text-lg group-hover:bg-slate-200 transition-colors">2</div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Открыть настройки расписания</h3>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Далее во вкладке &quot;Schedule&quot; нажимаем &quot;Now&quot; напротив &quot;🗓Start&quot;
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white w-1/2">
                    <img 
                      src="/images/instantly-schedule-start.png"
                      alt="Выбор даты старта"
                      className="w-full h-auto"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Шаг 3 */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-slate-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-slate-100 text-slate-600 rounded-full flex items-center justify-center font-bold text-lg group-hover:bg-slate-200 transition-colors">3</div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Выбрать дату запуска</h3>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Ставим нужную дату запуска и жмём &quot;Apply&quot;
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white mb-4 w-1/3">
                    <img 
                      src="/images/instantly-select-date.png"
                      alt="Выбор даты в календаре"
                      className="w-full h-auto"
                    />
                  </div>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Теперь напротив &quot;Start&quot; стоит дата автоматического запуска
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white w-1/2">
                    <img 
                      src="/images/instantly-date-set.png"
                      alt="Дата запуска установлена"
                      className="w-full h-auto"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Шаг 4 */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-slate-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-slate-100 text-slate-600 rounded-full flex items-center justify-center font-bold text-lg group-hover:bg-slate-200 transition-colors">4</div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Сохранить настройки</h3>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    После этого нужно сохранить кампанию (нажать Save внизу страницы)
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white w-1/3">
                    <img 
                      src="/images/instantly-save-schedule.png"
                      alt="Сохранение настроек расписания"
                      className="w-full h-auto"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Шаг 5 */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-green-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-green-100 text-green-600 rounded-full flex items-center justify-center font-bold text-lg group-hover:bg-green-200 transition-colors">5</div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Возобновить кампанию</h3>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    И последнее: нужно нажать &quot;Resume campaign&quot; сверху справа страницы. Кампания запустится, но письма не будут отправляться до даты отложенного старта.
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white mb-4 w-1/2">
                    <img 
                      src="/images/instantly-resume-campaign.png"
                      alt="Возобновление кампании"
                      className="w-full h-auto"
                    />
                  </div>
                  <div className="bg-green-50 border-l-4 border-green-500 rounded-r-md p-3">
                    <p className="text-sm text-green-800 font-medium">Готово!</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Проверка заспамленности новых аккаунтов */}
        <section id="spam-check" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-orange-600 rounded-lg">
              <Shield className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">12. Проверка заспамленности новых аккаунтов</h2>
          </div>

          <div className="space-y-5">
            {/* Analytics в Instantly */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-orange-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="p-2 bg-orange-100 rounded-lg group-hover:bg-orange-200 transition-colors">
                  <BarChart3 className="h-5 w-5 text-orange-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-3 text-lg">Analytics в Instantly</h3>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Заходим во вкладку Analytics в Instantly, снизу графиков нажимаем на Account Analytics
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white mb-4 w-1/4">
                    <img 
                      src="/images/instantly-analytics-menu.png"
                      alt="Меню Account Analytics"
                      className="w-full h-auto"
                    />
                  </div>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Справа над графиком выбираем время за которое хотим сравнивать аналитику аккаунтов. Обычно 7 дней достаточно чтобы сравнить пользователей по одному проекту, рассылки по которому активно работали последнее время.
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white mb-4 w-1/2">
                    <img 
                      src="/images/instantly-analytics-period.png"
                      alt="Выбор периода аналитики"
                      className="w-full h-auto"
                    />
                  </div>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Дальше можно сравнить по параметрам почты с разных доменов которые работают в одинаковых кампаниях. Если параметры примерно одинаковые - значит здоровье (спамность) доменов близки друг к другу.
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white w-1/2">
                    <img 
                      src="/images/instantly-analytics-comparison.png"
                      alt="Сравнение параметров почт"
                      className="w-full h-auto"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Postmaster */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-orange-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="p-2 bg-orange-100 rounded-lg group-hover:bg-orange-200 transition-colors">
                  <Globe className="h-5 w-5 text-orange-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Postmaster</h3>
                  <p className="text-gray-700 leading-relaxed">
                    <a href="https://postmaster.mail.ru/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium">https://postmaster.mail.ru/ <ExternalLink className="h-3 w-3" /></a>
                  </p>
                  <p className="text-gray-700 leading-relaxed mt-2">
                    С помощью этого сервиса можно оценить доставляемость на почты mail.ru в абсолютных значениях, и просматривать статистику по доменам.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* LinkedIn */}
        <section id="linkedin" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-blue-700 rounded-lg">
              <Users className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">LinkedIn</h2>
          </div>

          <div className="space-y-5">
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-blue-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <p className="text-gray-700 mb-3">
                В начале регистрируем на сайте линкедин новый аккаунт (либо запрашиваем у заказчика доступы в его уже существующий аккаунт). Если аккаунт новый - его необходимо “прогреть” хотя бы 5 дней (прогрев - это просто количество дней, которое аккаунт существует). Регистрация там обычная, как в любой другой соц сети.
              </p>
              <p className="text-gray-700 mb-3">
                <strong>Линкедин не работает без впн!</strong> Также при регистрации линк запросит номер телефона - нужен обязательно иностранный. Купить одноразовый номер можно на сайте - <a href="https://onlinesim.io/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">OnlineSim</a>. После введения кода вводим необходимые данные - должность и место работы. Потом он предложит добавить кого-то в друзья, зафолловить какие-то компании - все пропускаем.
              </p>
              <p className="text-gray-700 mb-3">
                После создания аккаунта отдаем его заказчику на заполнение - чем больше информации заполнено в профиле - тем вероятнее лиды примут запрос на добавление в друзья.
              </p>
              <p className="text-gray-700 mb-3">
                Также на аккаунт необходимо купить премиум подписку. Покупает либо заказчик, либо мы (если у заказчика нет иностранной карты, с которой он может оплатить). Ему нужна самая дешевая подписка - career.
              </p>
              <div className="bg-yellow-50 border-l-4 border-yellow-500 p-4 mb-4">
                <p className="text-gray-700">
                  <strong>Как правильно покупать подписку:</strong> При оплате необходимо выставить регион Турции - так будет значительно дешевле. Местоположение профиля ставится Турция прям в настройках, делается покупка, потом можно менять обратно (на тот регион который вы ставили изначально при регистрации). Карту после покупки важно отвязать, чтобы деньги не списывались автоматически.
                </p>
              </div>
              
              <h4 className="font-semibold text-gray-700 mb-2">Актуальное видео по работе с линкедин в фантомбустере:</h4>
              <p className="text-gray-700 mb-4">
                <a href="https://drive.google.com/file/d/1qU8nZdg0oBvsaNUimd1tGktCd33hFt7M/view?usp=share_link" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Работа с линкедин: сбор контактов из СН и фантомбустер.mp4</a>
              </p>

              <h4 className="font-semibold text-gray-700 mb-2">Примеры цепочек линкедин:</h4>
              <ul className="list-disc list-inside text-gray-700 space-y-2 mb-4 pl-4">
                <li><a href="https://docs.google.com/document/d/1vXF6RmwmeXjOLlrfwyU5uPrmrSX3lVRVFevxHiyRb-Y/edit?tab=t.0#heading=h.j7ysc8se2644" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Оффер польза линкедин</a></li>
                <li><a href="https://docs.google.com/document/d/1-qL6PQ4nEdouJOqjMFBTzN3xNanA2yWDqW6qGQ-grYU/edit?tab=t.0" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Цепочка для Linkedin Hostkey</a></li>
              </ul>
            </div>
          </div>
        </section>

        {/* Персонализация LinkedIn */}
        <section id="linkedin-personalization" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-blue-500 rounded-lg">
              <User className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Персонализация LinkedIn</h2>
          </div>

          <div className="space-y-5">
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-blue-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="p-2 bg-blue-100 rounded-lg group-hover:bg-blue-200 transition-colors">
                  <User className="h-5 w-5 text-blue-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-3 text-lg">Создание персонализированных писем</h3>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Если у вас есть таблица с данными от Sales Navigator, то можно сделать личные персонализированные письма. Для этого чистим информацию в таблице от лишних технических колонок (id, даты, метки, теги, пустые колонки) и оставляем самые важные:
                  </p>
                  <div className="bg-white border border-gray-200 rounded-lg p-3 mb-4">
                    <div className="grid grid-cols-3 gap-2 font-mono text-sm">
                      <span className="px-2 py-1 bg-blue-50 text-blue-700 rounded">profile_url</span>
                      <span className="px-2 py-1 bg-blue-50 text-blue-700 rounded">current_company</span>
                      <span className="px-2 py-1 bg-blue-50 text-blue-700 rounded">first_name</span>
                      <span className="px-2 py-1 bg-blue-50 text-blue-700 rounded">last_name</span>
                      <span className="px-2 py-1 bg-blue-50 text-blue-700 rounded">email</span>
                      <span className="px-2 py-1 bg-blue-50 text-blue-700 rounded">location_name</span>
                      <span className="px-2 py-1 bg-blue-50 text-blue-700 rounded">summary</span>
                      <span className="px-2 py-1 bg-blue-50 text-blue-700 rounded">current_company_position</span>
                      <span className="px-2 py-1 bg-blue-50 text-blue-700 rounded">skills</span>
                    </div>
                  </div>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Можно оставить и больше информации о человеке. Теперь открываем ChatGPT и вставляем вот такой промпт:
                  </p>
                  <div className="bg-slate-800 rounded-lg p-4 mb-4 overflow-x-auto">
                    <code className="text-sm text-slate-100 whitespace-pre-wrap">Write a little compliment based on the person&apos;s latest linkedin profile information. Write in a more human way in my first person and in a more conversational style. Use &quot;you&quot; to refer to him. No more than 30 words. Example of a compliment: &quot;Hey! I&apos;ve been following your work for quite a while with XYZ company, loved the article you shared regarding your expansion to the US.&quot;

Here&apos;s the profile of the person you want to compliment:
[место для информации о лиде]</code>
                  </div>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Теперь в нашей таблице копируем целую строку со всеми данными о человеке (только не копируем саму ячейку куда будет выводится ответ, иначе будет бесконечно по кругу обновляться) и вставляем ее в конец нашего промпта в «место для информации о лиде». От результата можно убрать приветствие и самое последнее предложение по типу: «Keep up the great work!». Записываем его в новую колонку «Personalization» нашей таблицы. Должно получиться примерно так:
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white w-full">
                    <img src="/images/linkedin-personalization-table.png" alt="Пример таблицы с персонализацией" className="w-full h-auto" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Работа с англ источниками в целом */}
        <section id="english-sources" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-indigo-700 rounded-lg">
              <Globe className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Работа с англ источниками в целом</h2>
          </div>

          <div className="space-y-5">
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-indigo-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="p-2 bg-indigo-100 rounded-lg group-hover:bg-indigo-200 transition-colors">
                  <FileText className="h-5 w-5 text-indigo-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-3 text-lg">Полезные материалы</h3>
                  <div className="space-y-2">
                    <div className="flex items-start gap-2">
                      <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full mt-2"></span>
                      <p className="text-gray-700"><strong>Регламент по аполло:</strong> <a href="https://docs.google.com/document/d/1WRrcMpET3_4FATWX1shGjozDPTV-VTLA/edit#heading=h.yy5iphwlrlro" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium">Открыть документ <ExternalLink className="h-3 w-3" /></a></p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full mt-2"></span>
                      <p className="text-gray-700"><strong>Видео про работу с аполло и аутскрепер:</strong> <a href="https://drive.google.com/file/d/1Fk03xRGx6sywRU4S-WysmZEqfqB9SwIk/view?usp=share_link" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium">Смотреть видео <ExternalLink className="h-3 w-3" /></a></p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full mt-2"></span>
                      <p className="text-gray-700"><strong>Регламент по цепочкам (Notion, нужен VPN):</strong> <a href="https://sheer-practice-087.notion.site/29258a29f12c4540ab444732ae80c2f0" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium">Открыть в Notion <ExternalLink className="h-3 w-3" /></a></p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full mt-2"></span>
                      <p className="text-gray-700"><strong>Примеры цепочек на англ рынок:</strong> <a href="https://docs.google.com/document/d/1UfMvEW5XH1SaV_5YMtIFc_BCCdpvEX6ZCcjPZUP0BTA/edit#heading=h.mj8nf2lc976n" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium">Примеры заруб. офферов <ExternalLink className="h-3 w-3" /></a></p>
                    </div>
                  </div>
                  <div className="bg-amber-50 border-l-4 border-amber-400 rounded-r-md p-4 mt-4">
                    <p className="text-sm text-amber-900">
                      <span className="font-semibold">Внимание!</span> У аполло изменился интерфейс! Основные принципы работы с фильтрами остались те же - изменился процесс сохранения поисковой выборки и расположение некоторых элементов.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Как сохранять новый поиск */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-indigo-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="p-2 bg-indigo-100 rounded-lg group-hover:bg-indigo-200 transition-colors">
                  <Database className="h-5 w-5 text-indigo-600" />
                </div>
                <div className="flex-1">

              <h3 className="font-semibold text-gray-900 mb-3 text-lg">Как сохранять новый поиск</h3>
              <p className="text-gray-700 mb-3">
                Когда вы зайдете в аполло и перейдете в поиск, там сразу откроется какой-то из уже сохраненных поисков. Его редактировать нельзя, так как это чья-то выборка. Сначала нужно нажать на название выборки наверху. Выпадет список всех сохраненных поисков, там нужно будет нажать на кнопку “create saved search”, справа откроется окно настроек. Там нужно ввести название новой выборки (лучше название проекта и какие-то детали, по тому же принципу, как мы называем базы). Затем удалить существующие фильтры в новом поиске, чтобы он был без предыдущих настроек. После этого новый поиск создастся.
              </p>
              
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white hover:shadow-md transition-shadow">
                      <img src="/images/apollo-search-dropdown.png" alt="Выпадающее меню поиска Apollo" className="w-full h-auto" />
                    </div>
                    <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white hover:shadow-md transition-shadow">
                      <img src="/images/apollo-create-search.png" alt="Создание нового поиска в Apollo" className="w-full h-auto" />
                    </div>
                  </div>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white w-1/2">
                    <img src="/images/apollo-search-settings.png" alt="Настройки поиска Apollo" className="w-full h-auto" />
                  </div>
                </div>
              </div>
            </div>

            {/* Как сохранять выборки в листы */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-indigo-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="p-2 bg-indigo-100 rounded-lg group-hover:bg-indigo-200 transition-colors">
                  <FileText className="h-5 w-5 text-indigo-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-3 text-lg">Как теперь сохранять выборки в листы</h3>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white hover:shadow-md transition-shadow">
                      <img src="/images/apollo-select-number.png" alt="Выбор количества контактов" className="w-full h-auto" />
                    </div>
                    <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white hover:shadow-md transition-shadow">
                      <img src="/images/apollo-save-button.png" alt="Кнопка сохранения" className="w-full h-auto" />
                    </div>
                    <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white hover:shadow-md transition-shadow">
                      <img src="/images/apollo-save-dialog.png" alt="Диалог сохранения" className="w-full h-auto" />
                    </div>
                    <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white hover:shadow-md transition-shadow">
                      <img src="/images/apollo-save-confirmation.png" alt="Подтверждение сохранения" className="w-full h-auto" />
                    </div>
                    <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white hover:shadow-md transition-shadow md:col-span-2 w-1/2">
                      <img src="/images/apollo-lists-view.png" alt="Просмотр списков" className="w-full h-auto" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Установка анонимного браузера (для подключения к chat gpt) */}
        <section id="adspower-setup" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-8">
            <div className="p-2 bg-blue-500 rounded-lg">
              <Database className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Установка анонимного браузера (для подключения к chat gpt)</h2>
          </div>

          <div className="space-y-8">
            
            {/* Шаг 1 */}
            <div className="flex gap-4">
              <div className="flex-shrink-0 w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-bold text-lg">1</div>
              <div className="flex-grow pt-1">
                <h3 className="text-lg font-semibold text-gray-800 mb-3">Регистрация и скачивание</h3>
                <p className="text-gray-700 mb-3">
                  Перейдите по ссылке на регистрацию и скачивания браузера <a href="https://www.adspower.com/ru/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">https://www.adspower.com/ru/</a>
                </p>
                <p className="text-gray-700 mb-4">
                  Нажмите “Регистрация”. Пройдите регистрацию.
                </p>
                <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white mb-4 w-2/3">
                  <img 
                    src="/images/adspower-registration.png"
                    alt="Регистрация в AdsPower"
                    className="w-full h-auto"
                  />
                </div>
                <p className="text-gray-700">
                  После того, как вы зарегистрировали аккаунт скачайте браузер <a href="https://www.adspower.com/ru/download" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">по этой ссылке</a>. Установите его и войдите под своими данными.
                </p>
              </div>
            </div>

            {/* Шаг 2 */}
            <div className="flex gap-4">
              <div className="flex-shrink-0 w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-bold text-lg">2</div>
              <div className="flex-grow pt-1">
                <h3 className="text-lg font-semibold text-gray-800 mb-3">Настройка прокси</h3>
                <p className="text-gray-700 mb-3">
                  Войдя в браузер выберите вкладку <strong>“Прокси”</strong>.
                </p>
                <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white mb-4 w-2/3">
                  <img 
                    src="/images/adspower-proxy-tab.png"
                    alt="Вкладка Прокси в AdsPower"
                    className="w-full h-auto"
                  />
                </div>
                <p className="text-gray-700 mb-3">
                  Нажмите <strong>“Добавить прокси”</strong>. Вставьте следующие данные:
                </p>
                
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 mb-4">
                  <div className="font-mono text-sm text-slate-800 mb-2 bg-white p-2 rounded border border-slate-100">
                    154.81.199.122:63310:VtVmt51R:7GnJr2Yb
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-gray-600">
                    <div className="flex justify-between border-b border-slate-200 pb-1">
                      <span>IP:</span> <span className="font-mono text-slate-800">154.81.199.122</span>
                    </div>
                    <div className="flex justify-between border-b border-slate-200 pb-1">
                      <span>Порт:</span> <span className="font-mono text-slate-800">63310</span>
                    </div>
                    <div className="flex justify-between border-b border-slate-200 pb-1">
                      <span>Логин:</span> <span className="font-mono text-slate-800">VtVmt51R</span>
                    </div>
                    <div className="flex justify-between border-b border-slate-200 pb-1">
                      <span>Пароль:</span> <span className="font-mono text-slate-800">7GnJr2Yb</span>
                    </div>
                  </div>
                </div>

                <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white mb-4 w-2/3">
                  <img 
                    src="/images/adspower-add-proxy.png"
                    alt="Добавление прокси в AdsPower"
                    className="w-full h-auto"
                  />
                </div>
                <p className="text-gray-700">
                  После ввода данных нажмите <strong>“ОК”</strong>.
                </p>
              </div>
            </div>

            {/* Шаг 3 */}
            <div className="flex gap-4">
              <div className="flex-shrink-0 w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-bold text-lg">3</div>
              <div className="flex-grow pt-1">
                <h3 className="text-lg font-semibold text-gray-800 mb-3">Создание профиля</h3>
                <p className="text-gray-700 mb-3">
                  Нажмите <strong>“Новый профиль”</strong>.
                </p>
                <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white mb-4 w-2/3">
                  <img 
                    src="/images/adspower-new-profile.png"
                    alt="Создание нового профиля в AdsPower"
                    className="w-full h-auto"
                  />
                </div>
                <p className="text-gray-700 mb-3">
                  Пролистните чуть ниже и в поле выбора прокси выберите <strong>“сохраненные прокси”</strong>, а затем выберите тот прокси, который вы только что добавили.
                </p>
                <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white mb-4 w-2/3">
                  <img 
                    src="/images/adspower-select-proxy.png"
                    alt="Выбор прокси в AdsPower"
                    className="w-full h-auto"
                  />
                </div>
                <p className="text-gray-700">
                  После выбора прокси нажмите <strong>“Ок”</strong> для создания профиля.
                </p>
              </div>
            </div>

            {/* Шаг 4 */}
            <div className="flex gap-4">
              <div className="flex-shrink-0 w-8 h-8 bg-green-100 text-green-600 rounded-full flex items-center justify-center font-bold text-lg">4</div>
              <div className="flex-grow pt-1">
                <h3 className="text-lg font-semibold text-gray-800 mb-3">Запуск</h3>
                <p className="text-gray-700 mb-3">
                  Чтобы запустить браузер, нажмите кнопку <strong>“Открыть”</strong> напротив созданного профиля.
                </p>
                <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white mb-4 w-2/3">
                  <img 
                    src="/images/adspower-open-profile.png"
                    alt="Запуск профиля в AdsPower"
                    className="w-full h-auto"
                  />
                </div>
              </div>
            </div>

          </div>
        </section>

        {/* Как обойти запрет ВПН в РФ */}
        <section id="vpn-bypass" className="bg-white rounded-xl shadow-md border border-gray-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-emerald-600 rounded-lg">
              <Shield className="h-6 w-6 text-white" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Как обойти запрет ВПН в РФ</h2>
          </div>

          <div className="space-y-5">
            {/* Шаг 1 */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-emerald-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center font-bold text-lg group-hover:bg-emerald-200 transition-colors">1</div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Скачать расширение</h3>
                  <p className="text-gray-700 leading-relaxed">
                    Скачайте расширение <a href="https://chromewebstore.google.com/detail/proxycontrol-%D0%BC%D0%B5%D0%BD%D0%B5%D0%B4%D0%B6%D0%B5%D1%80-%D0%B4%D0%BB%D1%8F/hjocpjdeacglfchomobaagbmipeggnjg" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium">ProxyControl <ExternalLink className="h-3 w-3" /></a>
                  </p>
                </div>
              </div>
            </div>

            {/* Шаг 2 */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-emerald-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center font-bold text-lg group-hover:bg-emerald-200 transition-colors">2</div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Найти свой прокси</h3>
                  <p className="text-gray-700 leading-relaxed">
                    Найдите в этой таблице своё имя и скопируйте содержимое столбца &quot;Информация о Прокси&quot; в <a href="https://docs.google.com/spreadsheets/d/14EJWqsVsikR2agW2c-Z66J1IHK5Ep05u5uR3Wy1cwBc/edit?usp=sharing" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium">Таблица прокси <ExternalLink className="h-3 w-3" /></a>
                  </p>
                </div>
              </div>
            </div>

            {/* Шаг 3 */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-emerald-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center font-bold text-lg group-hover:bg-emerald-200 transition-colors">3</div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Открыть настройки</h3>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Откройте расширение и нажмите на &quot;Перейти к настройкам&quot;
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white w-1/2">
                    <img 
                      src="/images/proxy-settings.png"
                      alt="Настройки прокси расширения"
                      className="w-full h-auto"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Шаг 4 */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-emerald-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center font-bold text-lg group-hover:bg-emerald-200 transition-colors">4</div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Добавить прокси</h3>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    На появившейся странице вставьте скопированные данные о прокси в &quot;добавить новый прокси&quot; и нажмите кнопку &quot;добавить новый прокси&quot;
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white w-1/2">
                    <img 
                      src="/images/proxy-add.png"
                      alt="Добавление нового прокси"
                      className="w-full h-auto"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Шаг 5 */}
            <div className="group border border-gray-200 rounded-lg p-5 hover:border-emerald-300 hover:shadow-md transition-all duration-200 bg-gray-50">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center font-bold text-lg group-hover:bg-emerald-200 transition-colors">5</div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Выбрать и включить прокси</h3>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Выберите добавленный прокси
                  </p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white mb-4 w-1/2">
                    <img 
                      src="/images/proxy-select.png"
                      alt="Выбор прокси"
                      className="w-full h-auto"
                    />
                  </div>
                  <p className="text-gray-700 leading-relaxed mb-3">
                    Нажмите &quot;включить прокси&quot;
                  </p>
                  <p className="text-gray-700 leading-relaxed">
                    Проверьте работает ли прокси зайдя на заблокированный в рф сайт или проверьте айпи в <a href="https://2ip.ru" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1 font-medium">https://2ip.ru <ExternalLink className="h-3 w-3" /></a>
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Рекомендации по оптимизации рабочих процессов */}
        <section id="workflow-optimization" className="relative overflow-hidden rounded-2xl shadow-xl border border-purple-200">
          {/* Декоративный градиентный фон */}
          <div className="absolute inset-0 bg-gradient-to-br from-purple-50 via-white to-indigo-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-purple-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          <div className="absolute bottom-0 left-0 w-64 h-64 bg-gradient-to-tr from-indigo-200/30 to-transparent rounded-full blur-3xl translate-y-1/2 -translate-x-1/2"></div>
          
          <div className="relative p-8">
            {/* Заголовок секции */}
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-purple-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-purple-600 to-indigo-600 rounded-xl shadow-lg">
                  <CheckCircle2 className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-purple-700 to-indigo-700 bg-clip-text text-transparent">
                  Рекомендации по оптимизации рабочих процессов
                </h2>
                <p className="text-sm text-gray-500 mt-1">Советы для повышения эффективности вашей работы</p>
              </div>
            </div>

            <div className="space-y-4">
            {/* Общая рекомендация */}
            <div className="group relative bg-white/80 backdrop-blur-sm border border-purple-100 rounded-xl p-5 hover:border-purple-300 hover:shadow-lg hover:shadow-purple-100/50 transition-all duration-300">
              <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-purple-500 to-indigo-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0">
                  <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-purple-100 to-indigo-100 rounded-xl group-hover:from-purple-200 group-hover:to-indigo-200 transition-colors shadow-sm">
                    <AlertCircle className="h-5 w-5 text-purple-600" />
                  </div>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="px-2 py-0.5 text-xs font-semibold bg-purple-100 text-purple-700 rounded-full">Важно</span>
                    <h3 className="font-semibold text-gray-900 text-lg">Используйте нейросети</h3>
                  </div>
                  <p className="text-gray-600 leading-relaxed mb-4">
                    Общая рекомендация - не стесняйтесь обращаться к нейросетям за ЛЮБОЙ ПОМОЩЬЮ, помните, если какую-то задачу можно автоматизировать нейросети ваш лучший друг.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <a href="https://chatgpt.com" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200 rounded-lg text-purple-700 hover:from-purple-100 hover:to-indigo-100 hover:border-purple-300 transition-all font-medium text-sm shadow-sm">ChatGPT <ExternalLink className="h-3.5 w-3.5" /></a>
                    <a href="https://aistudio.google.com" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200 rounded-lg text-purple-700 hover:from-purple-100 hover:to-indigo-100 hover:border-purple-300 transition-all font-medium text-sm shadow-sm">Google AI Studio <ExternalLink className="h-3.5 w-3.5" /></a>
                  </div>
                </div>
              </div>
            </div>

            {/* Помощник по работе */}
            <div className="group relative bg-white/80 backdrop-blur-sm border border-purple-100 rounded-xl p-5 hover:border-purple-300 hover:shadow-lg hover:shadow-purple-100/50 transition-all duration-300">
              <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-purple-500 to-indigo-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0">
                  <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-purple-100 to-indigo-100 rounded-xl group-hover:from-purple-200 group-hover:to-indigo-200 transition-colors shadow-sm">
                    <BookOpen className="h-5 w-5 text-purple-600" />
                  </div>
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Помощник по работе</h3>
                  <p className="text-gray-600 leading-relaxed">
                    Вы можете воспользоваться промтом, в который загружен регламент + этот промт подскажет как возможно решить вашу проблему. <a href="https://aistudio.google.com/app/prompts?state=%7B%22ids%22:%5B%2211rLQ7FGpT1lY8SH8U3IDj9_neuCMXdiG%22%5D,%22action%22:%22open%22,%22userId%22:%22103961347993105628535%22,%22resourceKeys%22:%7B%7D%7D&usp=sharing" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 mt-2 bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200 rounded-lg text-purple-700 hover:from-purple-100 hover:to-indigo-100 hover:border-purple-300 transition-all font-medium text-sm shadow-sm">Промт помощника <ExternalLink className="h-3.5 w-3.5" /></a>
                  </p>
                </div>
              </div>
            </div>

            {/* Чистка базы */}
            <div className="group relative bg-white/80 backdrop-blur-sm border border-purple-100 rounded-xl p-5 hover:border-purple-300 hover:shadow-lg hover:shadow-purple-100/50 transition-all duration-300">
              <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-purple-500 to-indigo-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0">
                  <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-purple-100 to-indigo-100 rounded-xl group-hover:from-purple-200 group-hover:to-indigo-200 transition-colors shadow-sm">
                    <Database className="h-5 w-5 text-purple-600" />
                  </div>
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Чистка базы: Очистка сайтов до доменов</h3>
                  <p className="text-gray-600 leading-relaxed mb-4">
                    Выделите столбец с сайтами, который нужно обработать в домены. И примените скрипт:
                  </p>
                  <div className="border border-purple-100 rounded-xl overflow-hidden shadow-md bg-white w-2/3 group-hover:shadow-lg transition-shadow">
                    <img 
                      src="/images/domain-cleanup-script.png"
                      alt="Скрипт для очистки сайтов до доменов"
                      className="w-full h-auto"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Сопоставление компаний */}
            <div className="group relative bg-white/80 backdrop-blur-sm border border-purple-100 rounded-xl p-5 hover:border-purple-300 hover:shadow-lg hover:shadow-purple-100/50 transition-all duration-300">
              <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-purple-500 to-indigo-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0">
                  <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-purple-100 to-indigo-100 rounded-xl group-hover:from-purple-200 group-hover:to-indigo-200 transition-colors shadow-sm">
                    <FileText className="h-5 w-5 text-purple-600" />
                  </div>
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-3 text-lg">Сопоставление названий компаний с email по сайтам</h3>
                  <p className="text-gray-600 leading-relaxed mb-3">
                    Чтобы быстро сопоставить email с названиями, поместите в:
                  </p>
                  <div className="bg-gradient-to-r from-purple-50/50 to-indigo-50/50 rounded-lg p-4 mb-4 border border-purple-100">
                    <ul className="space-y-2">
                      <li className="flex items-center gap-3 text-gray-700"><span className="w-6 h-6 flex items-center justify-center bg-purple-500 text-white text-xs font-bold rounded-md">A</span>названия</li>
                      <li className="flex items-center gap-3 text-gray-700"><span className="w-6 h-6 flex items-center justify-center bg-purple-500 text-white text-xs font-bold rounded-md">B</span>ссылки</li>
                      <li className="flex items-center gap-3 text-gray-700"><span className="w-6 h-6 flex items-center justify-center bg-purple-500 text-white text-xs font-bold rounded-md">D</span>почты, полученные после парсинга</li>
                      <li className="flex items-center gap-3 text-gray-700"><span className="w-6 h-6 flex items-center justify-center bg-purple-500 text-white text-xs font-bold rounded-md">E</span>домены на которых были найдены почты при парсинге</li>
                    </ul>
                  </div>
                  <p className="text-gray-600 leading-relaxed mb-3">Вот как это должно выглядеть:</p>
                  <div className="border border-purple-100 rounded-xl overflow-hidden shadow-md bg-white mb-4 w-2/3 group-hover:shadow-lg transition-shadow">
                    <img src="/images/company-email-table.png" alt="Пример таблицы для сопоставления" className="w-full h-auto" />
                  </div>
                  <p className="text-gray-600 leading-relaxed mb-3">
                    После, примените скрипт для сопоставления, он перенесет названия из столбца A в столбец F в соответствии с доменами из столбцов B и E
                  </p>
                  <div className="border border-purple-100 rounded-xl overflow-hidden shadow-md bg-white mb-4 w-2/3 group-hover:shadow-lg transition-shadow">
                    <img src="/images/matching-script.png" alt="Скрипт для сопоставления компаний" className="w-full h-auto" />
                  </div>
                  <p className="text-gray-600 leading-relaxed mb-3">Итог работы скрипта:</p>
                  <div className="border border-purple-100 rounded-xl overflow-hidden shadow-md bg-white w-2/3 group-hover:shadow-lg transition-shadow">
                    <img src="/images/matching-result.png" alt="Результат работы скрипта" className="w-full h-auto" />
                  </div>
                </div>
              </div>
            </div>

            {/* Сокращение названий */}
            <div className="group relative bg-white/80 backdrop-blur-sm border border-purple-100 rounded-xl p-5 hover:border-purple-300 hover:shadow-lg hover:shadow-purple-100/50 transition-all duration-300">
              <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-purple-500 to-indigo-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0">
                  <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-purple-100 to-indigo-100 rounded-xl group-hover:from-purple-200 group-hover:to-indigo-200 transition-colors shadow-sm">
                    <FileText className="h-5 w-5 text-purple-600" />
                  </div>
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-2 text-lg">Сокращение названий</h3>
                  <p className="text-gray-600 leading-relaxed mb-3">
                    Чтобы быстро сократить названия и привести их нужный формат для рассылки используйте этот промт gemini - сейчас работает очень круто! (если работает плохо, или названия это длинное описание, то вставляйте по 300 строк за раз)
                  </p>
                  <div className="mb-4">
                    <a href="https://aistudio.google.com/app/prompts?state=%7B%22ids%22:%5B%221Vqgv-oZNratrt5i07UVoMprUEAC2wbx2%22%5D,%22action%22:%22open%22,%22userId%22:%22103961347993105628535%22,%22resourceKeys%22:%7B%7D%7D&usp=sharing" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200 rounded-lg text-purple-700 hover:from-purple-100 hover:to-indigo-100 hover:border-purple-300 transition-all font-medium text-sm shadow-sm">Промт для сокращения названий <ExternalLink className="h-3.5 w-3.5" /></a>
                  </div>
                  <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-3 mb-4">
                    <p className="text-amber-800 text-sm flex items-start gap-2">
                      <span className="text-amber-500 mt-0.5">💡</span>
                      Для использования поставьте модель Gemini 2.0 flash (также можете экспериментировать с другими версиями языковой модели)
                    </p>
                  </div>
                  <div className="border border-purple-100 rounded-xl overflow-hidden shadow-md bg-white w-2/3 group-hover:shadow-lg transition-shadow">
                    <img src="/images/name-shortening.png" alt="Настройка модели Gemini для сокращения названий" className="w-full h-auto" />
                  </div>
                </div>
              </div>
            </div>

            {/* Написание оффера */}
            <div className="group relative bg-white/80 backdrop-blur-sm border border-purple-100 rounded-xl p-5 hover:border-purple-300 hover:shadow-lg hover:shadow-purple-100/50 transition-all duration-300">
              <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-purple-500 to-indigo-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0">
                  <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-purple-100 to-indigo-100 rounded-xl group-hover:from-purple-200 group-hover:to-indigo-200 transition-colors shadow-sm">
                    <Mail className="h-5 w-5 text-purple-600" />
                  </div>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="font-semibold text-gray-900 text-lg">Написание оффера</h3>
                    <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded-full">Обновлено</span>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">Обновленный промт джемини для написания цепочки</p>
                  <p className="text-gray-600 leading-relaxed mb-4">
                    Сейчас нейросети могут практически за вас написать оффер, или дать основу для оффера и идеи для него. В этом промте вы также можете просить модель улучшить или что-то переработать.
                  </p>
                  <div className="mb-4">
                    <a href="https://aistudio.google.com/app/prompts?state=%7B%22ids%22:%5B%221nuzMhi8pHPInt8QXomt9AO3g-aeVG053%22%5D,%22action%22:%22open%22,%22userId%22:%22112464031614056669260%22,%22resourceKeys%22:%7B%7D%7D&usp=sharing" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200 rounded-lg text-purple-700 hover:from-purple-100 hover:to-indigo-100 hover:border-purple-300 transition-all font-medium text-sm shadow-sm">Промт для написания оффера <ExternalLink className="h-3.5 w-3.5" /></a>
                  </div>
                  <div className="border border-purple-100 rounded-xl overflow-hidden shadow-md bg-white mb-4 w-2/3 group-hover:shadow-lg transition-shadow">
                    <img src="/images/offer-writing.png" alt="Интерфейс написания оффера в Gemini" className="w-full h-auto" />
                  </div>
                  <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-4 mb-3">
                    <p className="text-gray-700 text-sm leading-relaxed">
                      Полученный оффер вы также можете попробовать улучшить через <a href="https://chatgpt.com" target="_blank" rel="noopener noreferrer" className="text-purple-700 font-medium hover:text-purple-800">ChatGPT</a> использовав новую модель o-1 (но число запросов ограничено так что используйте 1-2 запроса на o-1, а потом переходите на модель 4о), запросив: <span className="font-medium text-gray-800">&quot;Изучи бриф и улучши мои письма для цепочки аутрич писем&quot;</span> и приложите бриф с вашей цепочкой
                    </p>
                  </div>
                  <p className="text-gray-600 leading-relaxed">
                    Также можете запросить нейросети предложить идеи для вашего оффера
                  </p>
                </div>
              </div>
            </div>

            {/* Ответы на письма */}
            <div className="group relative bg-white/80 backdrop-blur-sm border border-purple-100 rounded-xl p-5 hover:border-purple-300 hover:shadow-lg hover:shadow-purple-100/50 transition-all duration-300">
              <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-purple-500 to-indigo-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0">
                  <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-purple-100 to-indigo-100 rounded-xl group-hover:from-purple-200 group-hover:to-indigo-200 transition-colors shadow-sm">
                    <Mail className="h-5 w-5 text-purple-600" />
                  </div>
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 mb-3 text-lg">Ответы на письма: Использование макросов</h3>
                  <p className="text-gray-600 leading-relaxed mb-4">
                    Для того, чтобы быстро и эффективно отвечать на письма, пользуйтесь функцией макросов
                  </p>
                  <div className="border border-purple-100 rounded-xl overflow-hidden shadow-md bg-white mb-4 w-2/3 group-hover:shadow-lg transition-shadow">
                    <img src="/images/reply-macro-button.png" alt="Кнопка Reply Macro в интерфейсе Unibox" className="w-full h-auto" />
                  </div>
                  <p className="text-gray-600 leading-relaxed mb-4">
                    И нажмите создать, &quot;create&quot;
                  </p>
                  <div className="border border-purple-100 rounded-xl overflow-hidden shadow-md bg-white mb-4 w-2/3 group-hover:shadow-lg transition-shadow">
                    <img src="/images/reply-macros-create.png" alt="Окно создания макроса" className="w-full h-auto" />
                  </div>
                  <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-4 mb-4">
                    <p className="text-amber-800 text-sm leading-relaxed">
                      <span className="font-semibold">Совет:</span> В сообщении можете использовать переменные и email, куда должна идти пересылка, чтобы постоянно не указывать её. Можете сделать несколько шаблонов, например, один на обычные ответы, второй для пересылки, <span className="font-medium">НО обязательно перепроверяйте правильно встали ваши переменные</span>, такие как названия компании, имя и т.д
                    </p>
                  </div>
                  <div className="border border-purple-100 rounded-xl overflow-hidden shadow-md bg-white mb-4 w-2/3 group-hover:shadow-lg transition-shadow">
                    <img src="/images/create-macro.png" alt="Создание нового макроса с переменными" className="w-full h-auto" />
                  </div>
                  <p className="text-gray-600 leading-relaxed mb-4">
                    После нажимайте, &quot;Save&quot; и можете использовать ваш макрос, найдя его в общем поиске
                  </p>
                  <div className="border border-purple-100 rounded-xl overflow-hidden shadow-md bg-white w-2/3 group-hover:shadow-lg transition-shadow">
                    <img src="/images/macro-list.png" alt="Список макросов для использования" className="w-full h-auto" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        </section>

        {/* Инстантли фишки */}
        <section id="instantly-tips" className="relative overflow-hidden rounded-2xl shadow-xl border border-orange-200">
          <div className="absolute inset-0 bg-gradient-to-br from-orange-50 via-white to-amber-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-orange-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-orange-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-orange-500 to-amber-500 rounded-xl shadow-lg">
                  <Zap className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-orange-600 to-amber-600 bg-clip-text text-transparent">
                  Инстантли фишки
                </h2>
                <p className="text-sm text-gray-500 mt-1">Полезные функции и лайфхаки для работы с Instantly</p>
              </div>
            </div>

            <div className="space-y-6">
              {/* Увеличить открываемость */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-orange-100 rounded-xl p-6 hover:border-orange-300 hover:shadow-lg hover:shadow-orange-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-orange-500 to-amber-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-orange-100 to-amber-100 rounded-xl group-hover:from-orange-200 group-hover:to-amber-200 transition-colors shadow-sm">
                      <Sparkles className="h-5 w-5 text-orange-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Увеличить открываемость</h3>
                    <p className="text-gray-600 leading-relaxed mb-4">
                      Сделать это можно с помощью автоматической рандомизации частей письма.
                    </p>
                    
                    <div className="rounded-xl overflow-hidden mb-4 border border-orange-200 shadow-sm">
                      <img 
                        src="/images/instantly-ai-spintax-menu.png" 
                        alt="AI Tools меню в Instantly с выбором AI Spintax Writer"
                        className="w-full h-auto"
                      />
                    </div>

                    <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-4 mb-4">
                      <p className="text-amber-800 text-sm leading-relaxed">
                        <span className="font-semibold">Выберите &quot;AI Spintax Writer&quot;</span> — эта функция автоматически найдёт части письма, которые можно разбавить несколькими синонимичными фразами, что очень снижает фактор спама.
                      </p>
                    </div>

                    <div className="bg-gradient-to-r from-red-50 to-orange-50 border border-red-200 rounded-lg p-4 mb-4">
                      <p className="text-red-700 text-sm leading-relaxed flex items-start gap-2">
                        <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                        <span><span className="font-semibold">ОБЯЗАТЕЛЬНО</span> перечитайте что вышло в итоге и удалите неграмотные варианты!</span>
                      </p>
                    </div>

                    <p className="text-gray-600 leading-relaxed mb-4">Как выглядит в итоге:</p>
                    
                    <div className="rounded-xl overflow-hidden mb-4 border border-orange-200 shadow-sm">
                      <img 
                        src="/images/instantly-spintax-result-new.png" 
                        alt="Результат работы AI Spintax Writer с вариантами текста"
                        className="w-full h-auto"
                      />
                    </div>

                    <p className="text-gray-600 leading-relaxed">
                      При отправлении будут случайным образом использоваться разные части синонимичных фраз. Через кнопку <span className="font-medium text-gray-800">Preview</span> можете посмотреть на результат — при каждом новом нажатии будет по сути новое сообщение.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Проверка на доставляемость */}
        <section id="deliverability-check" className="relative overflow-hidden rounded-2xl shadow-xl border border-emerald-200">
          <div className="absolute inset-0 bg-gradient-to-br from-emerald-50 via-white to-teal-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-emerald-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-emerald-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-emerald-500 to-teal-500 rounded-xl shadow-lg">
                  <ShieldAlert className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-transparent">
                  Проверка на доставляемость
                </h2>
                <p className="text-sm text-gray-500 mt-1">Инструменты диагностики проблем с отправкой писем</p>
              </div>
            </div>

            <div className="space-y-6">
              {/* Проверка домена на блок-листы */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-emerald-100 rounded-xl p-6 hover:border-emerald-300 hover:shadow-lg hover:shadow-emerald-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-emerald-500 to-teal-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-emerald-100 to-teal-100 rounded-xl group-hover:from-emerald-200 group-hover:to-teal-200 transition-colors shadow-sm">
                      <Shield className="h-5 w-5 text-emerald-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Проверка домена на наличие в блок-листах</h3>
                    
                    <div className="mb-4">
                      <a href="https://dnschecker.org/ip-blacklist-checker.php" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200 rounded-lg text-emerald-700 hover:from-emerald-100 hover:to-teal-100 hover:border-emerald-300 transition-all font-medium text-sm shadow-sm">
                        dnschecker.org/ip-blacklist-checker <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>

                    <p className="text-gray-600 leading-relaxed mb-4">
                      Вставьте почту или её домен, а затем нажмите <span className="font-medium text-gray-800">&quot;Check in Blacklist&quot;</span>
                    </p>

                    <div className="rounded-xl overflow-hidden mb-4 border border-emerald-200 shadow-sm">
                      <img 
                        src="/images/blacklist-checker.png" 
                        alt="Проверка домена на блок-листы через DNSChecker"
                        className="w-full h-auto"
                      />
                    </div>

                    <p className="text-gray-600 leading-relaxed mb-4">
                      Затем нажмите на предложенный IP адрес — вам покажет список сервисов, в которых сервер числится в блок-листах.
                    </p>

                    <div className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-lg p-4">
                      <p className="text-green-800 text-sm leading-relaxed">
                        Если сервер находится только в блоке <span className="font-mono bg-green-100 px-1 rounded">dnsbl-3.uceprotect.net</span> — то ничего страшного. В остальных случаях пишите в поломки.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Проверка системных сообщений */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-emerald-100 rounded-xl p-6 hover:border-emerald-300 hover:shadow-lg hover:shadow-emerald-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-emerald-500 to-teal-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-emerald-100 to-teal-100 rounded-xl group-hover:from-emerald-200 group-hover:to-teal-200 transition-colors shadow-sm">
                      <Server className="h-5 w-5 text-emerald-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Проверка системных сообщений на почтовых ящиках</h3>
                    
                    <p className="text-gray-600 leading-relaxed mb-4">
                      Для этого нужно узнать на каком сервере располагается почтовый ящик. Перейдите на dnschecker и посмотрите hostname — это и есть сервер.
                    </p>

                    <div className="rounded-xl overflow-hidden mb-4 border border-emerald-200 shadow-sm">
                      <img 
                        src="/images/hostname-check.png" 
                        alt="Проверка hostname в DNS Checker"
                        className="w-full h-auto"
                      />
                    </div>

                    <p className="text-gray-600 leading-relaxed mb-3">Выберите из списка подходящий сервер:</p>
                    
                    <div className="bg-gradient-to-r from-emerald-50/50 to-teal-50/50 rounded-lg p-4 mb-4 border border-emerald-100">
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <a href="https://smtp.agencyplz.ru/SOGo/" target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:text-emerald-800 hover:underline">smtp.agencyplz.ru</a>
                        <a href="https://smtp.solarcascade.ru/SOGo/" target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:text-emerald-800 hover:underline">smtp.solarcascade.ru</a>
                        <a href="https://smtp.lunarquartz.ru/SOGo/" target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:text-emerald-800 hover:underline">smtp.lunarquartz.ru</a>
                        <a href="https://smtp.trovena.ru/SOGo/" target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:text-emerald-800 hover:underline">smtp.trovena.ru</a>
                        <a href="https://smtp.yoltina.ru/SOGo/" target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:text-emerald-800 hover:underline">smtp.yoltina.ru</a>
                        <a href="https://smtp.zonvica.ru/SOGo/" target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:text-emerald-800 hover:underline">smtp.zonvica.ru</a>
                        <a href="https://smtp.korluna.ru/SOGo/" target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:text-emerald-800 hover:underline">smtp.korluna.ru</a>
                        <a href="https://smtp.inoutreach.ru/SOGo/" target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:text-emerald-800 hover:underline">smtp.inoutreach.ru</a>
                        <a href="https://smtp.letoutreach.ru/SOGo/" target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:text-emerald-800 hover:underline">smtp.letoutreach.ru</a>
                        <a href="https://smtp.outreachgo.ru/SOGo/" target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:text-emerald-800 hover:underline">smtp.outreachgo.ru</a>
                        <a href="https://smtp.letsoutreach.ru/SOGo/" target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:text-emerald-800 hover:underline">smtp.letsoutreach.ru</a>
                        <a href="https://smtp.polzagency.ru/SOGo/" target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:text-emerald-800 hover:underline">smtp.polzagency.ru</a>
                        <a href="https://smtp.outreachhub.ru/SOGo/" target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:text-emerald-800 hover:underline">smtp.outreachhub.ru</a>
                        <a href="https://smtp.outreachpros.ru/SOGo/" target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:text-emerald-800 hover:underline">smtp.outreachpros.ru</a>
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mb-4">
                      <p className="text-gray-700 text-sm">
                        <span className="font-semibold">Логин:</span> сама почта<br/>
                        <span className="font-semibold">Пароль для всех:</span> <span className="font-mono bg-slate-100 px-1 rounded">rd&amp;F=n&amp;X%=6X3gJ%</span>
                      </p>
                    </div>

                    <p className="text-gray-600 leading-relaxed mb-4">
                      В почтовом ящике вам нужно смотреть наличие писем <span className="font-medium text-gray-800">&quot;Mail Delivery System&quot;</span>
                    </p>

                    <div className="bg-gradient-to-r from-red-50 to-orange-50 border border-red-200 rounded-lg p-4">
                      <p className="text-red-700 text-sm leading-relaxed flex items-start gap-2">
                        <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                        <span>Если таких писем очень много — сообщайте в поломки, это значит что письма в принципе не отправились.</span>
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Низкая доставляемость и мало ответов */}
        <section id="low-deliverability" className="relative overflow-hidden rounded-2xl shadow-xl border border-rose-200">
          <div className="absolute inset-0 bg-gradient-to-br from-rose-50 via-white to-pink-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-rose-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-rose-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-rose-500 to-pink-500 rounded-xl shadow-lg">
                  <BarChart3 className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-rose-600 to-pink-600 bg-clip-text text-transparent">
                  Низкая доставляемость и мало ответов
                </h2>
                <p className="text-sm text-gray-500 mt-1">Чек-лист для диагностики проблем</p>
              </div>
            </div>

            <div className="bg-white/80 backdrop-blur-sm border border-rose-100 rounded-xl p-6">
              <p className="text-gray-600 mb-6">Если у вас низкая доставляемость или мало ответов, проверьте следующее:</p>
              
              <div className="space-y-4">
                <div className="flex items-start gap-3 p-4 bg-gradient-to-r from-rose-50/50 to-pink-50/50 rounded-lg border border-rose-100">
                  <div className="w-6 h-6 flex items-center justify-center bg-rose-500 text-white text-xs font-bold rounded-md flex-shrink-0">1</div>
                  <div>
                    <p className="text-gray-700">Проверьте живой ли домен через <a href="https://dnschecker.org/all-dns-records-of-domain.php" target="_blank" rel="noopener noreferrer" className="text-rose-600 hover:text-rose-800 hover:underline font-medium">dnschecker.org</a></p>
                    <p className="text-gray-500 text-sm mt-1">Проверьте наличие MX записи и TXT записей</p>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-4 bg-gradient-to-r from-rose-50/50 to-pink-50/50 rounded-lg border border-rose-100">
                  <div className="w-6 h-6 flex items-center justify-center bg-rose-500 text-white text-xs font-bold rounded-md flex-shrink-0">2</div>
                  <p className="text-gray-700">Проверьте не истёк ли срок аренды домена в <a href="https://reg.ru" target="_blank" rel="noopener noreferrer" className="text-rose-600 hover:text-rose-800 hover:underline font-medium">reg.ru</a></p>
                </div>

                <div className="flex items-start gap-3 p-4 bg-gradient-to-r from-rose-50/50 to-pink-50/50 rounded-lg border border-rose-100">
                  <div className="w-6 h-6 flex items-center justify-center bg-rose-500 text-white text-xs font-bold rounded-md flex-shrink-0">3</div>
                  <p className="text-gray-700">Проверьте стоит ли зелёный огонёк у почты, проверьте не ниже ли <span className="font-semibold">85</span> здоровье почты</p>
                </div>

                <div className="flex items-start gap-3 p-4 bg-gradient-to-r from-rose-50/50 to-pink-50/50 rounded-lg border border-rose-100">
                  <div className="w-6 h-6 flex items-center justify-center bg-rose-500 text-white text-xs font-bold rounded-md flex-shrink-0">4</div>
                  <p className="text-gray-700">Проверьте не заблокировали ли почту в Google Workspace воспользовавшись поиском</p>
                </div>

                <div className="flex items-start gap-3 p-4 bg-gradient-to-r from-rose-50/50 to-pink-50/50 rounded-lg border border-rose-100">
                  <div className="w-6 h-6 flex items-center justify-center bg-rose-500 text-white text-xs font-bold rounded-md flex-shrink-0">5</div>
                  <p className="text-gray-700">Проверьте валидирована ли база в LetsExtract <span className="text-rose-600 font-medium">или в нашей собственной программе (результат лучше)</span></p>
                </div>

                <div className="flex items-start gap-3 p-4 bg-gradient-to-r from-rose-50/50 to-pink-50/50 rounded-lg border border-rose-100">
                  <div className="w-6 h-6 flex items-center justify-center bg-rose-500 text-white text-xs font-bold rounded-md flex-shrink-0">6</div>
                  <p className="text-gray-700">Перепроверьте источники базы — зачастую базы из Селеком, РБК и прочие могут оказаться не совсем свежими</p>
                </div>

                <div className="flex items-start gap-3 p-4 bg-gradient-to-r from-rose-50/50 to-pink-50/50 rounded-lg border border-rose-100">
                  <div className="w-6 h-6 flex items-center justify-center bg-rose-500 text-white text-xs font-bold rounded-md flex-shrink-0">7</div>
                  <p className="text-gray-700">Проверьте письмо на наличие сломанных ссылок и прочих признаков спама через внутреннюю проверку письма в Instantly</p>
                </div>
              </div>

              {/* Placeholder для картинки */}
              <div className="border-2 border-dashed border-rose-200 rounded-xl p-8 my-6 bg-rose-50/50 text-center">
                <ImageIcon className="h-8 w-8 text-rose-300 mx-auto mb-2" />
                <p className="text-sm text-rose-400">Картинка: instantly-spam-check.png</p>
              </div>

              <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-4 mb-4">
                <p className="text-amber-800 text-sm leading-relaxed">
                  <span className="font-semibold">Совет:</span> Если у вас маленький счёт, не переживайте — просто посмотрите за что вам его дали. Иногда Instantly ругается на домены <span className="font-mono">.online</span>, но они не влияют на рассылку.
                </p>
              </div>

              <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-4">
                <p className="text-blue-800 text-sm leading-relaxed">
                  <span className="font-semibold">Лайфхак:</span> Иногда может быть такое, что в вашем письме много русских букв &quot;е&quot;, которые могут плохо восприниматься. В таком случае замените русские &quot;е&quot; на английские &quot;e&quot;.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Ошибки и чего нельзя делать */}
        <section id="common-errors" className="relative overflow-hidden rounded-2xl shadow-xl border border-red-200">
          <div className="absolute inset-0 bg-gradient-to-br from-red-50 via-white to-orange-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-red-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-red-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-red-500 to-orange-500 rounded-xl shadow-lg">
                  <Ban className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-red-600 to-orange-600 bg-clip-text text-transparent">
                  Ошибки и чего нельзя делать
                </h2>
                <p className="text-sm text-gray-500 mt-1">Важные ограничения и запреты при работе</p>
              </div>
            </div>

            <div className="space-y-4">
              {/* Ошибка 1 */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-red-100 rounded-xl p-5 hover:border-red-300 hover:shadow-lg hover:shadow-red-100/50 transition-all duration-300">
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 flex items-center justify-center bg-red-500 text-white font-bold rounded-lg flex-shrink-0">1</div>
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-2">Смена почтовых адресов во время рассылки</h3>
                    <p className="text-gray-600 text-sm leading-relaxed">
                      Нельзя изменять почтовые адреса во время начатой рассылки, т.к. заново начнут высылаться письма по уже отправленным лидам и система не сможет отслеживать тех, кто ответил, чтобы перестать отправлять дальше.
                    </p>
                  </div>
                </div>
              </div>

              {/* Ошибка 2 */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-red-100 rounded-xl p-5 hover:border-red-300 hover:shadow-lg hover:shadow-red-100/50 transition-all duration-300">
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 flex items-center justify-center bg-red-500 text-white font-bold rounded-lg flex-shrink-0">2</div>
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-2">Загрузка на фотостоки запрещённых фото</h3>
                    <p className="text-gray-600 text-sm leading-relaxed">
                      Следует отслеживать, отправляются ли фотографии в отправленных сообщениях. Иногда сервисы, предоставляющие ссылки на картинки, могут удалять фотографии за несоблюдение правил. Например, за загрузку табачной продукции. Тогда следует загрузить фотографию на <span className="font-medium">imgur</span>.
                    </p>
                  </div>
                </div>
              </div>

              {/* Ошибка 3 */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-red-100 rounded-xl p-5 hover:border-red-300 hover:shadow-lg hover:shadow-red-100/50 transition-all duration-300">
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 flex items-center justify-center bg-red-500 text-white font-bold rounded-lg flex-shrink-0">3</div>
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-2">Прикрепление ссылок к фотографии в Instantly</h3>
                    <p className="text-gray-600 text-sm leading-relaxed">
                      Нельзя добавлять ссылку в саму фотографию в редакторе цепочек сообщений. Вместо этого в письмах просто будет пустое место.
                    </p>
                  </div>
                </div>
              </div>

              {/* Ошибка 4 - Просит номер телефона */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-red-100 rounded-xl p-5 hover:border-red-300 hover:shadow-lg hover:shadow-red-100/50 transition-all duration-300">
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 flex items-center justify-center bg-red-500 text-white font-bold rounded-lg flex-shrink-0">4</div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-2">Просит номер телефона при входе в аккаунт Google</h3>
                    <p className="text-gray-600 text-sm leading-relaxed mb-4">
                      Если при попытке входа в аккаунт высвечивается запрос на номер телефона <span className="text-gray-500">(после нескольких использований одного и того же номера он блокируется)</span>, необходимо:
                    </p>
                    
                    <div className="space-y-3 text-sm">
                      <div className="flex items-start gap-2">
                        <span className="text-red-500 font-medium">1.</span>
                        <p className="text-gray-700">Зайти в аккаунт Google Workspace во вкладку <span className="font-medium">Каталог → Организационные подразделения</span> и нажать кнопку <span className="font-medium">&quot;Создать подразделение&quot;</span></p>
                      </div>
                      
                      {/* Placeholder для картинки */}
                      <div className="border-2 border-dashed border-red-200 rounded-xl p-6 bg-red-50/50 text-center">
                        <ImageIcon className="h-6 w-6 text-red-300 mx-auto mb-2" />
                        <p className="text-xs text-red-400">Картинка: google-workspace-org.png</p>
                      </div>

                      <div className="flex items-start gap-2">
                        <span className="text-red-500 font-medium">2.</span>
                        <p className="text-gray-700">Нажать на поисковую строку и вписать <span className="font-medium">&quot;Двухэтапная аутентификация&quot;</span></p>
                      </div>

                      <div className="flex items-start gap-2">
                        <span className="text-red-500 font-medium">3.</span>
                        <p className="text-gray-700">Выбрать подразделение, <span className="font-medium">включить</span> двухэтапную аутентификацию и <span className="font-medium">сохранить</span></p>
                      </div>

                      <div className="flex items-start gap-2">
                        <span className="text-red-500 font-medium">4.</span>
                        <p className="text-gray-700">Перейти во вкладку <span className="font-medium">Каталог → Пользователи</span>, найти пользователя, нажать <span className="font-medium">&quot;Ещё&quot;</span> → <span className="font-medium">&quot;Изменить орг. подразделение&quot;</span></p>
                      </div>

                      <div className="flex items-start gap-2">
                        <span className="text-red-500 font-medium">5.</span>
                        <p className="text-gray-700">Нажать на пользователя → блок <span className="font-medium">&quot;Безопасность&quot;</span> → <span className="font-medium">&quot;Двухэтапная аутентификация&quot;</span> → карандаш</p>
                      </div>

                      <div className="flex items-start gap-2">
                        <span className="text-red-500 font-medium">6.</span>
                        <p className="text-gray-700">Нажать <span className="font-medium">&quot;Сгенерировать коды подтверждения&quot;</span> и скопировать любой код</p>
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-4 mt-4">
                      <p className="text-amber-800 text-sm leading-relaxed">
                        <span className="font-semibold">Совет:</span> Для быстрого входа можно привязать <span className="font-medium">Google Authenticator</span>. Войдите в аккаунт с кодом, перейдите в <span className="font-medium">Управление аккаунтом → Безопасность → Двухэтапная аутентификация</span>, введите номер телефона (тут его не забанят), включите и выберите <span className="font-medium">&quot;Authenticator&quot;</span>.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Работа с лидами */}
        <section id="leads-work" className="relative overflow-hidden rounded-2xl shadow-xl border border-sky-200">
          <div className="absolute inset-0 bg-gradient-to-br from-sky-50 via-white to-blue-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-sky-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-sky-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-sky-500 to-blue-500 rounded-xl shadow-lg">
                  <UserCheck className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-sky-600 to-blue-600 bg-clip-text text-transparent">
                  Работа с лидами
                </h2>
                <p className="text-sm text-gray-500 mt-1">Кто считается лидом и как с ними работать</p>
              </div>
            </div>

            <div className="space-y-6">
              {/* Кто считается лидом */}
              <div className="bg-white/80 backdrop-blur-sm border border-sky-100 rounded-xl p-6">
                <h3 className="font-semibold text-gray-900 mb-4 text-lg flex items-center gap-2">
                  <span className="w-8 h-8 flex items-center justify-center bg-sky-500 text-white text-sm font-bold rounded-lg">?</span>
                  Кто считается лидом?
                </h3>
                <p className="text-gray-600 leading-relaxed mb-4">
                  Лидом считается человек, который непосредственно заинтересован в звонке / покупке / тесте и другом колл-ту-экшене, который мы закладывали в оффер.
                </p>

                <div className="grid md:grid-cols-2 gap-4">
                  {/* НЕ передаём */}
                  <div className="bg-gradient-to-r from-red-50 to-orange-50 border border-red-200 rounded-lg p-4">
                    <h4 className="font-semibold text-red-700 mb-3 flex items-center gap-2">
                      <XCircle className="h-5 w-5" />
                      НЕ передаём
                    </h4>
                    <ul className="space-y-2 text-sm text-red-700">
                      <li className="flex items-start gap-2">
                        <span className="text-red-400 mt-1">•</span>
                        Автоответы
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="text-red-400 mt-1">•</span>
                        Шаблонные запросы КП от менеджеров (если это на первое сообщение — высылаем наше второе)
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="text-red-400 mt-1">•</span>
                        Заполнение спец. формы на сайте для сотрудничества
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="text-red-400 mt-1">•</span>
                        Тех, кто подумает и сам свяжется
                      </li>
                    </ul>
                  </div>

                  {/* Передаём */}
                  <div className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-lg p-4">
                    <h4 className="font-semibold text-green-700 mb-3 flex items-center gap-2">
                      <CheckCircle2 className="h-5 w-5" />
                      Передаём
                    </h4>
                    <ul className="space-y-2 text-sm text-green-700">
                      <li className="flex items-start gap-2">
                        <span className="text-green-400 mt-1">•</span>
                        Тех, кто запросил цену
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="text-green-400 mt-1">•</span>
                        Готов созвониться
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="text-green-400 mt-1">•</span>
                        Готов протестировать
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="text-green-400 mt-1">•</span>
                        Сказал, что интересно, но просил связаться позже
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="text-green-400 mt-1">•</span>
                        Уточняет вопросы к отделу продаж
                      </li>
                    </ul>
                  </div>
                </div>

                <div className="bg-gradient-to-r from-sky-50 to-blue-50 border border-sky-200 rounded-lg p-4 mt-4">
                  <p className="text-sky-800 text-sm leading-relaxed">
                    <span className="font-semibold">Правило:</span> Поставьте себя на место специалиста из отдела продаж и спросите себя: &quot;Готов ли этот человек купить? Смогу ли я ему продать?&quot;
                  </p>
                </div>
              </div>

              {/* Передача лидов клиенту */}
              <div className="bg-white/80 backdrop-blur-sm border border-sky-100 rounded-xl p-6">
                <h3 className="font-semibold text-gray-900 mb-4 text-lg">Передача лидов клиенту</h3>
                <p className="text-gray-600 leading-relaxed mb-4">
                  Для передачи лида уточняем у клиента кому мы будем их передавать. Нам нужно: <span className="font-medium">имя / должность / email сотрудника</span>. Для передачи ставим специалиста в копию и в обратный адрес письма (чтобы когда лид нажмёт &quot;ответить&quot;, ответ сразу шёл к клиенту).
                </p>

                <div className="rounded-xl overflow-hidden mb-4 border border-sky-200 shadow-sm">
                  <img 
                    src="/images/lead-transfer-example.png" 
                    alt="Пример письма с передачей лида клиенту"
                    className="w-full h-auto"
                  />
                </div>

                <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4">
                  <p className="text-gray-700 text-sm mb-2 font-medium">Пример сообщения при передаче от лица клиента:</p>
                  <div className="bg-white border border-slate-200 rounded-lg p-3 text-sm text-gray-600 italic">
                    &quot;Добрый день! Я поставил в копию свою вторую почту, чтобы не пропустить от вас ответа. В ближайшее время свяжусь с вами и отвечу на все ваши вопросы. Уточните, пожалуйста, ваш телефон/вотсап/телеграм.&quot;
                  </div>
                </div>
              </div>

              {/* Взаимодействие с контактом */}
              <div className="bg-white/80 backdrop-blur-sm border border-sky-100 rounded-xl p-6">
                <h3 className="font-semibold text-gray-900 mb-4 text-lg">Взаимодействие с контактом</h3>
                <p className="text-gray-600 leading-relaxed mb-4">
                  Всё общение ведём осмысленно и не отвечаем шаблонно, игнорируя запросы человека. Отвечаем на его вопросы в пределах компетенций и подвязываем ответ к нашему офферу.
                </p>

                <div className="space-y-3">
                  <div className="bg-gradient-to-r from-sky-50 to-blue-50 border border-sky-200 rounded-lg p-4">
                    <p className="text-sky-800 text-sm mb-2 font-medium">Если человек сразу предлагает созвониться:</p>
                    <div className="bg-white border border-sky-200 rounded-lg p-3 text-sm text-gray-600 italic">
                      &quot;Добрый день, (имя)! Прежде чем созвониться, хочу рассказать вам о своём предложении...&quot;
                    </div>
                  </div>

                  <div className="bg-gradient-to-r from-sky-50 to-blue-50 border border-sky-200 rounded-lg p-4">
                    <p className="text-sky-800 text-sm mb-2 font-medium">Если передали контакт другого сотрудника:</p>
                    <div className="bg-white border border-sky-200 rounded-lg p-3 text-sm text-gray-600 italic">
                      &quot;Добрый день, (имя)! Прежде чем позвонить, хочу рассказать вам о своём предложении. Буду очень благодарен, если вы направите моё сообщение нужному специалисту!&quot;
                    </div>
                  </div>

                  <div className="bg-gradient-to-r from-sky-50 to-blue-50 border border-sky-200 rounded-lg p-4">
                    <p className="text-sky-800 text-sm mb-2 font-medium">Если нам передали email сотрудника:</p>
                    <div className="bg-white border border-sky-200 rounded-lg p-3 text-sm text-gray-600 italic">
                      &quot;Добрый день, (имя)! Ваш контакт мне передал сотрудник вашей компании - (имя сотрудника), поэтому сразу хочу рассказать вам о своём предложении...&quot;
                    </div>
                  </div>
                </div>

                <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-4 mt-4">
                  <p className="text-amber-800 text-sm leading-relaxed">
                    <span className="font-semibold">Важно:</span> Если лид ответил с другой почты, чтобы письма из рассылки не отправлялись дальше — измените статус лида на &quot;Interested&quot; или &quot;Not interested&quot;. Статус изменится на Completed и письма больше не будут отправляться.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Работа с базами */}
        <section id="databases-work" className="relative overflow-hidden rounded-2xl shadow-xl border border-violet-200">
          <div className="absolute inset-0 bg-gradient-to-br from-violet-50 via-white to-purple-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-violet-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-violet-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-violet-500 to-purple-500 rounded-xl shadow-lg">
                  <Database className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent">
                  Работа с базами
                </h2>
                <p className="text-sm text-gray-500 mt-1">Парсеры, сбор контактов и верификация</p>
              </div>
            </div>

            <div className="mb-6">
              <div className="bg-gradient-to-r from-violet-50 to-purple-50 border border-violet-200 rounded-lg p-4">
                <p className="text-violet-800 text-sm leading-relaxed">
                  Если вы сталкиваетесь с трудностями при генерации гипотез, используйте информацию из <a href="https://docs.google.com/document/d/1UqNVJRu9zE85A8VXzehjT3J3kB_IJfZjWdufSDQGn8A/edit#heading=h.hck8vy34qqsg" target="_blank" rel="noopener noreferrer" className="text-violet-700 font-medium hover:text-violet-900 underline">этого регламента</a>.
                </p>
              </div>
            </div>

            <div className="space-y-6">
              {/* Удалённый рабочий стол для MacOS */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-violet-100 to-purple-100 rounded-xl group-hover:from-violet-200 group-hover:to-purple-200 transition-colors shadow-sm">
                      <Monitor className="h-5 w-5 text-violet-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Удалённый рабочий стол для MacOS</h3>
                    <p className="text-gray-600 leading-relaxed mb-4">
                      Для использования <span className="font-medium">LetsExtract, 2Gis</span> и других Windows-программ с Mac необходимо скачать <span className="font-medium">Windows App</span> в App Store.
                    </p>

                    <div className="rounded-xl overflow-hidden mb-4 border border-violet-200 shadow-sm">
                      <img 
                        src="/images/windows-app-macos.png" 
                        alt="Windows App на MacOS для запуска Windows-программ"
                        className="w-full h-auto"
                      />
                    </div>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mb-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">Настройки подключения:</p>
                      <div className="space-y-1 text-sm">
                        <p><span className="font-medium">PC name:</span> <span className="font-mono bg-slate-100 px-1 rounded">83.222.10.15</span></p>
                        <p><span className="font-medium">Friendly name:</span> Administrator</p>
                        <p><span className="font-medium">Username:</span> Administrator</p>
                        <p><span className="font-medium">Password:</span> <span className="font-mono bg-slate-100 px-1 rounded">mG4nK-2Ze@Kr+U</span></p>
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-4">
                      <p className="text-blue-800 text-sm leading-relaxed">
                        <span className="font-semibold">Для Windows:</span> В поиске найдите &quot;Подключение к удалённому рабочему столу&quot;, введите IP <span className="font-mono bg-blue-100 px-1 rounded">94.198.218.179</span> и те же учётные данные.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Парсер Яндекс Директ */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-yellow-100 to-orange-100 rounded-xl group-hover:from-yellow-200 group-hover:to-orange-200 transition-colors shadow-sm">
                      <Globe className="h-5 w-5 text-yellow-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Парсер рекламы Яндекс Директ</h3>
                    
                    <div className="mb-4">
                      <a href="https://arsenkin.ru/tools/parser-ads/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-yellow-50 to-orange-50 border border-yellow-200 rounded-lg text-yellow-700 hover:from-yellow-100 hover:to-orange-100 hover:border-yellow-300 transition-all font-medium text-sm shadow-sm">
                        arsenkin.ru/tools/parser-ads <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>

                    <div className="space-y-3 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-violet-500 font-medium">1.</span>
                        <p>Соберите <a href="https://wordstat.yandex.ru" target="_blank" rel="noopener noreferrer" className="text-violet-600 hover:underline">ключевые фразы</a> и вставьте в поле, выберите регион, устройство и нажмите <span className="font-medium">&quot;Собрать данные&quot;</span></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-violet-500 font-medium">2.</span>
                        <p>Скачайте данные в формате <span className="font-mono bg-slate-100 px-1 rounded">windows-1251</span></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-violet-500 font-medium">3.</span>
                        <p>В <a href="https://docs.google.com/spreadsheets/u/0/" target="_blank" rel="noopener noreferrer" className="text-violet-600 hover:underline">Google Таблицах</a> импортируйте файл: Файл → Импортировать → &quot;Добавить на эту страницу&quot;</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-violet-500 font-medium">4.</span>
                        <p>Скопируйте ссылки на сайты на вторую страницу, затем импортируйте следующий файл с опцией &quot;Заменить текущий лист&quot;</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Яндекс.Карты Парсер */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-red-100 to-orange-100 rounded-xl group-hover:from-red-200 group-hover:to-orange-200 transition-colors shadow-sm">
                      <Map className="h-5 w-5 text-red-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Яндекс.Карты Парсер</h3>
                    
                    <div className="flex flex-wrap gap-2 mb-4">
                      <a href="https://drive.google.com/file/d/1hK2_KrQQ2g-uZeKCAm20tzBOLl1y8uwP/view?usp=sharing" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-violet-50 to-purple-50 border border-violet-200 rounded-lg text-violet-700 hover:from-violet-100 hover:to-purple-100 hover:border-violet-300 transition-all font-medium text-sm shadow-sm">
                        <Download className="h-3.5 w-3.5" /> Скачать парсер
                      </a>
                    </div>

                    <div className="space-y-4">
                      <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4">
                        <h4 className="font-medium text-gray-800 mb-2">1. Подготовка и запуск</h4>
                        <p className="text-gray-600 text-sm">Распакуйте архив и запустите <span className="font-mono bg-slate-100 px-1 rounded">YandexMapsParser.exe</span></p>
                      </div>

                      <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4">
                        <h4 className="font-medium text-gray-800 mb-2">2. Генерация ссылок (3 способа)</h4>
                        <ul className="text-gray-600 text-sm space-y-2">
                          <li><span className="font-medium text-violet-600">А)</span> Ручной ввод: город + ключевое слово → &quot;Сгенерировать URL поиска&quot;</li>
                          <li><span className="font-medium text-violet-600">Б)</span> Массовая генерация: кнопка &quot;Генератор ссылок&quot; → выбор городов и рубрик</li>
                          <li><span className="font-medium text-violet-600">В)</span> Через браузер: настройте фильтры на <a href="https://yandex.ru/maps" target="_blank" rel="noopener noreferrer" className="text-violet-600 hover:underline">Яндекс.Картах</a> и скопируйте URL</li>
                        </ul>
                      </div>

                      <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4">
                        <h4 className="font-medium text-gray-800 mb-2">3. Сбор и парсинг</h4>
                        <p className="text-gray-600 text-sm mb-2"><span className="font-medium">&quot;Собрать ссылки организаций&quot;</span> → <span className="font-medium">&quot;Начать парсинг организаций&quot;</span> → <span className="font-medium">&quot;Экспорт в Excel&quot;</span></p>
                        <p className="text-gray-500 text-xs">Рекомендация: лимит не более 1000 организаций на одну ссылку</p>
                      </div>

                      <div className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-lg p-3">
                        <p className="text-green-800 text-sm">
                          <span className="font-semibold">Данные в Excel:</span> название, адрес, рейтинг, телефоны, сайт, email, соцсети, WhatsApp, категории, часы работы
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Парсер 2ГИС */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-green-100 to-emerald-100 rounded-xl group-hover:from-green-200 group-hover:to-emerald-200 transition-colors shadow-sm">
                      <Map className="h-5 w-5 text-green-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Парсер 2ГИС</h3>
                    <p className="text-gray-500 text-sm mb-3">Скорость: 200 мест за 5 минут</p>
                    
                    <div className="flex flex-wrap gap-2 mb-4">
                      <a href="https://drive.google.com/file/d/1W_gwgL2AdI6_JwxSOe5fzjotJYa5lIHQ/view?usp=sharing" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-lg text-green-700 hover:from-green-100 hover:to-emerald-100 hover:border-green-300 transition-all font-medium text-sm shadow-sm">
                        <Download className="h-3.5 w-3.5" /> Скачать парсер
                      </a>
                      <a href="https://www.google.ru/chrome/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-gray-200 rounded-lg text-gray-600 hover:border-gray-300 transition-all text-sm">
                        Требуется Chrome <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>

                    <div className="space-y-3 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-green-500 font-medium">1.</span>
                        <p>Нажмите 3 точки напротив URL → &quot;Сгенерировать&quot; → &quot;Выделить все&quot; → введите запрос</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-green-500 font-medium">2.</span>
                        <p>Выберите тип <span className="font-mono bg-slate-100 px-1 rounded">xlsx</span> и место сохранения</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-green-500 font-medium">3.</span>
                        <p>Нажмите &quot;Запуск&quot; и дождитесь окончания</p>
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-4 mt-4">
                      <p className="text-amber-800 text-sm leading-relaxed">
                        <span className="font-semibold">Рекомендация:</span> Перед парсингом проверьте ссылки и выставьте фильтры на 2gis.ru (например, звёздность отелей). Можно попросить ChatGPT добавить фильтры в остальные ссылки.
                      </p>
                    </div>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mt-3">
                      <p className="text-gray-700 text-sm mb-2 font-medium">Настройки при ошибках:</p>
                      <ul className="text-gray-600 text-sm space-y-1">
                        <li>• <span className="font-medium">Лимит RAM:</span> меньше половины ОЗУ (например, 6000 МБ при 16 ГБ)</li>
                        <li>• <span className="font-medium">Скрытый режим:</span> стабильнее и быстрее</li>
                        <li>• <span className="font-medium">Лимит записей:</span> увеличьте, если &gt;3000 контактов из региона</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>

              {/* Парсинг с HH */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-red-100 to-pink-100 rounded-xl group-hover:from-red-200 group-hover:to-pink-200 transition-colors shadow-sm">
                      <Briefcase className="h-5 w-5 text-red-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Парсинг с HH.ru</h3>
                    
                    <p className="text-gray-600 text-sm mb-4">
                      Зайдите на <a href="https://hh.ru" target="_blank" rel="noopener noreferrer" className="text-violet-600 hover:underline">hh.ru</a>, введите ключевое слово и настройте фильтры.
                    </p>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mb-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">Рекомендуемые фильтры:</p>
                      <ul className="text-gray-600 text-sm space-y-1">
                        <li>• <span className="font-medium">Уровень дохода</span> — отсечёт неподходящие должности (директор вряд ли получает до 55 000 руб.)</li>
                        <li>• <span className="font-medium">Исключить ключевые слова</span> — уберёт крупных игроков, конкурентов и неподходящие вакансии</li>
                        <li>• <span className="font-medium">Ключевые слова</span> — поиск по названиям компаний уточнит ЦА</li>
                        <li>• <span className="font-medium">Временной промежуток</span> — свежие вакансии (например, за неделю)</li>
                        <li>• <span className="font-medium">Специализации и отрасль</span> — хорошо сужают аудиторию, но могут сильно обрезать выборку</li>
                      </ul>
                    </div>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mb-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">Команды поиска:</p>
                      <ul className="text-gray-600 text-sm space-y-1">
                        <li>• <span className="font-mono bg-slate-100 px-1 rounded">|</span> — несколько запросов (маркетолог | smm)</li>
                        <li>• <span className="font-mono bg-slate-100 px-1 rounded">&amp;</span> — точная фраза, слова рядом друг с другом</li>
                      </ul>
                      <a href="https://hh.ru/article/1175" target="_blank" rel="noopener noreferrer" className="text-violet-600 hover:underline text-xs mt-2 inline-block">Другие полезные команды →</a>
                    </div>

                    <div className="mb-4">
                      <a href="https://t.me/polzaagency_bot" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg text-blue-700 hover:from-blue-100 hover:to-indigo-100 hover:border-blue-300 transition-all font-medium text-sm shadow-sm">
                        <MessageCircle className="h-3.5 w-3.5" /> @polzaagency_bot — отправьте ссылку на выборку
                      </a>
                    </div>

                    <div className="bg-gradient-to-r from-red-50 to-orange-50 border border-red-200 rounded-lg p-4">
                      <p className="text-red-700 text-sm leading-relaxed">
                        <span className="font-semibold">Важно для бота:</span>
                      </p>
                      <ul className="text-red-700 text-sm mt-1 space-y-1">
                        <li>• Должны быть выбраны <span className="font-medium">отрасли</span>!</li>
                        <li>• Ссылка должна быть вида <span className="font-mono bg-red-100 px-1 rounded">https://hh.ru/se...</span> — <span className="font-medium">без города перед hh</span>!</li>
                      </ul>
                    </div>

                    <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-4 mt-3">
                      <p className="text-amber-800 text-sm leading-relaxed">
                        <span className="font-semibold">Совет:</span> Если результат слишком маленький — дополните выборку через символ <span className="font-mono bg-amber-100 px-1 rounded">|</span>. Перед отправкой клиенту удаляйте столбец с зарплатой и названиями вакансий (если не важно для проекта) — клиенты путаются.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Парсинг рейтинга на HH.ru */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-red-100 to-rose-100 rounded-xl group-hover:from-red-200 group-hover:to-rose-200 transition-colors shadow-sm">
                      <BarChart3 className="h-5 w-5 text-red-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Парсинг рейтинга на HH.ru</h3>
                    
                    <div className="mb-4">
                      <a href="https://drive.google.com/file/d/1Fwo_KtJ_fwPHIcMz1LRij6So8pRgldYr/view?usp=sharing" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-red-50 to-rose-50 border border-red-200 rounded-lg text-red-700 hover:from-red-100 hover:to-rose-100 hover:border-red-300 transition-all font-medium text-sm shadow-sm">
                        <Download className="h-3.5 w-3.5" /> Скачать парсер рейтинга
                      </a>
                    </div>

                    <div className="space-y-2 text-sm text-gray-600 mb-4">
                      <div className="flex items-start gap-2">
                        <span className="text-red-500 font-medium">1.</span>
                        <p>Скачайте архив и извлеките папку на ПК</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-red-500 font-medium">2.</span>
                        <p>Откройте папку <span className="font-mono bg-slate-100 px-1 rounded">Head Hunter Employers Rating Parser</span> → <span className="font-mono bg-slate-100 px-1 rounded">.build</span></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-red-500 font-medium">3.</span>
                        <p>Скопируйте столбец &quot;Ссылка на вакансию&quot; и вставьте в файл <span className="font-mono bg-slate-100 px-1 rounded">vacancies.txt</span></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-red-500 font-medium">4.</span>
                        <p>Сохраните файл и запустите <span className="font-mono bg-slate-100 px-1 rounded">Head Hunter Employers Rating Parser.exe</span></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-red-500 font-medium">5.</span>
                        <p>Дождитесь окончания → результат в папке <span className="font-mono bg-slate-100 px-1 rounded">data</span></p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Проверка ссылок на работоспособность */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-emerald-100 to-green-100 rounded-xl group-hover:from-emerald-200 group-hover:to-green-200 transition-colors shadow-sm">
                      <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Проверка ссылок на работоспособность</h3>
                    
                    <div className="mb-4">
                      <a href="https://drive.google.com/file/d/1ys0r1EKA2kHVAp2Fe83xT36ib_Pit0P6/view?usp=sharing" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-emerald-50 to-green-50 border border-emerald-200 rounded-lg text-emerald-700 hover:from-emerald-100 hover:to-green-100 hover:border-emerald-300 transition-all font-medium text-sm shadow-sm">
                        <Download className="h-3.5 w-3.5" /> Sites Availability Checker.zip
                      </a>
                    </div>

                    <div className="space-y-2 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-emerald-500 font-medium">1.</span>
                        <p>Скачайте и разархивируйте программу</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-emerald-500 font-medium">2.</span>
                        <p>Откройте папку <span className="font-mono bg-slate-100 px-1 rounded">.build</span></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-emerald-500 font-medium">3.</span>
                        <p>Поместите в папку <span className="font-mono bg-slate-100 px-1 rounded">data</span> Excel таблицу с колонками: <span className="font-medium">Компания | Сайт</span></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-emerald-500 font-medium">4.</span>
                        <p>Результат появится в папке <span className="font-mono bg-slate-100 px-1 rounded">data/output</span></p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Парсинг с ТГ каналов */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-blue-100 to-cyan-100 rounded-xl group-hover:from-blue-200 group-hover:to-cyan-200 transition-colors shadow-sm">
                      <MessageCircle className="h-5 w-5 text-blue-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Парсинг с Telegram каналов</h3>
                    
                    <div className="mb-4">
                      <a href="https://t.me/parse_polza_bot" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-blue-50 to-cyan-50 border border-blue-200 rounded-lg text-blue-700 hover:from-blue-100 hover:to-cyan-100 hover:border-blue-300 transition-all font-medium text-sm shadow-sm">
                        <MessageCircle className="h-3.5 w-3.5" /> @parse_polza_bot
                      </a>
                    </div>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mb-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">Как использовать:</p>
                      <p className="text-gray-600 text-sm font-mono bg-slate-100 p-2 rounded">/scan https://t.me/devjobs</p>
                      <p className="text-gray-500 text-xs mt-2">Бот не ответит на /start — сразу отправляйте /scan со ссылкой</p>
                    </div>

                    <p className="text-gray-600 text-sm mb-4">
                      Бот собирает последние 10000 постов (5-15 минут). Результаты появятся в таблице в описании бота.
                    </p>

                    <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-3">
                      <p className="text-amber-800 text-sm">
                        <span className="font-semibold">Важно:</span> Функции работать нескольким пользователям одновременно нет — после сбора информация обновляется на листе &quot;Названия вакансий&quot;.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Глаз Бога */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-slate-100 to-gray-100 rounded-xl group-hover:from-slate-200 group-hover:to-gray-200 transition-colors shadow-sm">
                      <Search className="h-5 w-5 text-slate-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Глаз Бога</h3>
                    <p className="text-gray-600 text-sm">
                      Бот для поиска информации о контактах. Позволяет найти дополнительные данные по номеру телефона, email или имени.
                    </p>
                    <a href="https://t.me/eyeofgod_bot" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg text-slate-700 hover:from-slate-100 hover:to-gray-100 transition-all text-sm mt-3">
                      <MessageCircle className="h-3.5 w-3.5" /> @eyeofgod_bot
                    </a>
                  </div>
                </div>
              </div>

              {/* Selecom */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-blue-100 to-indigo-100 rounded-xl group-hover:from-blue-200 group-hover:to-indigo-200 transition-colors shadow-sm">
                      <Database className="h-5 w-5 text-blue-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Selecom</h3>
                    <p className="text-gray-600 text-sm mb-3">
                      Сервис для сбора баз контактов. <span className="text-amber-600">Учтите: базы из Selecom, РБК и прочих источников могут быть не совсем свежими.</span>
                    </p>
                    <a href="https://selecom.ru" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg text-blue-700 hover:from-blue-100 hover:to-indigo-100 transition-all text-sm">
                      selecom.ru <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>
              </div>

              {/* PhantomBuster */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-purple-100 to-fuchsia-100 rounded-xl group-hover:from-purple-200 group-hover:to-fuchsia-200 transition-colors shadow-sm">
                      <Bot className="h-5 w-5 text-purple-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">PhantomBuster — парсинг Sales Navigator</h3>
                    <p className="text-gray-600 text-sm mb-3">
                      С его помощью можно собирать email с сайтов, искать домены по названиям и парсить Google Карты.
                    </p>
                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-3">
                      <p className="text-gray-700 text-sm">
                        <span className="font-medium">Доступы:</span> в документе с общими доступами
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Подключение к базе баз */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-teal-100 to-cyan-100 rounded-xl group-hover:from-teal-200 group-hover:to-cyan-200 transition-colors shadow-sm">
                      <Database className="h-5 w-5 text-teal-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Подключение к базе баз</h3>
                    <p className="text-gray-600 text-sm mb-3">
                      Централизованное хранилище всех собранных баз компании. Доступы и инструкция по подключению в документе с общими доступами.
                    </p>
                  </div>
                </div>
              </div>

              {/* Парсинг с Habr */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-cyan-100 to-teal-100 rounded-xl group-hover:from-cyan-200 group-hover:to-teal-200 transition-colors shadow-sm">
                      <Briefcase className="h-5 w-5 text-cyan-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Парсинг с Habr Career</h3>
                    
                    <div className="flex flex-wrap gap-2 mb-4">
                      <a href="https://t.me/habrcareer_parser_bot" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-cyan-50 to-teal-50 border border-cyan-200 rounded-lg text-cyan-700 hover:from-cyan-100 hover:to-teal-100 hover:border-cyan-300 transition-all font-medium text-sm shadow-sm">
                        <MessageCircle className="h-3.5 w-3.5" /> @habrcareer_parser_bot
                      </a>
                      <a href="https://docs.google.com/spreadsheets/d/1EZ1refZQh_LJ20OhOYMcvQVYboY5CmpBF3zZTjrakQM/edit?usp=sharing" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-gray-200 rounded-lg text-gray-600 hover:border-gray-300 transition-all text-sm">
                        Таблица результатов <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>

                    <p className="text-gray-600 text-sm">
                      Нажмите <span className="font-mono bg-slate-100 px-1 rounded">/start</span> и отправьте ссылку на выборку.
                    </p>
                  </div>
                </div>
              </div>

              {/* Парсинг с Habr */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-cyan-100 to-teal-100 rounded-xl group-hover:from-cyan-200 group-hover:to-teal-200 transition-colors shadow-sm">
                      <Briefcase className="h-5 w-5 text-cyan-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Парсинг с Habr Career</h3>
                    
                    <div className="flex flex-wrap gap-2 mb-4">
                      <a href="https://t.me/habrcareer_parser_bot" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-cyan-50 to-teal-50 border border-cyan-200 rounded-lg text-cyan-700 hover:from-cyan-100 hover:to-teal-100 hover:border-cyan-300 transition-all font-medium text-sm shadow-sm">
                        <MessageCircle className="h-3.5 w-3.5" /> @habrcareer_parser_bot
                      </a>
                      <a href="https://docs.google.com/spreadsheets/d/1EZ1refZQh_LJ20OhOYMcvQVYboY5CmpBF3zZTjrakQM/edit?usp=sharing" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-gray-200 rounded-lg text-gray-600 hover:border-gray-300 transition-all text-sm">
                        Таблица результатов <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>

                    <p className="text-gray-600 text-sm">
                      Нажмите <span className="font-mono bg-slate-100 px-1 rounded">/start</span> и отправьте ссылку на выборку.
                    </p>
                  </div>
                </div>
              </div>

              {/* Парсинг LinkedIn */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-blue-100 to-indigo-100 rounded-xl group-hover:from-blue-200 group-hover:to-indigo-200 transition-colors shadow-sm">
                      <Link className="h-5 w-5 text-blue-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Парсинг LinkedIn</h3>
                    
                    <div className="space-y-3 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-blue-500 font-medium">1.</span>
                        <p>Войдите в LinkedIn и перейдите на <a href="https://www.linkedin.com/search/results/companies/" target="_blank" rel="noopener noreferrer" className="text-violet-600 hover:underline">поиск компаний</a></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-blue-500 font-medium">2.</span>
                        <p>Настройте фильтры (рекомендуется не более 600 компаний)</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-blue-500 font-medium">3.</span>
                        <p>Скопируйте URL и отправьте в бот <a href="https://t.me/polza_linkedin_company_bot" target="_blank" rel="noopener noreferrer" className="text-violet-600 hover:underline">@polza_linkedin_company_bot</a></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-blue-500 font-medium">4.</span>
                        <p>Парсинг может занять до часа. Результаты в таблице в описании бота</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Парсер RusProfile */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-orange-100 to-amber-100 rounded-xl group-hover:from-orange-200 group-hover:to-amber-200 transition-colors shadow-sm">
                      <HardDrive className="h-5 w-5 text-orange-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Парсер RusProfile</h3>
                    
                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mb-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">Доступы к rusprofile.ru:</p>
                      <p className="text-gray-600 text-sm">
                        <span className="font-medium">Почта:</span> <span className="font-mono bg-slate-100 px-1 rounded">grid4ina.an@gmail.com</span><br/>
                        <span className="font-medium">Пароль:</span> <span className="font-mono bg-slate-100 px-1 rounded">zasfam-xonxyj-6hYjky</span>
                      </p>
                    </div>

                    <div className="mb-4">
                      <a href="https://drive.google.com/file/d/1iVPb_7Ok-x9L6VE5Ef0auElUIt0YUgjj/view?usp=sharing" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-orange-50 to-amber-50 border border-orange-200 rounded-lg text-orange-700 hover:from-orange-100 hover:to-amber-100 hover:border-orange-300 transition-all font-medium text-sm shadow-sm">
                        <Download className="h-3.5 w-3.5" /> Скачать парсер
                      </a>
                    </div>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mb-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">Настройка config.json:</p>
                      <ul className="text-gray-600 text-sm space-y-1">
                        <li>• <span className="font-medium">SAVE_FOLDER</span> — папка сохранения результатов</li>
                        <li>• <span className="font-medium">PROXY</span> — формат http://логин:пароль@ip:порт (пусто если нет)</li>
                        <li>• <span className="font-medium">MAX_PAGES</span> — сколько страниц собирать (0 = все, макс 20)</li>
                        <li>• <span className="font-medium">MIN/MAX_SLEEP_TIME</span> — время между запросами в секундах</li>
                      </ul>
                    </div>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mb-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">Как заполнить filters.json:</p>
                      <div className="space-y-1 text-sm text-gray-600">
                        <p>1. Перейдите на <a href="https://www.rusprofile.ru/search-advanced" target="_blank" rel="noopener noreferrer" className="text-violet-600 hover:underline">rusprofile.ru/search-advanced</a></p>
                        <p>2. Нажмите <span className="font-medium">F12</span> → вкладка <span className="font-medium">Network (Сеть)</span> → фильтр <span className="font-medium">Fetch/XHR</span></p>
                        <p>3. Установите фильтры на сайте</p>
                        <p>4. Найдите последний запрос <span className="font-mono bg-slate-100 px-1 rounded text-xs">ajax_auth.php?action=search_advanced</span></p>
                        <p>5. ПКМ → <span className="font-medium">Copy → Copy as cURL (bash)</span></p>
                        <p>6. Вставьте на <a href="https://curlconverter.com/json/" target="_blank" rel="noopener noreferrer" className="text-violet-600 hover:underline">curlconverter.com/json</a></p>
                        <p>7. Скопируйте результат в filters.json и сохраните</p>
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-4">
                      <p className="text-amber-800 text-sm leading-relaxed">
                        <span className="font-semibold">Совет:</span> Если программа пишет &quot;Подтвердите, что вы не робот&quot; — смените прокси или зайдите на <a href="https://www.rusprofile.ru/search-advanced" target="_blank" rel="noopener noreferrer" className="underline">rusprofile.ru</a> с основного браузера и полистайте пару страниц вручную.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Apollo */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-indigo-100 to-violet-100 rounded-xl group-hover:from-indigo-200 group-hover:to-violet-200 transition-colors shadow-sm">
                      <Globe className="h-5 w-5 text-indigo-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Apollo — парсинг зарубежных контактов</h3>
                    
                    <div className="flex flex-wrap gap-2 mb-4">
                      <a href="https://docs.google.com/document/d/1WRrcMpET3_4FATWX1shGjozDPTV-VTLA/edit#heading=h.yy5iphwlrlro" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-indigo-50 to-violet-50 border border-indigo-200 rounded-lg text-indigo-700 hover:from-indigo-100 hover:to-violet-100 hover:border-indigo-300 transition-all font-medium text-sm shadow-sm">
                        Полный регламент <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                      <a href="https://drive.google.com/file/d/1U6wykUwYIn-bUi7y6mGshROCUuVTOpgx/view?usp=drive_link" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-red-50 to-pink-50 border border-red-200 rounded-lg text-red-700 hover:from-red-100 hover:to-pink-100 transition-all font-medium text-sm shadow-sm">
                        <Video className="h-3.5 w-3.5" /> Видео-инструкция
                      </a>
                      <a href="https://t.me/Apollo_parser_bot" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg text-blue-700 hover:from-blue-100 hover:to-indigo-100 hover:border-blue-300 transition-all font-medium text-sm shadow-sm">
                        <MessageCircle className="h-3.5 w-3.5" /> @Apollo_parser_bot
                      </a>
                    </div>

                    <p className="text-gray-600 text-sm mb-4">
                      Зайдите на <a href="https://apollo.io" target="_blank" rel="noopener noreferrer" className="text-violet-600 hover:underline">apollo.io</a> → вкладка с лупой → <span className="font-medium">People</span>
                    </p>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mb-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">1. Фильтрация выборки:</p>
                      <ul className="text-gray-600 text-sm space-y-1">
                        <li>• <span className="font-medium">Job Titles</span> — должности (можно исключить через &quot;Is not any&quot;)</li>
                        <li>• <span className="font-medium">Employees</span> — размер компании (отсечь маленькие/крупные)</li>
                        <li>• <span className="font-medium">Industry &amp; Keywords</span> — индустрии и ключевые слова</li>
                        <li>• <span className="font-medium">Email Status</span> — ставить первые 2 пункта (verified)</li>
                      </ul>
                      <p className="text-gray-500 text-xs mt-2">Ключевые слова ищут по: названию компании, тэгам соцсетей, SEO описанию. Миксуйте фильтры!</p>
                    </div>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mb-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">2. Сохранение выборки:</p>
                      <ul className="text-gray-600 text-sm space-y-1">
                        <li>• Нажмите чекбокс около списка</li>
                        <li>• <span className="font-medium">Max people per company</span> — укажите 2-3 (не собирать 10+ из одной компании)</li>
                        <li>• Введите общее кол-во контактов → <span className="font-medium">Apply selection</span></li>
                        <li>• <span className="font-medium">List → Add to Lists</span> → название → сохранить</li>
                      </ul>
                    </div>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mb-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">3. Скачивание через бот:</p>
                      <p className="text-gray-600 text-sm">Загрузите ссылку на List в <span className="font-medium">@Apollo_parser_bot</span>. Если бот не пишет &quot;Начинаю парсинг!&quot;, попросите GPT адаптировать ссылку под формат:</p>
                      <p className="text-gray-500 text-xs mt-1 font-mono bg-slate-100 p-1 rounded">https://app.apollo.io/#/people?finderViewId=...&amp;contactLabelIds[]=...</p>
                      <p className="text-gray-500 text-xs mt-2">Результат забрать из таблицы в описании бота (лист с вашим ТГ-ником). В листе не работайте!</p>
                    </div>

                    <div className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-lg p-4">
                      <p className="text-green-800 text-sm leading-relaxed">
                        <span className="font-semibold">Совет:</span> При сохранении используйте &quot;Max people per company&quot; = 2-3, чтобы не собирать 10+ контактов из одной компании.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* LetsExtract */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-purple-100 to-pink-100 rounded-xl group-hover:from-purple-200 group-hover:to-pink-200 transition-colors shadow-sm">
                      <Mail className="h-5 w-5 text-purple-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">LetsExtract — парсинг контактов и верификация email</h3>
                    
                    <div className="flex flex-wrap gap-2 mb-4">
                      <a href="https://drive.google.com/file/d/1VwXMpskP0zA-kWED0bj2CTrM-hVOKTjR/view?usp=sharing" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-purple-50 to-pink-50 border border-purple-200 rounded-lg text-purple-700 hover:from-purple-100 hover:to-pink-100 hover:border-purple-300 transition-all font-medium text-sm shadow-sm">
                        <Download className="h-3.5 w-3.5" /> Скачать (пиратская версия)
                      </a>
                      <a href="https://letsextract.com/ru/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-gray-200 rounded-lg text-gray-600 hover:border-gray-300 transition-all text-sm">
                        Официальный сайт <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>

                    <p className="text-gray-600 text-sm mb-3">
                      Программа для парсинга email с сайтов и верификации собранных контактов. Доступы к официальной версии — в файле с доступами (работает на 2 ПК одновременно).
                    </p>

                    {/* Placeholder для картинки */}
                    <div className="border-2 border-dashed border-purple-200 rounded-xl p-6 bg-purple-50/50 text-center">
                      <ImageIcon className="h-6 w-6 text-purple-300 mx-auto mb-2" />
                      <p className="text-xs text-purple-400">Картинка: letsextract-interface.png</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* База баз */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-slate-100 to-gray-100 rounded-xl group-hover:from-slate-200 group-hover:to-gray-200 transition-colors shadow-sm">
                      <Database className="h-5 w-5 text-slate-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">База баз</h3>
                    <p className="text-gray-600 text-sm mb-4">
                      Большая база данных из Селеком и RusProfile, которая постоянно пополняется. Поиск по фильтрам с выгрузкой.
                    </p>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mb-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">Доступ:</p>
                      <p className="text-gray-600 text-sm">
                        <a href="http://nikvasqt.beget.tech/dashboard/companies" target="_blank" rel="noopener noreferrer" className="text-violet-600 hover:underline">nikvasqt.beget.tech/dashboard/companies</a><br/>
                        <span className="font-medium">Email:</span> <span className="font-mono bg-slate-100 px-1 rounded">admin@example.com</span><br/>
                        <span className="font-medium">Пароль:</span> <span className="font-mono bg-slate-100 px-1 rounded">secret</span>
                      </p>
                    </div>

                    <p className="text-gray-600 text-sm">
                      Фильтры: регион, ОКВЭД, выручка. После настройки нажмите &quot;Выгрузить данные&quot; — скачается xlsx файл.
                    </p>
                  </div>
                </div>
              </div>

              {/* Проверка ссылок */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-violet-100 rounded-xl p-6 hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-violet-500 to-purple-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-teal-100 to-cyan-100 rounded-xl group-hover:from-teal-200 group-hover:to-cyan-200 transition-colors shadow-sm">
                      <Link className="h-5 w-5 text-teal-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Проверка ссылок на работоспособность</h3>
                    
                    <div className="mb-4">
                      <a href="https://drive.google.com/file/d/1ys0r1EKA2kHVAp2Fe83xT36ib_Pit0P6/view?usp=sharing" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-teal-50 to-cyan-50 border border-teal-200 rounded-lg text-teal-700 hover:from-teal-100 hover:to-cyan-100 hover:border-teal-300 transition-all font-medium text-sm shadow-sm">
                        <Download className="h-3.5 w-3.5" /> Sites Availability Checker
                      </a>
                    </div>

                    <div className="space-y-2 text-sm text-gray-600">
                      <p>1. Откройте папку <span className="font-mono bg-slate-100 px-1 rounded">.build</span></p>
                      <p>2. В папку <span className="font-mono bg-slate-100 px-1 rounded">data</span> положите Excel таблицу с колонками: Компания | Сайт</p>
                      <p>3. Результат появится в папке <span className="font-mono bg-slate-100 px-1 rounded">data/output</span></p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Работа с таблицами и базами */}
        <section id="tables-work" className="relative overflow-hidden rounded-2xl shadow-xl border border-cyan-200">
          <div className="absolute inset-0 bg-gradient-to-br from-cyan-50 via-white to-teal-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-cyan-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-cyan-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-cyan-500 to-teal-500 rounded-xl shadow-lg">
                  <Table className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-cyan-600 to-teal-600 bg-clip-text text-transparent">
                  Работа с таблицами и базами
                </h2>
                <p className="text-sm text-gray-500 mt-1">Скрипты, макросы и автоматизация в Google Sheets</p>
              </div>
            </div>

            <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-4 mb-6">
              <p className="text-amber-800 text-sm leading-relaxed">
                <span className="font-semibold">К сведению:</span> Вы всегда можете попросить ChatGPT написать нужный скрипт под вашу задачу!
              </p>
            </div>

            <div className="space-y-6">
              {/* Удаление повторов */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-cyan-100 rounded-xl p-6 hover:border-cyan-300 hover:shadow-lg hover:shadow-cyan-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-cyan-500 to-teal-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-cyan-100 to-teal-100 rounded-xl group-hover:from-cyan-200 group-hover:to-teal-200 transition-colors shadow-sm">
                      <Trash2 className="h-5 w-5 text-cyan-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Удаление повторов в Google Таблице</h3>
                    
                    <div className="space-y-2 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-cyan-500 font-medium">1.</span>
                        <p>Выделите всю таблицу</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-cyan-500 font-medium">2.</span>
                        <p><span className="font-medium">Данные → Очистка данных → Удалить повторы</span></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-cyan-500 font-medium">3.</span>
                        <p>Выберите столбец для поиска повторов (сайты, email или названия компаний)</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Поиск дублей */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-cyan-100 rounded-xl p-6 hover:border-cyan-300 hover:shadow-lg hover:shadow-cyan-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-cyan-500 to-teal-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-cyan-100 to-teal-100 rounded-xl group-hover:from-cyan-200 group-hover:to-teal-200 transition-colors shadow-sm">
                      <Copy className="h-5 w-5 text-cyan-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Поиск дублей в нескольких базах</h3>
                    <p className="text-gray-600 text-sm mb-4">
                      Скрипт для сравнения данных между листами. Выделяет совпадения цветами: розовый — названия, жёлтый — email, синий — сайты.
                    </p>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mb-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">Подготовка таблицы:</p>
                      <ul className="text-gray-600 text-sm space-y-1">
                        <li>• Основной лист для сравнения должен называться <span className="font-mono bg-slate-100 px-1 rounded">Лист1</span></li>
                        <li>• <span className="font-medium">Столбец A:</span> email-адреса</li>
                        <li>• <span className="font-medium">Столбец B:</span> названия компаний</li>
                        <li>• <span className="font-medium">Столбец C:</span> сайты</li>
                        <li>• Листы, не участвующие в сравнении, пометьте знаком <span className="font-mono bg-slate-100 px-1 rounded">!</span> в названии</li>
                      </ul>
                    </div>

                    <div className="space-y-2 text-sm text-gray-600 mb-4">
                      <p className="font-medium text-gray-700">Инструкция по использованию:</p>
                      <div className="flex items-start gap-2">
                        <span className="text-cyan-500 font-medium">1.</span>
                        <p>Откройте Google Таблицу → <span className="font-medium">Расширения → Apps Script</span></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-cyan-500 font-medium">2.</span>
                        <p>Если нужен новый проект: <span className="font-medium">Файл → Новый → Проект</span></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-cyan-500 font-medium">3.</span>
                        <p>Скопируйте скрипт и вставьте в редактор, заменив существующий код</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-cyan-500 font-medium">4.</span>
                        <p>Сохраните (иконка дискеты или <span className="font-medium">Файл → Сохранить</span>), введите название</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-cyan-500 font-medium">5.</span>
                        <p>Нажмите <span className="font-medium">Выполнить</span> (▶), при первом запуске дайте разрешения</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-cyan-500 font-medium">6.</span>
                        <p>Вернитесь в таблицу — ячейки с совпадениями будут выделены цветами</p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <a href="https://docs.google.com/document/d/1UzdHKo_dwICovxbCONdA5z4bKfwum96s5AoHGn_AO1A/edit?tab=t.0#heading=h.h5noicqvgp4d" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-cyan-50 to-teal-50 border border-cyan-200 rounded-lg text-cyan-700 hover:from-cyan-100 hover:to-teal-100 transition-all text-sm">
                        <Code className="h-3.5 w-3.5" /> Скрипт по email
                      </a>
                      <a href="https://docs.google.com/document/d/1UzdHKo_dwICovxbCONdA5z4bKfwum96s5AoHGn_AO1A/edit?tab=t.0#heading=h.6dakluhnykvv" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-cyan-50 to-teal-50 border border-cyan-200 rounded-lg text-cyan-700 hover:from-cyan-100 hover:to-teal-100 transition-all text-sm">
                        <Code className="h-3.5 w-3.5" /> Скрипт по названиям
                      </a>
                      <a href="https://docs.google.com/document/d/1UzdHKo_dwICovxbCONdA5z4bKfwum96s5AoHGn_AO1A/edit?tab=t.0#heading=h.92otwfh5rgd1" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-cyan-50 to-teal-50 border border-cyan-200 rounded-lg text-cyan-700 hover:from-cyan-100 hover:to-teal-100 transition-all text-sm">
                        <Code className="h-3.5 w-3.5" /> Скрипт по сайтам
                      </a>
                    </div>
                  </div>
                </div>
              </div>

              {/* Как использовать скрипты */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-cyan-100 rounded-xl p-6 hover:border-cyan-300 hover:shadow-lg hover:shadow-cyan-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-cyan-500 to-teal-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-cyan-100 to-teal-100 rounded-xl group-hover:from-cyan-200 group-hover:to-teal-200 transition-colors shadow-sm">
                      <Code className="h-5 w-5 text-cyan-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Как использовать скрипты в Google Sheets</h3>
                    
                    <div className="space-y-3 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-cyan-500 font-medium">1.</span>
                        <p>Загрузите таблицу → <span className="font-medium">Расширения → Apps Script</span></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-cyan-500 font-medium">2.</span>
                        <p>Скопируйте нужный скрипт и вставьте в поле кода (удалите стартовую заготовку)</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-cyan-500 font-medium">3.</span>
                        <p>Сохраните код (💾) → вернитесь в таблицу → <span className="font-medium">Расширения → Макросы → Импортировать</span></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-cyan-500 font-medium">4.</span>
                        <p>При первом запуске разрешите доступ скрипту</p>
                      </div>
                    </div>

                    <div className="rounded-xl overflow-hidden mt-4 border border-cyan-200 shadow-sm">
                      <img 
                        src="/images/apps-script-example.png" 
                        alt="Apps Script для создания отчета по проекту"
                        className="w-full h-auto"
                      />
                    </div>

                    <div className="flex flex-wrap gap-2 mt-4">
                      <a href="https://youtu.be/caG33Q4nkIc" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-red-50 to-pink-50 border border-red-200 rounded-lg text-red-700 hover:from-red-100 hover:to-pink-100 transition-all text-sm">
                        <Video className="h-3.5 w-3.5" /> Добавление макроса
                      </a>
                      <a href="https://youtu.be/UGW-dMFlqRE" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-red-50 to-pink-50 border border-red-200 rounded-lg text-red-700 hover:from-red-100 hover:to-pink-100 transition-all text-sm">
                        <Video className="h-3.5 w-3.5" /> Применение скрипта
                      </a>
                    </div>
                  </div>
                </div>
              </div>

              {/* Полезные скрипты */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-cyan-100 rounded-xl p-6 hover:border-cyan-300 hover:shadow-lg hover:shadow-cyan-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-cyan-500 to-teal-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-cyan-100 to-teal-100 rounded-xl group-hover:from-cyan-200 group-hover:to-teal-200 transition-colors shadow-sm">
                      <Filter className="h-5 w-5 text-cyan-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Полезные скрипты</h3>
                    
                    <div className="grid md:grid-cols-2 gap-3">
                      <div className="bg-gradient-to-r from-cyan-50/50 to-teal-50/50 rounded-lg p-3 border border-cyan-100">
                        <p className="text-gray-800 text-sm font-medium mb-1">Очистка email</p>
                        <p className="text-gray-500 text-xs">После запятой, после пробела</p>
                      </div>
                      <div className="bg-gradient-to-r from-cyan-50/50 to-teal-50/50 rounded-lg p-3 border border-cyan-100">
                        <p className="text-gray-800 text-sm font-medium mb-1">Очистка названий</p>
                        <p className="text-gray-500 text-xs">RUS и ENG версии</p>
                      </div>
                      <div className="bg-gradient-to-r from-cyan-50/50 to-teal-50/50 rounded-lg p-3 border border-cyan-100">
                        <p className="text-gray-800 text-sm font-medium mb-1">Оставить первое слово</p>
                        <p className="text-gray-500 text-xs">Для firstName в Apollo</p>
                      </div>
                      <div className="bg-gradient-to-r from-cyan-50/50 to-teal-50/50 rounded-lg p-3 border border-cyan-100">
                        <p className="text-gray-800 text-sm font-medium mb-1">Full name → First name</p>
                        <p className="text-gray-500 text-xs">Разделение ФИО</p>
                      </div>
                      <div className="bg-gradient-to-r from-cyan-50/50 to-teal-50/50 rounded-lg p-3 border border-cyan-100">
                        <p className="text-gray-800 text-sm font-medium mb-1">Очистка по ключевым словам</p>
                        <p className="text-gray-500 text-xs">Фильтрация базы 2ГИС</p>
                      </div>
                      <div className="bg-gradient-to-r from-cyan-50/50 to-teal-50/50 rounded-lg p-3 border border-cyan-100">
                        <p className="text-gray-800 text-sm font-medium mb-1">Достать текст с сайта</p>
                        <p className="text-gray-500 text-xs">Для персонализации</p>
                      </div>
                      <div className="bg-gradient-to-r from-cyan-50/50 to-teal-50/50 rounded-lg p-3 border border-cyan-100">
                        <p className="text-gray-800 text-sm font-medium mb-1">Сопоставление таблиц</p>
                        <p className="text-gray-500 text-xs">Объединение двух баз</p>
                      </div>
                      <div className="bg-gradient-to-r from-cyan-50/50 to-teal-50/50 rounded-lg p-3 border border-cyan-100">
                        <p className="text-gray-800 text-sm font-medium mb-1">Разделение email</p>
                        <p className="text-gray-500 text-xs">Из одной строки в несколько</p>
                      </div>
                    </div>

                    <div className="mt-4">
                      <a href="https://docs.google.com/document/d/1UzdHKo_dwICovxbCONdA5z4bKfwum96s5AoHGn_AO1A/edit" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-cyan-50 to-teal-50 border border-cyan-200 rounded-lg text-cyan-700 hover:from-cyan-100 hover:to-teal-100 hover:border-cyan-300 transition-all font-medium text-sm shadow-sm">
                        <Code className="h-3.5 w-3.5" /> Все скрипты в документе
                      </a>
                    </div>
                  </div>
                </div>
              </div>

              {/* Web Scraper */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-cyan-100 rounded-xl p-6 hover:border-cyan-300 hover:shadow-lg hover:shadow-cyan-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-cyan-500 to-teal-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-orange-100 to-amber-100 rounded-xl group-hover:from-orange-200 group-hover:to-amber-200 transition-colors shadow-sm">
                      <Globe className="h-5 w-5 text-orange-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Web Scraper</h3>
                    <p className="text-gray-600 text-sm mb-4">
                      Расширение для браузера для сбора данных с сайтов. По состоянию на 2025 год удалено из Chrome, но доступно в Firefox.
                    </p>

                    <div className="flex flex-wrap gap-2">
                      <a href="https://addons.mozilla.org/en-US/firefox/addon/web-scraper/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-orange-50 to-amber-50 border border-orange-200 rounded-lg text-orange-700 hover:from-orange-100 hover:to-amber-100 transition-all font-medium text-sm shadow-sm">
                        <Download className="h-3.5 w-3.5" /> Firefox Add-on
                      </a>
                      <a href="https://www.webscraper.io/documentation" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-gray-200 rounded-lg text-gray-600 hover:border-gray-300 transition-all text-sm">
                        Документация <ExternalLink className="h-3 w-3" />
                      </a>
                      <a href="https://youtu.be/HUIlsrri72o" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-2 bg-gradient-to-r from-red-50 to-pink-50 border border-red-200 rounded-lg text-red-700 hover:from-red-100 hover:to-pink-100 transition-all text-sm">
                        <Video className="h-3.5 w-3.5" /> Видео-разбор
                      </a>
                    </div>
                  </div>
                </div>
              </div>

              {/* Валидация email через нашу программу */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-cyan-100 rounded-xl p-6 hover:border-cyan-300 hover:shadow-lg hover:shadow-cyan-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-green-500 to-emerald-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-green-100 to-emerald-100 rounded-xl group-hover:from-green-200 group-hover:to-emerald-200 transition-colors shadow-sm">
                      <CheckCircle className="h-5 w-5 text-green-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg flex items-center gap-2">
                      Валидация email через нашу программу
                      <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">Рекомендуем</span>
                    </h3>
                    <p className="text-gray-600 text-sm mb-4">
                      Собственный валидатор с лучшими результатами чем LetsExtract. Требует открытый порт 25.
                    </p>

                    <a href="https://drive.google.com/file/d/11gXuXyWPHpfR8JOhLHlSMVbYc710EyH3/view?usp=sharing" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-lg text-green-700 hover:from-green-100 hover:to-emerald-100 transition-all font-medium text-sm shadow-sm mb-4">
                      <Download className="h-3.5 w-3.5" /> Скачать EmailValidator
                    </a>

                    <div className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-lg p-4 mb-4">
                      <p className="text-green-800 text-sm mb-2 font-medium">Как использовать:</p>
                      <ol className="text-green-700 text-sm space-y-1 list-decimal list-inside">
                        <li>Нажмите &quot;Загрузить файл&quot; для CSV/Excel</li>
                        <li>Выберите колонку с email адресами</li>
                        <li>Нажмите &quot;Запустить проверку&quot;</li>
                        <li>Дождитесь завершения</li>
                        <li>Нажмите &quot;Экспорт в CSV&quot; для сохранения</li>
                      </ol>
                    </div>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">Возможности:</p>
                      <ul className="text-gray-600 text-sm space-y-1">
                        <li>• Проверка синтаксиса email по RFC 5322</li>
                        <li>• Проверка существования домена</li>
                        <li>• SMTP верификация через порт 25</li>
                        <li>• Автокоррекция опечаток (gnail.com → gmail.com)</li>
                        <li>• Определение одноразовых email</li>
                        <li>• Детекция ролевых аккаунтов (info@, support@)</li>
                      </ul>
                    </div>

                    <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-3 mt-4">
                      <p className="text-amber-800 text-sm">
                        <span className="font-semibold">Важно:</span> Порт 25 должен быть открыт. Если не получается — используйте программу на удалённом рабочем столе.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Парсинг поисковой выдачи */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-cyan-100 rounded-xl p-6 hover:border-cyan-300 hover:shadow-lg hover:shadow-cyan-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-indigo-500 to-violet-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-indigo-100 to-violet-100 rounded-xl group-hover:from-indigo-200 group-hover:to-violet-200 transition-colors shadow-sm">
                      <Search className="h-5 w-5 text-indigo-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Парсинг поисковой выдачи (LetsExtract)</h3>
                    <p className="text-gray-600 text-sm mb-4">
                      Поисковую выдачу можно регулировать с помощью особых операторов для более точного поиска.
                    </p>

                    <div className="flex flex-wrap gap-2 mb-4">
                      <a href="https://journal.topvisor.com/ru/seo-kitchen/google-search-operators/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-gray-200 rounded-lg text-gray-600 hover:border-gray-300 transition-all text-sm">
                        Список операторов <ExternalLink className="h-3 w-3" />
                      </a>
                      <a href="https://aistudio.google.com/app/prompts?state=%7B%22ids%22:%5B%221BKXMbQTtHndPITAS9EFgjr4aHXAGw9g0%22%5D,%22action%22:%22open%22,%22userId%22:%22112464031614056669260%22,%22resourceKeys%22:%7B%7D%7D&usp=sharing" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-2 bg-gradient-to-r from-indigo-50 to-violet-50 border border-indigo-200 rounded-lg text-indigo-700 hover:from-indigo-100 hover:to-violet-100 transition-all text-sm">
                        <Bot className="h-3.5 w-3.5" /> Промпт для Gemini
                      </a>
                    </div>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mb-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">Пример запроса:</p>
                      <div className="bg-white border border-slate-200 rounded-lg p-3 font-mono text-xs text-gray-600 overflow-x-auto">
                        intitle:магазин (смартфоны OR ноутбуки OR телевизоры) Москва -ремонт -сервис -обзор -отзывы -авито
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-indigo-50 to-violet-50 border border-indigo-200 rounded-lg p-4">
                      <p className="text-indigo-800 text-sm mb-2 font-medium">Инструкция:</p>
                      <ol className="text-indigo-700 text-sm space-y-1 list-decimal list-inside">
                        <li>Составьте поисковой запрос с операторами</li>
                        <li>Нажмите поиск в Google и скопируйте ссылку</li>
                        <li>Откройте LetsExtract → &quot;Поиск по ключевым словам&quot;</li>
                        <li>Выберите &quot;Стандартный поиск&quot; и вставьте ссылку</li>
                        <li>Запустите парсинг</li>
                      </ol>
                    </div>

                    <p className="text-gray-500 text-xs mt-3">
                      Совет: Попросите ChatGPT или Gemini составить поисковый запрос по вашим указаниям.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Использование нейросетей */}
        <section id="ai-tools" className="relative overflow-hidden rounded-2xl shadow-xl border border-fuchsia-200">
          <div className="absolute inset-0 bg-gradient-to-br from-fuchsia-50 via-white to-pink-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-fuchsia-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-fuchsia-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-fuchsia-500 to-pink-500 rounded-xl shadow-lg">
                  <Bot className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-fuchsia-600 to-pink-600 bg-clip-text text-transparent">
                  Использование нейросетей
                </h2>
                <p className="text-sm text-gray-500 mt-1">ChatGPT, Gemini для персонализации и автоматизации</p>
              </div>
            </div>

            <div className="space-y-6">
              {/* Персонализация через GPT */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-fuchsia-100 rounded-xl p-6 hover:border-fuchsia-300 hover:shadow-lg hover:shadow-fuchsia-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-fuchsia-500 to-pink-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-fuchsia-100 to-pink-100 rounded-xl group-hover:from-fuchsia-200 group-hover:to-pink-200 transition-colors shadow-sm">
                      <Wand2 className="h-5 w-5 text-fuchsia-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Персонализация через ChatGPT в Google Таблицах</h3>
                    <p className="text-gray-600 text-sm mb-4">
                      Персонализация добавляет индивидуальности в письмо: упоминание конкурентов, комплимент о новости компании, полезный совет. Такие письма показывают намного большую результативность.
                    </p>

                    <div className="space-y-4">
                      <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4">
                        <p className="text-gray-700 text-sm mb-2 font-medium">1. Установите расширение:</p>
                        <a href="https://workspace.google.com/marketplace/app/gpt_for_sheets_and_docs/677318054654" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-fuchsia-50 to-pink-50 border border-fuchsia-200 rounded-lg text-fuchsia-700 hover:from-fuchsia-100 hover:to-pink-100 transition-all text-sm">
                          GPT for Sheets and Docs <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>

                      <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4">
                        <p className="text-gray-700 text-sm mb-2 font-medium">2. Настройте API:</p>
                        <p className="text-gray-600 text-sm">Расширения → GPT → Открыть → API Keys → Модель <span className="font-mono bg-slate-100 px-1 rounded">gpt-4o-mini</span> (дешевле)</p>
                        <p className="text-gray-500 text-xs mt-1">API ключ запросите у Дениса или Никиты</p>
                      </div>

                      <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4">
                        <p className="text-gray-700 text-sm mb-2 font-medium">3. Подготовьте таблицу:</p>
                        <p className="text-gray-600 text-sm">Перед каждым столбцом с данными создайте столбец с названием категории (Наименование | [данные] | Описание | [данные] и т.д.)</p>
                      </div>

                      <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4">
                        <p className="text-gray-700 text-sm mb-2 font-medium">4. Формула:</p>
                        <p className="text-gray-600 text-sm font-mono bg-slate-100 p-2 rounded">=GPT($G$1; A2:F2)</p>
                        <p className="text-gray-500 text-xs mt-1">$G$1 — ячейка с промптом, A2:F2 — данные организации</p>
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-red-50 to-orange-50 border border-red-200 rounded-lg p-4 mt-4">
                      <p className="text-red-700 text-sm leading-relaxed flex items-start gap-2">
                        <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                        <span><span className="font-semibold">Важно:</span> После генерации сразу выделите столбец → Ctrl+C → Ctrl+Shift+V (вставить как текст). Это зафиксирует результат и не даст формулам обновляться (экономия токенов!).</span>
                      </p>
                    </div>

                    <div className="mt-4">
                      <a href="https://youtu.be/-kIZLuZd45Y" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-red-50 to-pink-50 border border-red-200 rounded-lg text-red-700 hover:from-red-100 hover:to-pink-100 transition-all font-medium text-sm shadow-sm">
                        <Video className="h-3.5 w-3.5" /> Видео от Данилы с примером
                      </a>
                    </div>
                  </div>
                </div>
              </div>

              {/* Пример промпта */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-fuchsia-100 rounded-xl p-6 hover:border-fuchsia-300 hover:shadow-lg hover:shadow-fuchsia-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-fuchsia-500 to-pink-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-fuchsia-100 to-pink-100 rounded-xl group-hover:from-fuchsia-200 group-hover:to-pink-200 transition-colors shadow-sm">
                      <FileText className="h-5 w-5 text-fuchsia-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Пример промпта для персонализации</h3>
                    
                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 text-sm text-gray-700 leading-relaxed">
                      <p className="mb-3"><span className="font-medium">Структура промпта:</span></p>
                      <ol className="list-decimal list-inside space-y-2 mb-4">
                        <li>Описание вашей компании (кто вы, какие услуги, какие проблемы решаете)</li>
                        <li>Требования к генерации (формат, стиль, длина)</li>
                        <li>Примеры хороших персонализаций</li>
                      </ol>
                      
                      <div className="bg-white border border-slate-200 rounded-lg p-3 italic text-gray-600">
                        &quot;Я генеральный директор компании X, которая предоставляет услуги Y. Напиши 2-3 коротких предложения не более 20 слов для email письма. В первом объясни, почему я решил связаться именно с этой компанией. Пиши от моего имени, сделай небольшой комплимент. Используй дружелюбный, но деловой стиль. Избегай рекламных предложений.&quot;
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-lg p-4 mt-4">
                      <p className="text-green-800 text-sm mb-2 font-medium">Пример хорошей персонализации:</p>
                      <p className="text-green-700 text-sm italic">
                        &quot;Заметила, что вы работаете в сфере недвижимости и, скорее всего, сталкиваетесь с необходимостью привлекать новых клиентов. Решила написать, так как моя команда может сделать работу с таргетированной рекламой максимально эффективной.&quot;
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Скрипты для корректировки */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-fuchsia-100 rounded-xl p-6 hover:border-fuchsia-300 hover:shadow-lg hover:shadow-fuchsia-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-fuchsia-500 to-pink-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-fuchsia-100 to-pink-100 rounded-xl group-hover:from-fuchsia-200 group-hover:to-pink-200 transition-colors shadow-sm">
                      <Code className="h-5 w-5 text-fuchsia-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Скрипты для корректировки базы перед GPT</h3>
                    <p className="text-gray-600 text-sm mb-4">
                      Базу из Apollo нужно откорректировать: упростить названия компаний, отделить имена от фамилий, укоротить должности.
                    </p>

                    <div className="grid md:grid-cols-2 gap-3">
                      <div className="bg-gradient-to-r from-fuchsia-50/50 to-pink-50/50 rounded-lg p-3 border border-fuchsia-100">
                        <p className="text-gray-800 text-sm font-medium mb-1">Сокращение тайтлов</p>
                        <p className="text-gray-500 text-xs">Vice President → VP, Chief Executive Officer → CEO</p>
                      </div>
                      <div className="bg-gradient-to-r from-fuchsia-50/50 to-pink-50/50 rounded-lg p-3 border border-fuchsia-100">
                        <p className="text-gray-800 text-sm font-medium mb-1">Сокращение названий компаний</p>
                        <p className="text-gray-500 text-xs">Убирает ltd, всё после запятой и тире</p>
                      </div>
                      <div className="bg-gradient-to-r from-fuchsia-50/50 to-pink-50/50 rounded-lg p-3 border border-fuchsia-100">
                        <p className="text-gray-800 text-sm font-medium mb-1">Извлечение текста с сайта</p>
                        <p className="text-gray-500 text-xs">Для персонализации по информации с сайта</p>
                      </div>
                      <div className="bg-gradient-to-r from-fuchsia-50/50 to-pink-50/50 rounded-lg p-3 border border-fuchsia-100">
                        <p className="text-gray-800 text-sm font-medium mb-1">Персонализация через скрипт</p>
                        <p className="text-gray-500 text-xs">Дешевле чем через расширение</p>
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-4 mt-4">
                      <p className="text-amber-800 text-sm leading-relaxed">
                        <span className="font-semibold">Совет:</span> Если название длиннее 3 слов — можно сократить по первым буквам. Всегда проверяйте результат работы скрипта!
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Стоимость токенов */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-fuchsia-100 rounded-xl p-6 hover:border-fuchsia-300 hover:shadow-lg hover:shadow-fuchsia-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-fuchsia-500 to-pink-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-fuchsia-100 to-pink-100 rounded-xl group-hover:from-fuchsia-200 group-hover:to-pink-200 transition-colors shadow-sm">
                      <BarChart3 className="h-5 w-5 text-fuchsia-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Стоимость токенов GPT</h3>
                    
                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4">
                      <p className="text-gray-700 text-sm mb-3">Примерная стоимость (модель gpt-4o-mini):</p>
                      <div className="grid grid-cols-3 gap-4 text-center">
                        <div className="bg-white border border-slate-200 rounded-lg p-3">
                          <p className="text-2xl font-bold text-fuchsia-600">~$0.01</p>
                          <p className="text-gray-500 text-xs">1 строка</p>
                        </div>
                        <div className="bg-white border border-slate-200 rounded-lg p-3">
                          <p className="text-2xl font-bold text-fuchsia-600">~$1</p>
                          <p className="text-gray-500 text-xs">100 строк</p>
                        </div>
                        <div className="bg-white border border-slate-200 rounded-lg p-3">
                          <p className="text-2xl font-bold text-fuchsia-600">~$5</p>
                          <p className="text-gray-500 text-xs">500 строк</p>
                        </div>
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-red-50 to-orange-50 border border-red-200 rounded-lg p-4 mt-4">
                      <p className="text-red-700 text-sm leading-relaxed">
                        <span className="font-semibold">Важно:</span> Не растягивайте сразу на всю базу! Сначала сделайте 5-10 строк и согласуйте с руководителем. За каждую строку снимается оплата.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Создание API ключа */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-fuchsia-100 rounded-xl p-6 hover:border-fuchsia-300 hover:shadow-lg hover:shadow-fuchsia-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-fuchsia-500 to-pink-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-fuchsia-100 to-pink-100 rounded-xl group-hover:from-fuchsia-200 group-hover:to-pink-200 transition-colors shadow-sm">
                      <Shield className="h-5 w-5 text-fuchsia-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Создание API-ключа OpenAI</h3>
                    
                    <div className="space-y-3 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-fuchsia-500 font-medium">1.</span>
                        <p>Включите VPN и перейдите на <a href="https://platform.openai.com/docs/overview" target="_blank" rel="noopener noreferrer" className="text-fuchsia-600 hover:underline">platform.openai.com</a></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-fuchsia-500 font-medium">2.</span>
                        <p>Вкладка <span className="font-medium">&quot;API keys&quot;</span> → <span className="font-medium">&quot;Create new secret key&quot;</span></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-fuchsia-500 font-medium">3.</span>
                        <p>Во вкладке <span className="font-medium">&quot;Usage&quot;</span> можно отслеживать траты</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Gemini */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-fuchsia-100 rounded-xl p-6 hover:border-fuchsia-300 hover:shadow-lg hover:shadow-fuchsia-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-fuchsia-500 to-pink-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-blue-100 to-indigo-100 rounded-xl group-hover:from-blue-200 group-hover:to-indigo-200 transition-colors shadow-sm">
                      <Sparkles className="h-5 w-5 text-blue-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Gemini — бесплатная альтернатива для чистки баз</h3>
                    
                    <div className="space-y-4">
                      <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4">
                        <p className="text-gray-700 text-sm mb-2 font-medium">Шаг 1 — VPN:</p>
                        <p className="text-gray-600 text-sm">Нужен VPN с США. Подойдёт <a href="https://chromewebstore.google.com/detail/%D0%B1%D0%B5%D1%81%D0%BF%D0%BB%D0%B0%D1%82%D0%BD%D1%8B%D0%B9-vpn-%D0%B4%D0%BB%D1%8F-chrome/majdfhpaihoncoakbjgbdhglocklcgno" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">VeePN</a></p>
                      </div>

                      <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4">
                        <p className="text-gray-700 text-sm mb-2 font-medium">Шаг 2 — Заходим на Gemini:</p>
                        <p className="text-gray-600 text-sm mb-2">Регистрация не нужна — только вход в Google-аккаунт</p>
                        <a href="https://aistudio.google.com/app/prompts/new_chat" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg text-blue-700 hover:from-blue-100 hover:to-indigo-100 transition-all text-sm">
                          AI Studio <ExternalLink className="h-3 w-3" />
                        </a>
                        <p className="text-gray-500 text-xs mt-2">Рекомендуем модель: Gemini 1.5 PRO</p>
                      </div>

                      <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4">
                        <p className="text-gray-700 text-sm mb-2 font-medium">Шаг 3 — Как чистить контакты:</p>
                        <p className="text-gray-600 text-sm">Максимально подробно и с примерами объясните, что нужно сделать. Скопируйте названия и сайты компаний, нажмите Run.</p>
                      </div>

                      <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4">
                        <p className="text-gray-700 text-sm mb-2 font-medium">Шаг 4 — Проверка:</p>
                        <p className="text-gray-600 text-sm">Добавьте столбец в таблице, вставьте результат через <span className="font-mono bg-slate-100 px-1 rounded">Ctrl+Shift+V</span>. Проверьте количество строк!</p>
                      </div>

                      <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-4">
                        <p className="text-amber-800 text-sm leading-relaxed">
                          <span className="font-semibold">Важно:</span> Нейросеть делает НЕ идеально — всегда проверяйте результат. Можно натренировать Gemini под любой запрос с помощью подробного промпта и примеров.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Калькулятор KPI */}
        <section id="kpi-calculator" className="relative overflow-hidden rounded-2xl shadow-xl border border-lime-200">
          <div className="absolute inset-0 bg-gradient-to-br from-lime-50 via-white to-green-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-lime-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-lime-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-lime-500 to-green-500 rounded-xl shadow-lg">
                  <Calculator className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-lime-600 to-green-600 bg-clip-text text-transparent">
                  Калькулятор KPI проекта
                </h2>
                <p className="text-sm text-gray-500 mt-1">Расчёт ключевых показателей эффективности</p>
              </div>
            </div>

            <div className="space-y-6">
              <div className="group relative bg-white/80 backdrop-blur-sm border border-lime-100 rounded-xl p-6 hover:border-lime-300 hover:shadow-lg hover:shadow-lime-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-lime-500 to-green-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-lime-100 to-green-100 rounded-xl group-hover:from-lime-200 group-hover:to-green-200 transition-colors shadow-sm">
                      <BarChart3 className="h-5 w-5 text-lime-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Основные KPI для отслеживания</h3>
                    
                    <div className="grid md:grid-cols-2 gap-4">
                      <div className="bg-gradient-to-r from-lime-50/50 to-green-50/50 rounded-lg p-4 border border-lime-100">
                        <p className="text-lime-700 font-medium text-sm mb-1">Open Rate (OR)</p>
                        <p className="text-gray-600 text-xs">Процент открытий писем</p>
                        <p className="text-lime-600 font-semibold mt-2">Норма: 40-60%</p>
                      </div>
                      <div className="bg-gradient-to-r from-lime-50/50 to-green-50/50 rounded-lg p-4 border border-lime-100">
                        <p className="text-lime-700 font-medium text-sm mb-1">Reply Rate (RR)</p>
                        <p className="text-gray-600 text-xs">Процент ответов</p>
                        <p className="text-lime-600 font-semibold mt-2">Норма: 3-10%</p>
                      </div>
                      <div className="bg-gradient-to-r from-lime-50/50 to-green-50/50 rounded-lg p-4 border border-lime-100">
                        <p className="text-lime-700 font-medium text-sm mb-1">Positive Reply Rate</p>
                        <p className="text-gray-600 text-xs">Процент позитивных ответов</p>
                        <p className="text-lime-600 font-semibold mt-2">Норма: 1-5%</p>
                      </div>
                      <div className="bg-gradient-to-r from-lime-50/50 to-green-50/50 rounded-lg p-4 border border-lime-100">
                        <p className="text-lime-700 font-medium text-sm mb-1">Meeting Rate</p>
                        <p className="text-gray-600 text-xs">Процент назначенных встреч</p>
                        <p className="text-lime-600 font-semibold mt-2">Норма: 0.5-2%</p>
                      </div>
                    </div>

                    <div className="mt-4">
                      <a href="https://docs.google.com/spreadsheets/d/your-kpi-calculator" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-lime-50 to-green-50 border border-lime-200 rounded-lg text-lime-700 hover:from-lime-100 hover:to-green-100 hover:border-lime-300 transition-all font-medium text-sm shadow-sm">
                        <Table className="h-3.5 w-3.5" /> Калькулятор KPI (Google Sheets)
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Ретаргет */}
        <section id="retarget" className="relative overflow-hidden rounded-2xl shadow-xl border border-rose-200">
          <div className="absolute inset-0 bg-gradient-to-br from-rose-50 via-white to-pink-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-rose-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-rose-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-rose-500 to-pink-500 rounded-xl shadow-lg">
                  <Target className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-rose-600 to-pink-600 bg-clip-text text-transparent">
                  Регламент по ретаргету
                </h2>
                <p className="text-sm text-gray-500 mt-1">Повторные касания с базой</p>
              </div>
            </div>

            <div className="space-y-6">
              <div className="group relative bg-white/80 backdrop-blur-sm border border-rose-100 rounded-xl p-6 hover:border-rose-300 hover:shadow-lg hover:shadow-rose-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-rose-500 to-pink-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-rose-100 to-pink-100 rounded-xl group-hover:from-rose-200 group-hover:to-pink-200 transition-colors shadow-sm">
                      <ArrowRight className="h-5 w-5 text-rose-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Когда делать ретаргет</h3>
                    
                    <p className="text-gray-600 text-sm mb-4">
                      Ретаргет — это повторное касание с базой, которая уже прошла через рассылку. Делается через 2-3 месяца после первой кампании.
                    </p>

                    <div className="space-y-3 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-rose-500 font-medium">1.</span>
                        <p>Выгрузите базу тех, кто <span className="font-medium">не ответил</span> на предыдущую рассылку</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-rose-500 font-medium">2.</span>
                        <p>Исключите тех, кто отписался или попросил не писать</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-rose-500 font-medium">3.</span>
                        <p>Подготовьте <span className="font-medium">новый оффер</span> — не повторяйте старый!</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-rose-500 font-medium">4.</span>
                        <p>Можно использовать триггер: &quot;Писали вам пару месяцев назад...&quot;</p>
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-lg p-4 mt-4">
                      <p className="text-green-800 text-sm leading-relaxed">
                        <span className="font-semibold">Эффективность:</span> Ретаргет часто показывает результаты лучше, чем первичная рассылка, т.к. люди уже знакомы с вашим брендом.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Тестовый период */}
        <section id="test-period" className="relative overflow-hidden rounded-2xl shadow-xl border border-teal-200">
          <div className="absolute inset-0 bg-gradient-to-br from-teal-50 via-white to-cyan-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-teal-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-teal-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-teal-500 to-cyan-500 rounded-xl shadow-lg">
                  <Clock className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-teal-600 to-cyan-600 bg-clip-text text-transparent">
                  Тестовый период — регламент
                </h2>
                <p className="text-sm text-gray-500 mt-1">Работа с проектами на тесте</p>
              </div>
            </div>

            <div className="space-y-6">
              {/* Что это */}
              <div className="bg-white/80 backdrop-blur-sm border border-teal-100 rounded-xl p-6">
                <h3 className="font-semibold text-gray-900 mb-4 text-lg">Что это?</h3>
                <p className="text-gray-600 leading-relaxed">
                  Тестовый период — это период, в котором мы демонстрируем свою работу и приводим первых <span className="font-semibold">5 лидов</span>. Это не бесплатная работа — наша цель продлить заказчика на договор (платную основу), и лиды за тест учитываются в KPI (только квалифицированные лиды).
                </p>
              </div>

              {/* Этапы */}
              <div className="bg-white/80 backdrop-blur-sm border border-teal-100 rounded-xl p-6">
                <h3 className="font-semibold text-gray-900 mb-4 text-lg">Этапы тестового периода</h3>
                <div className="space-y-3 text-sm text-gray-600">
                  <div className="flex items-start gap-3 p-3 bg-gradient-to-r from-teal-50/50 to-cyan-50/50 rounded-lg">
                    <span className="w-6 h-6 flex items-center justify-center bg-teal-500 text-white text-xs font-bold rounded-md flex-shrink-0">1</span>
                    <p><span className="font-medium">Переговоры</span> — аккаунт обсуждает условия, нюансы, цели</p>
                  </div>
                  <div className="flex items-start gap-3 p-3 bg-gradient-to-r from-teal-50/50 to-cyan-50/50 rounded-lg">
                    <span className="w-6 h-6 flex items-center justify-center bg-teal-500 text-white text-xs font-bold rounded-md flex-shrink-0">2</span>
                    <p><span className="font-medium">Создание чата</span> — отдельный чат с аккаунтом, старшим спецом, специалистом, гендиром и основателем бизнеса</p>
                  </div>
                  <div className="flex items-start gap-3 p-3 bg-gradient-to-r from-teal-50/50 to-cyan-50/50 rounded-lg">
                    <span className="w-6 h-6 flex items-center justify-center bg-teal-500 text-white text-xs font-bold rounded-md flex-shrink-0">3</span>
                    <p><span className="font-medium">Таймлайн</span> — расписание от брифа до запуска первой кампании + ссылки</p>
                  </div>
                  <div className="flex items-start gap-3 p-3 bg-gradient-to-r from-teal-50/50 to-cyan-50/50 rounded-lg">
                    <span className="w-6 h-6 flex items-center justify-center bg-teal-500 text-white text-xs font-bold rounded-md flex-shrink-0">4</span>
                    <p><span className="font-medium">Подготовка</span> — спец готовит, аккаунт и старший спец контролируют</p>
                  </div>
                  <div className="flex items-start gap-3 p-3 bg-gradient-to-r from-teal-50/50 to-cyan-50/50 rounded-lg">
                    <span className="w-6 h-6 flex items-center justify-center bg-teal-500 text-white text-xs font-bold rounded-md flex-shrink-0">5</span>
                    <p><span className="font-medium">Запуск</span> — запуск первой кампании, отписаться в чат</p>
                  </div>
                  <div className="flex items-start gap-3 p-3 bg-gradient-to-r from-teal-50/50 to-cyan-50/50 rounded-lg">
                    <span className="w-6 h-6 flex items-center justify-center bg-teal-500 text-white text-xs font-bold rounded-md flex-shrink-0">6</span>
                    <p><span className="font-medium">Выполнение KPI</span> — привести 5 тестовых лидов, передать на email из брифа</p>
                  </div>
                  <div className="flex items-start gap-3 p-3 bg-gradient-to-r from-teal-50/50 to-cyan-50/50 rounded-lg">
                    <span className="w-6 h-6 flex items-center justify-center bg-teal-500 text-white text-xs font-bold rounded-md flex-shrink-0">7</span>
                    <p><span className="font-medium">Отчёт и звонок</span> — демонстрация отчёта, новых гипотез, KPI и подписание договора</p>
                  </div>
                  <div className="flex items-start gap-3 p-3 bg-gradient-to-r from-teal-50/50 to-cyan-50/50 rounded-lg">
                    <span className="w-6 h-6 flex items-center justify-center bg-teal-500 text-white text-xs font-bold rounded-md flex-shrink-0">8</span>
                    <p><span className="font-medium">Оформление в кейс</span> и создание закрепа с гипотезами, ссылками на таблицу лидов</p>
                  </div>
                </div>
              </div>

              {/* Сроки и роли */}
              <div className="grid md:grid-cols-2 gap-4">
                <div className="bg-white/80 backdrop-blur-sm border border-teal-100 rounded-xl p-6">
                  <h3 className="font-semibold text-gray-900 mb-3 text-lg">Сколько длится?</h3>
                  <p className="text-gray-600 text-sm">
                    <span className="font-semibold text-teal-600">2-3 недели</span> с момента запуска. В тяжёлых нишах — до <span className="font-semibold">5 недель</span>.
                  </p>
                  <p className="text-gray-500 text-xs mt-2">600-1000 контактов — достаточно чтобы понять есть ли лиды</p>
                </div>
                <div className="bg-white/80 backdrop-blur-sm border border-teal-100 rounded-xl p-6">
                  <h3 className="font-semibold text-gray-900 mb-3 text-lg">Кто ведёт?</h3>
                  <p className="text-gray-600 text-sm">
                    Все специалисты компании. Оплата премией <span className="font-semibold">только после подписания договора</span> и перехода в платные проекты.
                  </p>
                </div>
              </div>

              {/* Ответственность */}
              <div className="bg-white/80 backdrop-blur-sm border border-teal-100 rounded-xl p-6">
                <h3 className="font-semibold text-gray-900 mb-4 text-lg">Роли и ответственность</h3>
                <div className="grid md:grid-cols-2 gap-3">
                  <div className="bg-gradient-to-r from-teal-50/50 to-cyan-50/50 rounded-lg p-4 border border-teal-100">
                    <p className="text-gray-800 text-sm font-medium mb-1">Проджект-менеджер</p>
                    <p className="text-gray-500 text-xs">Контроль, управление, решение спорных ситуаций</p>
                  </div>
                  <div className="bg-gradient-to-r from-teal-50/50 to-cyan-50/50 rounded-lg p-4 border border-teal-100">
                    <p className="text-gray-800 text-sm font-medium mb-1">Старший специалист</p>
                    <p className="text-gray-500 text-xs">Контроль работы, проверка офферов/баз/кампаний, экспертность</p>
                  </div>
                  <div className="bg-gradient-to-r from-teal-50/50 to-cyan-50/50 rounded-lg p-4 border border-teal-100">
                    <p className="text-gray-800 text-sm font-medium mb-1">Специалист</p>
                    <p className="text-gray-500 text-xs">Подготовка, запуск, генерация гипотез, выполнение KPI</p>
                  </div>
                  <div className="bg-gradient-to-r from-teal-50/50 to-cyan-50/50 rounded-lg p-4 border border-teal-100">
                    <p className="text-gray-800 text-sm font-medium mb-1">Генеральный директор</p>
                    <p className="text-gray-500 text-xs">Критические вопросы: договор, деньги, работа команды</p>
                  </div>
                </div>
                <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-3 mt-4">
                  <p className="text-amber-800 text-xs">
                    <span className="font-semibold">Важно:</span> Все изменения условий работы согласуются через генерального директора.
                  </p>
                </div>
              </div>

              {/* Что делать если тест плохо */}
              <div className="bg-white/80 backdrop-blur-sm border border-teal-100 rounded-xl p-6">
                <h3 className="font-semibold text-gray-900 mb-4 text-lg">Что делать если тест идёт плохо?</h3>
                <div className="space-y-4">
                  <div className="flex items-start gap-3 p-4 bg-gradient-to-r from-yellow-50 to-amber-50 rounded-lg border border-yellow-200">
                    <span className="text-yellow-600 font-bold">1 нед</span>
                    <p className="text-gray-700 text-sm">Нет лидов/интереса — руководитель спрашивает спеца что улучшить, корректирует идеи</p>
                  </div>
                  <div className="flex items-start gap-3 p-4 bg-gradient-to-r from-orange-50 to-amber-50 rounded-lg border border-orange-200">
                    <span className="text-orange-600 font-bold">2 нед</span>
                    <p className="text-gray-700 text-sm">Нет улучшений — созвон со спецом. Если проблема в проекте — созвон всех вместе, новые гипотезы</p>
                  </div>
                  <div className="flex items-start gap-3 p-4 bg-gradient-to-r from-red-50 to-orange-50 rounded-lg border border-red-200">
                    <span className="text-red-600 font-bold">3 нед</span>
                    <p className="text-gray-700 text-sm">Метрики не растут — отказываемся (или берём деньги за тесты). Растут недостаточно — увеличиваем мощность</p>
                  </div>
                </div>

                <div className="bg-gradient-to-r from-teal-50 to-cyan-50 border border-teal-200 rounded-lg p-4 mt-4">
                  <p className="text-teal-800 text-sm font-medium mb-2">Что можно протестировать для улучшения:</p>
                  <ul className="text-teal-700 text-sm space-y-1">
                    <li>• Переписать оффер (сменить посыл, добавить/убрать кейсы, СТА)</li>
                    <li>• Сменить базу (другой сегмент, гео)</li>
                    <li>• Анализ конкурентов (у кого предложение интереснее)</li>
                    <li>• Звонок с РОП/ЛПР (уточнить каналы лидов, возражения, запросить базы отказников)</li>
                  </ul>
                </div>
              </div>

              {/* Причины закрытия */}
              <div className="bg-gradient-to-r from-red-50 to-orange-50 border border-red-200 rounded-xl p-6">
                <h3 className="font-semibold text-red-800 mb-3 flex items-center gap-2">
                  <AlertCircle className="h-5 w-5" />
                  Причины досрочного закрытия теста
                </h3>
                <ul className="text-red-700 text-sm space-y-2">
                  <li>• Отсутствие лидов и интереса (протестированы разные гипотезы, сегменты, общались с РОП)</li>
                  <li>• Игнор и отсутствие обработки лидов от заказчика</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Как проводить звонок при закрытии теста */}
        <section id="test-call" className="relative overflow-hidden rounded-2xl shadow-xl border border-blue-200">
          <div className="absolute inset-0 bg-gradient-to-br from-blue-50 via-white to-indigo-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-blue-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-blue-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-blue-500 to-indigo-500 rounded-xl shadow-lg">
                  <Video className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
                  Как проводить звонок при закрытии теста
                </h2>
                <p className="text-sm text-gray-500 mt-1">Презентация отчёта и результатов</p>
              </div>
            </div>

            <div className="bg-white/80 backdrop-blur-sm border border-blue-100 rounded-xl p-6 mb-6">
              <p className="text-gray-600 leading-relaxed mb-4">
                Предоставляем отчётность в стандартном виде — в таблице лидов и отчёта. <span className="font-medium">Даже если всё видно — всё равно рассказываем</span>, т.к. не все клиенты смотрят статистику.
              </p>

              <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-4">
                <p className="text-blue-800 text-sm font-medium mb-3">О чём рассказываем при демонстрации:</p>
                <ul className="text-blue-700 text-sm space-y-2">
                  <li>• <span className="font-medium">Какие гипотезы прошли</span> — что работало</li>
                  <li>• <span className="font-medium">Как отработали базы</span> — хорошо/плохо и почему</li>
                  <li>• <span className="font-medium">Что можем сделать</span> для улучшения результатов</li>
                  <li>• <span className="font-medium">Какие темы открывали</span> больше/меньше, что ещё протестить</li>
                  <li>• <span className="font-medium">Гипотезы на следующий период</span> — чем больше, тем лучше (показываем что есть над чем работать)</li>
                </ul>
              </div>
            </div>

            <a href="https://youtu.be/cHu3UeXmj3M" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-red-50 to-pink-50 border border-red-200 rounded-lg text-red-700 hover:from-red-100 hover:to-pink-100 transition-all font-medium text-sm shadow-sm">
              <Video className="h-4 w-4" /> Запись звонка с клиентом (пример)
            </a>
          </div>
        </section>

        {/* Оценка релевантности базы и цепочки */}
        <section id="relevance-check" className="relative overflow-hidden rounded-2xl shadow-xl border border-purple-200">
          <div className="absolute inset-0 bg-gradient-to-br from-purple-50 via-white to-fuchsia-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-purple-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-purple-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-purple-500 to-fuchsia-500 rounded-xl shadow-lg">
                  <Target className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-purple-600 to-fuchsia-600 bg-clip-text text-transparent">
                  Оценка релевантности базы и цепочки
                </h2>
                <p className="text-sm text-gray-500 mt-1">Способы оценки на ранних стадиях</p>
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              {/* Цепочка */}
              <div className="bg-white/80 backdrop-blur-sm border border-purple-100 rounded-xl p-6">
                <h3 className="font-semibold text-gray-900 mb-4 text-lg flex items-center gap-2">
                  <Mail className="h-5 w-5 text-purple-500" />
                  Цепочка
                </h3>
                <ul className="text-gray-600 text-sm space-y-3">
                  <li className="flex items-start gap-2">
                    <span className="text-purple-500 mt-1">•</span>
                    <span><span className="font-medium">Отвечаемость</span> — особенно на 2-е сообщение (если готовы к звонку — оффер сработал)</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-purple-500 mt-1">•</span>
                    <span><span className="font-medium">Темы писем</span> — от 3х тем в тест, отключать низкий %. Вывод после 50+ писем каждой темы</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-purple-500 mt-1">•</span>
                    <span><span className="font-medium">Переходы на сайт</span> — Яндекс.Метрика: интерес к офферу и активность</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-purple-500 mt-1">•</span>
                    <span><span className="font-medium">Персонализация</span> — комплимент компании → больше внимания → больше ответов</span>
                  </li>
                </ul>
              </div>

              {/* Базы */}
              <div className="bg-white/80 backdrop-blur-sm border border-purple-100 rounded-xl p-6">
                <h3 className="font-semibold text-gray-900 mb-4 text-lg flex items-center gap-2">
                  <Database className="h-5 w-5 text-purple-500" />
                  Базы
                </h3>
                <ul className="text-gray-600 text-sm space-y-3">
                  <li className="flex items-start gap-2">
                    <span className="text-purple-500 mt-1">•</span>
                    <span><span className="font-medium">Качество email</span> — если много отваливаются → проверить через валидатор</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-purple-500 mt-1">•</span>
                    <span><span className="font-medium">ОС от заказчика</span> — совпадает ли запрос лида с продуктом</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-purple-500 mt-1">•</span>
                    <span><span className="font-medium">Отклик базы</span> — много негатива или нет интереса → менять базу</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-purple-500 mt-1">•</span>
                    <span><span className="font-medium">География</span> — откуда лучший отклик (Москва, СПб, Самара)</span>
                  </li>
                </ul>
              </div>
            </div>

            <div className="bg-gradient-to-r from-purple-50 to-fuchsia-50 border border-purple-200 rounded-lg p-4 mt-6">
              <p className="text-purple-800 text-sm leading-relaxed flex items-start gap-2">
                <span className="font-semibold">Важно:</span> Отслеживайте статистику по каждой кампании и делайте сравнительный анализ — вовремя исключайте гипотезы, которые не работают.
              </p>
              <a href="https://docs.google.com/spreadsheets/d/16yRYOcIPMZrrGrvmWubfVkcb_8ioBZR7BdGToWs9n34/edit?usp=sharing" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-purple-200 rounded-lg text-purple-700 hover:border-purple-300 transition-all text-sm mt-3">
                Таблица оценки кампаний <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        </section>

        {/* Подробный план работы спеца */}
        <section id="improvement-plan" className="relative overflow-hidden rounded-2xl shadow-xl border border-emerald-200">
          <div className="absolute inset-0 bg-gradient-to-br from-emerald-50 via-white to-green-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-emerald-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-emerald-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-emerald-500 to-green-500 rounded-xl shadow-lg">
                  <Target className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-emerald-600 to-green-600 bg-clip-text text-transparent">
                  План работы над улучшением результатов
                </h2>
                <p className="text-sm text-gray-500 mt-1">Пошаговая инструкция для специалиста</p>
              </div>
            </div>

            <div className="space-y-6">
              {/* Этап 1: Базовые способы */}
              <div className="bg-white/80 backdrop-blur-sm border border-emerald-100 rounded-xl p-6">
                <h3 className="font-semibold text-gray-900 mb-4 text-lg flex items-center gap-2">
                  <span className="w-8 h-8 flex items-center justify-center bg-emerald-500 text-white font-bold rounded-lg">1</span>
                  Базовые способы
                </h3>
                <p className="text-gray-600 text-sm mb-4">
                  Первым делом опробуйте примитивные способы — сбор целевой базы из:
                </p>
                <div className="grid md:grid-cols-2 gap-2 mb-4">
                  <div className="bg-gradient-to-r from-emerald-50/50 to-green-50/50 rounded-lg p-3 border border-emerald-100 text-sm text-gray-700">hh.ru</div>
                  <div className="bg-gradient-to-r from-emerald-50/50 to-green-50/50 rounded-lg p-3 border border-emerald-100 text-sm text-gray-700">2ГИС</div>
                  <div className="bg-gradient-to-r from-emerald-50/50 to-green-50/50 rounded-lg p-3 border border-emerald-100 text-sm text-gray-700">Селеком</div>
                  <div className="bg-gradient-to-r from-emerald-50/50 to-green-50/50 rounded-lg p-3 border border-emerald-100 text-sm text-gray-700">Архив баз 70+</div>
                  <div className="bg-gradient-to-r from-emerald-50/50 to-green-50/50 rounded-lg p-3 border border-emerald-100 text-sm text-gray-700">B2B House по ОКВЭД</div>
                  <div className="bg-gradient-to-r from-emerald-50/50 to-green-50/50 rounded-lg p-3 border border-emerald-100 text-sm text-gray-700">Export-base (фин. показатели)</div>
                </div>
                <p className="text-gray-600 text-sm">
                  Если база в 300-400 контактов не приносит результата — на основе отрицательных ответов скорректируйте оффер (преимущества перед конкурентами, закрытие возражений).
                </p>
              </div>

              {/* Низкая статистика */}
              <div className="bg-white/80 backdrop-blur-sm border border-emerald-100 rounded-xl p-6">
                <h3 className="font-semibold text-gray-900 mb-4 text-lg">Низкая статистика по кампании</h3>
                
                <div className="space-y-4">
                  <div className="bg-gradient-to-r from-yellow-50 to-amber-50 border border-yellow-200 rounded-lg p-4">
                    <p className="text-yellow-800 text-sm font-medium mb-2">Малый процент открываемости (&lt;50% РФ, &lt;45% зарубеж)</p>
                    <p className="text-yellow-700 text-sm">Поменяйте тему письма. Она должна <span className="font-medium">интриговать</span>, не раскрывая суть. Описывайте <span className="font-medium">результат</span>, а не предложение. Попросите GPT придумать тему — &quot;не рекламно, коротко, с {`{{companyName}}`}&quot;.</p>
                  </div>
                  <div className="bg-gradient-to-r from-orange-50 to-amber-50 border border-orange-200 rounded-lg p-4">
                    <p className="text-orange-800 text-sm font-medium mb-2">Мало ответов на письма (&lt;7% РФ, &lt;1% зарубеж)</p>
                    <p className="text-orange-700 text-sm">Пересмотрите CTA или вопрос. Добавьте <span className="font-medium">больше пользы</span> от ответа. Человек должен хотеть обменять время на то, что вы предлагаете.</p>
                  </div>
                </div>
                <p className="text-gray-500 text-xs mt-3">Если ситуация не исправляется — добавьте доп. аккаунты для увеличения мощности.</p>
              </div>

              {/* Этап 2: GPT персонализация */}
              <div className="bg-white/80 backdrop-blur-sm border border-emerald-100 rounded-xl p-6">
                <h3 className="font-semibold text-gray-900 mb-4 text-lg flex items-center gap-2">
                  <span className="w-8 h-8 flex items-center justify-center bg-emerald-500 text-white font-bold rounded-lg">2</span>
                  GPT персонализация
                </h3>
                <p className="text-gray-600 text-sm">
                  Вторым шагом — GPT персонализация по базе из hh.ru на основе описания компании. Если при 300 контактах не достигается результат — переходите к следующему этапу.
                </p>
              </div>

              {/* Этап 3: CustDev звонок */}
              <div className="bg-white/80 backdrop-blur-sm border border-emerald-100 rounded-xl p-6">
                <h3 className="font-semibold text-gray-900 mb-4 text-lg flex items-center gap-2">
                  <span className="w-8 h-8 flex items-center justify-center bg-emerald-500 text-white font-bold rounded-lg">3</span>
                  CustDev звонок с клиентом
                </h3>
                <p className="text-gray-600 text-sm mb-4">
                  Если предыдущие попытки не дали результата — запланируйте звонок, чтобы узнать больше про проект и ЦА.
                </p>

                <div className="bg-gradient-to-r from-emerald-50 to-green-50 border border-emerald-200 rounded-lg p-4 mb-4">
                  <p className="text-emerald-800 text-sm font-medium mb-2">Что узнать у клиента:</p>
                  <ul className="text-emerald-700 text-sm space-y-1">
                    <li>• Ниши, которые берут в работу</li>
                    <li>• Как сейчас привлекают клиентов? Текущая стоимость лида?</li>
                    <li>• Кто ЛПР?</li>
                    <li>• Возможные проблемы в нише, возражения клиентов</li>
                    <li>• Какие вопросы задают проспекты? С какими запросами приходят?</li>
                    <li>• Доп. преимущества тезисно</li>
                  </ul>
                </div>

                <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mb-4">
                  <p className="text-gray-700 text-sm font-medium mb-3">Ещё варианты вопросов на кастдев звонке:</p>
                  
                  <div className="space-y-3 text-sm">
                    <div>
                      <p className="text-gray-700 font-medium">🔸 Вопросы про ЦА (боли/желания/контекст):</p>
                      <ul className="text-gray-600 ml-4 mt-1 space-y-0.5">
                        <li>1. Какой триггер/проблема, после которого решили искать подобное решение?</li>
                        <li>2. Почему именно сейчас решили обратиться к вам?</li>
                      </ul>
                    </div>

                    <div>
                      <p className="text-gray-700 font-medium">🔸 Общие вопросы по ЦА:</p>
                      <ul className="text-gray-600 ml-4 mt-1 space-y-0.5">
                        <li>1. Компании из какой сферы чаще всего становятся клиентами?</li>
                        <li>2. Сможете назвать 3-5 ваших действующих клиентов?</li>
                        <li>3. Есть ли кейсы из релевантного сегмента? (какая компания, проблема, результат)</li>
                      </ul>
                    </div>

                    <div>
                      <p className="text-gray-700 font-medium">🔸 Про конкурентов:</p>
                      <p className="text-gray-600 ml-4 mt-1">Опишите преимущества перед [конкурент] — некоторые упоминают его в ответах.</p>
                    </div>

                    <div>
                      <p className="text-gray-700 font-medium">🔸 Вопросы по базам:</p>
                      <ul className="text-gray-600 ml-4 mt-1 space-y-0.5">
                        <li>• Можете предоставить ИНН клиентов? (для выявления ОКВЭД)</li>
                        <li>• Критерии сегментирования для поиска баз?</li>
                      </ul>
                    </div>

                    <div>
                      <p className="text-gray-700 font-medium">🔸 По существующей лидогенерации:</p>
                      <ul className="text-gray-600 ml-4 mt-1 space-y-0.5">
                        <li>• Как сейчас привлекаете лидов?</li>
                        <li>• Есть ли скрипты или примеры предложений, которые рассылали ранее?</li>
                      </ul>
                    </div>
                  </div>
                </div>

                <p className="text-gray-600 text-sm">
                  После звонка зафиксируйте информацию и скорректируйте оффер/базу. Если после 300-400 контактов ничего не меняется — закрывайте тест.
                </p>
              </div>

              {/* Краткий план */}
              <div className="bg-gradient-to-r from-emerald-50 to-green-50 border border-emerald-200 rounded-xl p-6">
                <h3 className="font-semibold text-emerald-800 mb-4 text-lg">Краткий план</h3>
                <div className="space-y-4">
                  <div className="border-l-4 border-emerald-400 pl-4">
                    <p className="text-emerald-800 text-sm font-medium">Базовые способы:</p>
                    <ul className="text-emerald-700 text-sm mt-1 space-y-0.5">
                      <li>• 2 базы разных сегментов (по 350-400 контактов)</li>
                      <li>• 2 корректировки в оффере (разные подходы, темы, CTA)</li>
                      <li>• +3 доп. аккаунта для мощности</li>
                    </ul>
                  </div>
                  <div className="border-l-4 border-emerald-400 pl-4">
                    <p className="text-emerald-800 text-sm font-medium">GPT персонализация:</p>
                    <ul className="text-emerald-700 text-sm mt-1 space-y-0.5">
                      <li>• 2 базы разных сегментов (по 300 контактов)</li>
                      <li>• 2 корректировки оффера под персонализацию</li>
                    </ul>
                  </div>
                  <div className="border-l-4 border-emerald-400 pl-4">
                    <p className="text-emerald-800 text-sm font-medium">После CustDev звонка:</p>
                    <ul className="text-emerald-700 text-sm mt-1 space-y-0.5">
                      <li>• 1 база (на 400 контактов)</li>
                      <li>• 1 корректировка оффера на основе инфы со звонка</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Тенчат */}
        <section id="tenchat" className="relative overflow-hidden rounded-2xl shadow-xl border border-sky-200">
          <div className="absolute inset-0 bg-gradient-to-br from-sky-50 via-white to-blue-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-sky-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-sky-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-sky-500 to-blue-500 rounded-xl shadow-lg">
                  <MessageSquare className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-sky-600 to-blue-600 bg-clip-text text-transparent">
                  Тенчат — рассыльщик сообщений
                </h2>
                <p className="text-sm text-gray-500 mt-1">Автоматизация рассылки и парсинг</p>
              </div>
            </div>

            <div className="bg-white/80 backdrop-blur-sm border border-sky-100 rounded-xl p-6">
              <p className="text-gray-600 leading-relaxed mb-4">
                Инструмент для автоматизации рассылки сообщений и приглашений в Тенчате. Также включает функцию парсинга контактов.
              </p>

              <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mb-4">
                <p className="text-gray-700 text-sm mb-2 font-medium">Доступы к удалённому рабочему столу:</p>
                <div className="space-y-1 text-sm">
                  <p><span className="font-medium">IP:</span> <span className="font-mono bg-slate-100 px-1 rounded">195.133.25.161</span></p>
                  <p><span className="font-medium">Username:</span> Administrator</p>
                  <p><span className="font-medium">Password:</span> <span className="font-mono bg-slate-100 px-1 rounded">pJ.^cY+fL56xDG</span></p>
                </div>
              </div>

              <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-3">
                <p className="text-amber-800 text-sm">
                  <span className="font-semibold">Совет:</span> Для увеличения лимитов рассылки используйте несколько аккаунтов или премиум.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Отчёты */}
        <section id="reports" className="relative overflow-hidden rounded-2xl shadow-xl border border-indigo-200">
          <div className="absolute inset-0 bg-gradient-to-br from-indigo-50 via-white to-blue-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-indigo-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-indigo-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-indigo-500 to-blue-500 rounded-xl shadow-lg">
                  <ClipboardList className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-blue-600 bg-clip-text text-transparent">
                  Регламент по составлению отчётов
                </h2>
                <p className="text-sm text-gray-500 mt-1">Отчёты в Instantly и Coldy</p>
              </div>
            </div>

            <div className="space-y-6">
              {/* Отчёт Instantly через бот */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-indigo-100 rounded-xl p-6 hover:border-indigo-300 hover:shadow-lg hover:shadow-indigo-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-indigo-500 to-blue-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-indigo-100 to-blue-100 rounded-xl group-hover:from-indigo-200 group-hover:to-blue-200 transition-colors shadow-sm">
                      <Bot className="h-5 w-5 text-indigo-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg flex items-center gap-2">
                      Отчёт в Instantly
                      <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">Автоматический бот</span>
                    </h3>
                    
                    <p className="text-gray-600 text-sm mb-4">
                      Бот составляет отчёты менее чем за минуту! Отправляйте сообщения в основной чат (тема &quot;Составить отчёт инстантли&quot;).
                    </p>

                    <div className="flex flex-wrap gap-2 mb-4">
                      <a href="https://docs.google.com/spreadsheets/d/1I4mQLI2evf1049-pJmX5YU8jwNnOMK5fRz1X6EymRW0/edit?usp=sharing" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-lg text-green-700 hover:from-green-100 hover:to-emerald-100 hover:border-green-300 transition-all font-medium text-sm shadow-sm">
                        <Table className="h-3.5 w-3.5" /> Таблица результатов
                      </a>
                    </div>

                    <div className="bg-gradient-to-r from-indigo-50 to-blue-50 border border-indigo-200 rounded-lg p-4 mb-4">
                      <p className="text-indigo-800 text-sm mb-3 font-medium">Инструкция:</p>
                      <div className="space-y-2 text-sm text-indigo-700">
                        <div className="flex items-start gap-2">
                          <span className="font-bold">1.</span>
                          <p>Отправьте <span className="font-medium">списком ссылки</span> на ваши кампании (только ссылки, больше ничего!)</p>
                        </div>
                        <div className="flex items-start gap-2">
                          <span className="font-bold">2.</span>
                          <p>Подождите до 1-5 минут пока бот составит таблицу</p>
                        </div>
                        <div className="flex items-start gap-2">
                          <span className="font-bold">3.</span>
                          <p>Найдите результат в таблице под вашим юзертэгом</p>
                        </div>
                        <div className="flex items-start gap-2">
                          <span className="font-bold">4.</span>
                          <p>Отредактируйте информацию о лидах и скопируйте в свою таблицу</p>
                        </div>
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mb-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">Пример сообщения боту:</p>
                      <div className="bg-white border border-slate-200 rounded-lg p-3 font-mono text-xs text-gray-600">
                        https://app.instantly.ai/app/campaign/.../analytics<br/>
                        https://app.instantly.ai/app/campaign/.../analytics<br/>
                        https://app.instantly.ai/app/campaign/.../analytics
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-red-50 to-orange-50 border border-red-200 rounded-lg p-3">
                      <p className="text-red-700 text-sm flex items-start gap-2">
                        <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                        <span>Убедитесь, что у вас самих кампания загрузилась в Instantly перед отправкой!</span>
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Отчёт Instantly (ручной способ) */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-indigo-100 rounded-xl p-6 hover:border-indigo-300 hover:shadow-lg hover:shadow-indigo-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-indigo-500 to-blue-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-indigo-100 to-blue-100 rounded-xl group-hover:from-indigo-200 group-hover:to-blue-200 transition-colors shadow-sm">
                      <Mail className="h-5 w-5 text-indigo-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Отчёт в Instantly (ручной способ)</h3>
                    
                    <div className="space-y-3 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-indigo-500 font-medium">1.</span>
                        <p>Зайдите в <span className="font-medium">Analytics → Campaign Analytics</span></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-indigo-500 font-medium">2.</span>
                        <p>Выберите нужную кампанию и период</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-indigo-500 font-medium">3.</span>
                        <p>Скриншот основных метрик: Sent, Opened, Replied, Bounced</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-indigo-500 font-medium">4.</span>
                        <p>Выгрузите все ответы: <span className="font-medium">Unibox → Export</span></p>
                      </div>
                    </div>

                    <div className="rounded-xl overflow-hidden mt-4 border border-indigo-200 shadow-sm">
                      <img 
                        src="/images/instantly-analytics.png" 
                        alt="Аналитика в Instantly - Campaign и Account Analytics"
                        className="w-full h-auto"
                      />
                    </div>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mt-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">Что должно быть в отчёте:</p>
                      <ul className="text-gray-600 text-sm space-y-1">
                        <li>• Скриншот статистики кампании</li>
                        <li>• Количество отправленных / открытых / ответов</li>
                        <li>• Процентные показатели (OR, RR)</li>
                        <li>• Список позитивных ответов с контактами</li>
                        <li>• Анализ и выводы по результатам</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>

              {/* Отчёт Coldy */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-indigo-100 rounded-xl p-6 hover:border-indigo-300 hover:shadow-lg hover:shadow-indigo-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-indigo-500 to-blue-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-indigo-100 to-blue-100 rounded-xl group-hover:from-indigo-200 group-hover:to-blue-200 transition-colors shadow-sm">
                      <Mail className="h-5 w-5 text-indigo-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Отчёт в Coldy</h3>
                    
                    <div className="space-y-3 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-indigo-500 font-medium">1.</span>
                        <p>Раздел <span className="font-medium">Статистика</span> → выберите кампанию</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-indigo-500 font-medium">2.</span>
                        <p>Установите период и сделайте скриншот</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-indigo-500 font-medium">3.</span>
                        <p>Ответы находятся в разделе <span className="font-medium">Входящие</span></p>
                      </div>
                    </div>

                    <div className="rounded-xl overflow-hidden mt-4 border border-indigo-200 shadow-sm">
                      <img 
                        src="/images/coldy-stats-1.png" 
                        alt="Статистика в Coldy"
                        className="w-full h-auto"
                      />
                    </div>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mt-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">Автоматизация через скрипт:</p>
                      <p className="text-gray-600 text-sm mb-3">
                        Для автоматического построения отчёта используйте скрипт Coldy Report — он парсит данные кампаний из листа Raw и создаёт отчёт.
                      </p>
                      <div className="space-y-2 text-sm text-gray-600">
                        <p><span className="font-medium">1.</span> Создайте лист &quot;Raw&quot; и вставьте данные кампаний</p>
                        <p><span className="font-medium">2.</span> Откройте Apps Script (Расширения → Apps Script)</p>
                        <p><span className="font-medium">3.</span> Вставьте скрипт и запустите функцию BuildReport</p>
                        <p><span className="font-medium">4.</span> Результат появится на листе &quot;Report&quot;</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Остаток базы */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-indigo-100 rounded-xl p-6 hover:border-indigo-300 hover:shadow-lg hover:shadow-indigo-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-indigo-500 to-blue-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-indigo-100 to-blue-100 rounded-xl group-hover:from-indigo-200 group-hover:to-blue-200 transition-colors shadow-sm">
                      <Database className="h-5 w-5 text-indigo-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Остаток базы</h3>
                    <p className="text-gray-600 text-sm mb-4">
                      Остаток базы — количество контактов, которым ещё не отправляли письма. Важно отслеживать, чтобы вовремя пополнять базу.
                    </p>

                    <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-4">
                      <p className="text-amber-800 text-sm leading-relaxed">
                        <span className="font-semibold">Правило:</span> Если остаток базы меньше 500 контактов — пора начинать сбор новой базы, чтобы не было простоя в рассылке.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Создание КП в Figma */}
        <section id="kp-figma" className="relative overflow-hidden rounded-2xl shadow-xl border border-purple-200">
          <div className="absolute inset-0 bg-gradient-to-br from-purple-50 via-white to-violet-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-purple-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-purple-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-purple-500 to-violet-500 rounded-xl shadow-lg">
                  <FileImage className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-purple-600 to-violet-600 bg-clip-text text-transparent">
                  Создание КП в Figma
                </h2>
                <p className="text-sm text-gray-500 mt-1">Коммерческие предложения и кейсы</p>
              </div>
            </div>

            <div className="space-y-6">
              {/* Подготовка */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-purple-100 rounded-xl p-6 hover:border-purple-300 hover:shadow-lg hover:shadow-purple-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-purple-500 to-violet-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-purple-100 to-violet-100 rounded-xl group-hover:from-purple-200 group-hover:to-violet-200 transition-colors shadow-sm">
                      <Settings className="h-5 w-5 text-purple-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Подготовка (только в первый раз)</h3>
                    
                    <div className="space-y-3 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-purple-500 font-medium">1.</span>
                        <p>Скачайте <a href="https://drive.google.com/file/d/1mze3VBLJUP8t_ivqtrCGteCh5HyO-Q_c/view?usp=sharing" target="_blank" rel="noopener noreferrer" className="text-purple-600 hover:underline">шрифты для Figma</a>. Разархивируйте и скопируйте .ttf файлы в <span className="font-mono bg-slate-100 px-1 rounded">C:\Windows\Fonts</span></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-purple-500 font-medium">2.</span>
                        <p>Установите Font Installers с <a href="https://www.figma.com/downloads/" target="_blank" rel="noopener noreferrer" className="text-purple-600 hover:underline">figma.com/downloads</a></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-purple-500 font-medium">3.</span>
                        <p>После установки перезагрузите компьютер</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Создание КП */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-purple-100 rounded-xl p-6 hover:border-purple-300 hover:shadow-lg hover:shadow-purple-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-purple-500 to-violet-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-purple-100 to-violet-100 rounded-xl group-hover:from-purple-200 group-hover:to-violet-200 transition-colors shadow-sm">
                      <FileText className="h-5 w-5 text-purple-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Создание КП</h3>
                    
                    <div className="space-y-3 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-purple-500 font-medium">1.</span>
                        <p>Откройте <a href="https://www.figma.com/file/qX2sVU5Ur413xnNJ5geB3s/%D0%9A%D0%9F-Polza?type=design&node-id=0-1&mode=design" target="_blank" rel="noopener noreferrer" className="text-purple-600 hover:underline">шаблон КП Polza</a></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-purple-500 font-medium">2.</span>
                        <p>Выделите и скопируйте шаблон КП (Ctrl+C)</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-purple-500 font-medium">3.</span>
                        <p>Создайте новый файл → вставьте шаблон (Ctrl+V)</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-purple-500 font-medium">4.</span>
                        <p>Замените информацию под свой проект (двойной клик для редактирования)</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-purple-500 font-medium">5.</span>
                        <p>Экспортируйте в PDF → сожмите через <a href="https://www.ilovepdf.com/ru" target="_blank" rel="noopener noreferrer" className="text-purple-600 hover:underline">ilovepdf.com</a></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-purple-500 font-medium">6.</span>
                        <p>Сохраните в <a href="https://drive.google.com/drive/folders/1dKjBMyb9ySuRKZNzEQOr6KoPAvFdpyx9" target="_blank" rel="noopener noreferrer" className="text-purple-600 hover:underline">папку на Google Drive</a> и откройте доступ</p>
                      </div>
                    </div>

                    {/* Placeholder для картинки */}
                    <div className="border-2 border-dashed border-purple-200 rounded-xl p-6 mt-4 bg-purple-50/50 text-center">
                      <ImageIcon className="h-6 w-6 text-purple-300 mx-auto mb-2" />
                      <p className="text-xs text-purple-400">Картинка: figma-kp-example.png</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Создание кейсов */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-purple-100 rounded-xl p-6 hover:border-purple-300 hover:shadow-lg hover:shadow-purple-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-purple-500 to-violet-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-purple-100 to-violet-100 rounded-xl group-hover:from-purple-200 group-hover:to-violet-200 transition-colors shadow-sm">
                      <BookOpen className="h-5 w-5 text-purple-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Создание кейсов в PDF</h3>
                    
                    <div className="space-y-3 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-purple-500 font-medium">1.</span>
                        <p>Откройте <a href="https://www.figma.com/file/qX2sVU5Ur413xnNJ5geB3s/%D0%9A%D0%9F-Polza?type=design&node-id=21-790&mode=design" target="_blank" rel="noopener noreferrer" className="text-purple-600 hover:underline">шаблон кейсов</a></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-purple-500 font-medium">2.</span>
                        <p>Найдите подходящий шаблон с заголовками: О проекте, Канал, Результат, Задача, Реализация</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-purple-500 font-medium">3.</span>
                        <p>Скопируйте в новый файл и отредактируйте</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-purple-500 font-medium">4.</span>
                        <p>Замените скрины статистики (клик → Ctrl+V нового скрина)</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-purple-500 font-medium">5.</span>
                        <p>Экспорт → сжатие → сохранение в <a href="https://drive.google.com/drive/folders/1r-GqjCjgAvKJw5vUATT5HG9GLmOX9kwN" target="_blank" rel="noopener noreferrer" className="text-purple-600 hover:underline">папку кейсов</a> (выберите нишу)</p>
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-4 mt-4">
                      <p className="text-amber-800 text-sm leading-relaxed">
                        <span className="font-semibold">Совет:</span> Для перемещения нескольких текстовых блоков — удерживайте Shift и кликайте на них. Двигайте только вверх/вниз, чтобы не нарушить дизайн.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Block List */}
        <section id="block-list" className="relative overflow-hidden rounded-2xl shadow-xl border border-slate-200">
          <div className="absolute inset-0 bg-gradient-to-br from-slate-50 via-white to-gray-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-slate-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-slate-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-slate-500 to-gray-500 rounded-xl shadow-lg">
                  <Shield className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-slate-600 to-gray-700 bg-clip-text text-transparent">
                  Block List в Instantly
                </h2>
                <p className="text-sm text-gray-500 mt-1">Блокировка доменов и адресов</p>
              </div>
            </div>

            <div className="bg-white/80 backdrop-blur-sm border border-slate-100 rounded-xl p-6">
              <div className="group relative bg-white/80 backdrop-blur-sm border border-slate-100 rounded-xl p-6 hover:border-slate-300 hover:shadow-lg hover:shadow-slate-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-slate-500 to-gray-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-slate-100 to-gray-100 rounded-xl group-hover:from-slate-200 group-hover:to-gray-200 transition-colors shadow-sm">
                      <Shield className="h-5 w-5 text-slate-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Как добавить в Block List</h3>
                    
                    <div className="space-y-3 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-slate-500 font-medium">1.</span>
                        <p><span className="font-medium">Settings → Block List</span></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-slate-500 font-medium">2.</span>
                        <p>Добавьте домены или email-адреса, которые нужно заблокировать</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-slate-500 font-medium">3.</span>
                        <p>Сохраните изменения</p>
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-red-50 to-orange-50 border border-red-200 rounded-lg p-4 mt-4">
                      <p className="text-red-700 text-sm leading-relaxed">
                        <span className="font-semibold">Важно:</span> Всегда добавляйте в Block List домены конкурентов клиента и домены, откуда пришёл негативный ответ с просьбой не писать.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Таблица расходов */}
        <section id="expenses" className="relative overflow-hidden rounded-2xl shadow-xl border border-emerald-200">
          <div className="absolute inset-0 bg-gradient-to-br from-emerald-50 via-white to-green-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-emerald-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-emerald-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-emerald-500 to-green-500 rounded-xl shadow-lg">
                  <DollarSign className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-emerald-600 to-green-600 bg-clip-text text-transparent">
                  Таблица расходов по проектам
                </h2>
                <p className="text-sm text-gray-500 mt-1">Инструкция по заполнению</p>
              </div>
            </div>

            <div className="space-y-6">
              <div className="bg-white/80 backdrop-blur-sm border border-emerald-100 rounded-xl p-6">
                <h3 className="font-semibold text-gray-900 mb-4 text-lg">Как заполнять таблицу расходов</h3>
                
                <div className="space-y-3 text-sm text-gray-600">
                  <div className="flex items-start gap-2">
                    <span className="text-emerald-500 font-medium">1.</span>
                    <p>Откройте таблицу проекта</p>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-emerald-500 font-medium">2.</span>
                    <p>Найдите вкладку &quot;Расходы&quot; или &quot;Expenses&quot;</p>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-emerald-500 font-medium">3.</span>
                    <p>Внесите все расходы по проекту: базы, домены, аккаунты и т.д.</p>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-emerald-500 font-medium">4.</span>
                    <p>Укажите дату, категорию и сумму расхода</p>
                  </div>
                </div>

                <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-4 mt-4">
                  <p className="text-amber-800 text-sm">
                    <span className="font-semibold">Расход по Пользе:</span> Если расход за сервис используется всеми — заполните <a href="https://docs.google.com/forms/d/e/1FAIpQLSc4rOgdV8-nnFVAH8wWf06SflL1culN1AyB7JuEfgmPp36o6Q/viewform" target="_blank" rel="noopener noreferrer" className="text-amber-700 hover:underline font-medium">специальную форму</a>.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Уходим в отпуск */}
        <section id="vacation" className="relative overflow-hidden rounded-2xl shadow-xl border border-amber-200">
          <div className="absolute inset-0 bg-gradient-to-br from-amber-50 via-white to-orange-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-amber-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-amber-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-amber-500 to-orange-500 rounded-xl shadow-lg">
                  <Plane className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-amber-600 to-orange-600 bg-clip-text text-transparent">
                  Уходим в отпуск
                </h2>
                <p className="text-sm text-gray-500 mt-1">Передача проектов</p>
              </div>
            </div>

            <div className="bg-white/80 backdrop-blur-sm border border-amber-100 rounded-xl p-6">
              <p className="text-gray-600 leading-relaxed mb-4">
                Перед уходом в отпуск необходимо передать все проекты другому специалисту. Убедитесь, что передали все доступы, информацию о проектах и текущие задачи.
              </p>
            </div>
          </div>
        </section>

        {/* Ретаргет в рекламе */}
        <section id="retarget-ads" className="relative overflow-hidden rounded-2xl shadow-xl border border-orange-200">
          <div className="absolute inset-0 bg-gradient-to-br from-orange-50 via-white to-amber-50"></div>
          <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-orange-200/30 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
          
          <div className="relative p-8">
            <div className="flex items-center gap-4 mb-8">
              <div className="relative">
                <div className="absolute inset-0 bg-orange-500 rounded-xl blur-md opacity-50"></div>
                <div className="relative p-3 bg-gradient-to-br from-orange-500 to-amber-500 rounded-xl shadow-lg">
                  <Megaphone className="h-7 w-7 text-white" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-bold bg-gradient-to-r from-orange-600 to-amber-600 bg-clip-text text-transparent">
                  Ретаргет в рекламе
                </h2>
                <p className="text-sm text-gray-500 mt-1">Яндекс.Директ и VK Реклама</p>
              </div>
            </div>

            <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-4 mb-6">
              <p className="text-blue-800 text-sm leading-relaxed">
                <span className="font-semibold">Ознакомительный документ:</span>{' '}
                <a href="https://docs.google.com/document/d/1dQ7wB8uTglA4vOtIdgZye5sNtUI2KPEk28Fp2d6olDc/edit" target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline">
                  Что такое Яндекс.Директ и ретаргет
                </a>
              </p>
            </div>

            <div className="space-y-6">
              {/* Первый шаг */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-orange-100 rounded-xl p-6 hover:border-orange-300 hover:shadow-lg hover:shadow-orange-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-orange-500 to-amber-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-orange-100 to-amber-100 rounded-xl group-hover:from-orange-200 group-hover:to-amber-200 transition-colors shadow-sm">
                      <CheckSquare className="h-5 w-5 text-orange-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Первый шаг — доступы</h3>
                    
                    <div className="space-y-3 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-orange-500 font-medium">1.</span>
                        <p>Узнайте, есть ли у клиента кабинет в <a href="https://direct.yandex.ru/" target="_blank" rel="noopener noreferrer" className="text-orange-600 hover:underline">Яндекс.Директ</a> и <a href="https://ads.vk.com/" target="_blank" rel="noopener noreferrer" className="text-orange-600 hover:underline">VK Реклама</a></p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-orange-500 font-medium">2.</span>
                        <p>Если кабинеты есть — запросите доступы (логин/пароль)</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-orange-500 font-medium">3.</span>
                        <p>Если нет — создайте самостоятельно на данные клиента</p>
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-red-50 to-orange-50 border border-red-200 rounded-lg p-4 mt-4">
                      <p className="text-red-700 text-sm leading-relaxed flex items-start gap-2">
                        <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                        <span><span className="font-semibold">Важно:</span> Не привязывайте аккаунты к своему номеру телефона! Используйте данные клиента для возможности передачи.</span>
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Яндекс.Директ — Аудитория */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-orange-100 rounded-xl p-6 hover:border-orange-300 hover:shadow-lg hover:shadow-orange-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-orange-500 to-amber-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-yellow-100 to-amber-100 rounded-xl group-hover:from-yellow-200 group-hover:to-amber-200 transition-colors shadow-sm">
                      <Users className="h-5 w-5 text-yellow-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Яндекс.Директ — Создание аудитории</h3>
                    
                    <div className="space-y-3 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-yellow-600 font-medium">1.</span>
                        <p>В кабинете Яндекс.Директ → нижний угол → иконка &quot;Аудитории&quot;</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-yellow-600 font-medium">2.</span>
                        <p>&quot;Создать сегмент&quot; → &quot;Данные CRM&quot;</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-yellow-600 font-medium">3.</span>
                        <p>Назовите сегмент (укажите, что это базы с аутрича)</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-yellow-600 font-medium">4.</span>
                        <p>Загрузите файл с базами</p>
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mt-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">Формат файла с базами:</p>
                      <p className="text-gray-600 text-sm">Два столбца: <span className="font-mono bg-slate-100 px-1 rounded">companyname</span> и <span className="font-mono bg-slate-100 px-1 rounded">email</span></p>
                      <p className="text-gray-500 text-xs mt-1">Минимум 100 контактов. Чем больше — тем лучше.</p>
                      <a href="https://docs.google.com/spreadsheets/d/1-LWzFMYk4ooKdLPJlQZbB0bhPEMmrri5m_MGnlBGhnA/edit" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-yellow-600 hover:underline text-sm mt-2">
                        Пример базы <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>

                    <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-4 mt-4">
                      <p className="text-amber-800 text-sm leading-relaxed">
                        <span className="font-semibold">Время обработки:</span> Обычно 1-24 часа. Статус &quot;Готов&quot; означает, что можно создавать кампанию.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Создание кампании */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-orange-100 rounded-xl p-6 hover:border-orange-300 hover:shadow-lg hover:shadow-orange-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-orange-500 to-amber-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-orange-100 to-amber-100 rounded-xl group-hover:from-orange-200 group-hover:to-amber-200 transition-colors shadow-sm">
                      <MousePointer className="h-5 w-5 text-orange-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Создание кампании Яндекс.Директ</h3>
                    
                    <div className="space-y-3 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-orange-500 font-medium">1.</span>
                        <p>&quot;Добавить кампанию&quot; → &quot;Режим эксперта&quot; → &quot;Единая перфоманс-кампания&quot;</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-orange-500 font-medium">2.</span>
                        <p>Вставьте ссылку на сайт клиента</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-orange-500 font-medium">3.</span>
                        <p>Места показа: только &quot;Рекламная сеть яндекса&quot;</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-orange-500 font-medium">4.</span>
                        <p>Стратегия: максимум конверсий, оплата за клики, бюджет 1000-1500₽/неделю</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-orange-500 font-medium">5.</span>
                        <p>В группе объявлений выберите созданный сегмент в &quot;Ретаргетинг и подбор аудитории&quot;</p>
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mt-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">UTM-метка для параметров URL:</p>
                      <p className="text-gray-600 text-xs font-mono bg-slate-100 p-2 rounded break-all">
                        {`utm_source=yandex&utm_medium=cpc&utm_campaign={campaign_id}&utm_content={ad_id}&utm_term={keyword}`}
                      </p>
                    </div>

                    <div className="grid md:grid-cols-2 gap-3 mt-4">
                      <div className="bg-gradient-to-r from-green-50/50 to-emerald-50/50 rounded-lg p-3 border border-green-100">
                        <p className="text-gray-800 text-sm font-medium mb-1">✓ Автоматические рекомендации</p>
                        <p className="text-gray-500 text-xs">Оставить галочку</p>
                      </div>
                      <div className="bg-gradient-to-r from-red-50/50 to-orange-50/50 rounded-lg p-3 border border-red-100">
                        <p className="text-gray-800 text-sm font-medium mb-1">✗ Автотаргетинг</p>
                        <p className="text-gray-500 text-xs">Отключить, тематические слова не писать</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* VK Реклама */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-orange-100 rounded-xl p-6 hover:border-orange-300 hover:shadow-lg hover:shadow-orange-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-blue-500 to-indigo-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-blue-100 to-indigo-100 rounded-xl group-hover:from-blue-200 group-hover:to-indigo-200 transition-colors shadow-sm">
                      <Globe className="h-5 w-5 text-blue-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">VK Реклама — Создание кампании</h3>
                    
                    <div className="space-y-3 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-blue-500 font-medium">1.</span>
                        <p>&quot;Аудитории&quot; → &quot;Списки пользователей&quot; → &quot;Загрузить список&quot;</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-blue-500 font-medium">2.</span>
                        <p>Формат: txt/csv, минимум 100 записей, кодировка UTF-8</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-blue-500 font-medium">3.</span>
                        <p>Создайте кампанию: &quot;Конверсии и переходы на сайт&quot;</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-blue-500 font-medium">4.</span>
                        <p>Целевое действие: клики, стратегия: минимальная цена, бюджет 200₽/день</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-blue-500 font-medium">5.</span>
                        <p>Места размещения: <span className="font-medium">только ВКонтакте</span></p>
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-slate-50 to-gray-50 border border-slate-200 rounded-lg p-4 mt-4">
                      <p className="text-gray-700 text-sm mb-2 font-medium">Пример оформления файла с единым списком:</p>
                      <p className="text-gray-600 text-sm mb-2">В одной строке должна содержаться информация только об одном пользователе. Не смешивайте идентификаторы разных пользователей в одной строке.</p>
                      <p className="text-gray-700 text-sm mb-2 font-medium">Заголовки для Единого списка:</p>
                      <p className="text-gray-600 text-sm font-mono bg-white p-2 rounded border border-slate-200">phone, email, ok, vk, vid, gaid, idfa</p>
                      <a href="https://target.vk.ru/documents/vkads/common_list_example.csv" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline text-sm mt-2">
                        Пример файла <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>

                    <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-4 mt-4">
                      <p className="text-blue-800 text-sm mb-2 font-medium">Создание аудитории:</p>
                      <p className="text-blue-700 text-sm">После загрузки файла при создании кампании выберите эту аудиторию в блоке &quot;Пользовательские аудитории&quot;. Ставьте галочку &quot;создать аудиторию из списка&quot; и дайте название сегменту.</p>
                    </div>

                    <div className="bg-gradient-to-r from-purple-50 to-pink-50 border border-purple-200 rounded-lg p-4 mt-4">
                      <p className="text-purple-800 text-sm mb-2 font-medium">Создание кампании:</p>
                      <p className="text-purple-700 text-sm">Создайте кампанию с ключевым действием &quot;конверсии и переходы на сайт&quot;, дайте ссылку на сайт клиента, куда будем вести.</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Настройка аналитики */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-orange-100 rounded-xl p-6 hover:border-orange-300 hover:shadow-lg hover:shadow-orange-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-orange-500 to-amber-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-orange-100 to-amber-100 rounded-xl group-hover:from-orange-200 group-hover:to-amber-200 transition-colors shadow-sm">
                      <LineChart className="h-5 w-5 text-orange-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Настройка аналитики в Метрике</h3>
                    
                    <p className="text-gray-600 text-sm mb-4">
                      Если у клиента не настроена аналитика — создайте счётчик и цели самостоятельно.
                    </p>

                    <div className="space-y-3 text-sm text-gray-600">
                      <div className="flex items-start gap-2">
                        <span className="text-orange-500 font-medium">1.</span>
                        <p>Создайте счётчик: имя = название проекта, адрес = домен клиента</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-orange-500 font-medium">2.</span>
                        <p>Включите &quot;Автоматические цели&quot; и &quot;Вебвизор&quot;</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-orange-500 font-medium">3.</span>
                        <p>Передайте код счётчика клиенту для установки на сайт</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-orange-500 font-medium">4.</span>
                        <p>Создайте цели: посещение &quot;страницы спасибо&quot;, отправка формы и т.д.</p>
                      </div>
                    </div>

                    <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-4 mt-4">
                      <p className="text-blue-800 text-sm mb-2 font-medium">Аналитика VK Реклама:</p>
                      <p className="text-blue-700 text-sm mb-2">Для сбора статистики по аналогии с настройкой целей в метрике нужно создать пиксель. Далее прикрепить его на сайте клиента.</p>
                      <p className="text-blue-700 text-sm">Чтобы прикрепить пиксель можно также попросить специалистов на стороне клиента сделать это, точно также как делали и с директом. Нужно прислать код-пикселя и попросить вставить его в код сайта.</p>
                    </div>

                    <div className="flex flex-wrap gap-2 mt-4">
                      <a href="https://drive.google.com/drive/folders/12XCcKNhcmGuhZrt-3TfzfiRnI31XO80r" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-red-50 to-pink-50 border border-red-200 rounded-lg text-red-700 hover:from-red-100 hover:to-pink-100 transition-all text-sm">
                        <Video className="h-3.5 w-3.5" /> Видео-регламенты
                      </a>
                      <a href="https://docs.google.com/document/d/1bB6BQHJtXNZZGpRfXOkQrM1XccnC3DhEyt98hJ68MBw/edit" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-orange-50 to-amber-50 border border-orange-200 rounded-lg text-orange-700 hover:from-orange-100 hover:to-amber-100 transition-all text-sm">
                        <FileText className="h-3.5 w-3.5" /> Текстовый регламент
                      </a>
                      <a href="https://ads.vk.com/help/articles/pixel" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg text-blue-700 hover:from-blue-100 hover:to-indigo-100 transition-all text-sm">
                        <Globe className="h-3.5 w-3.5" /> Инструкция по пикселю VK
                      </a>
                    </div>
                  </div>
                </div>
              </div>

              {/* Маркировка рекламы */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-orange-100 rounded-xl p-6 hover:border-orange-300 hover:shadow-lg hover:shadow-orange-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-red-500 to-orange-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-red-100 to-orange-100 rounded-xl group-hover:from-red-200 group-hover:to-orange-200 transition-colors shadow-sm">
                      <Shield className="h-5 w-5 text-red-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Маркировка рекламы (обязательно!)</h3>
                    
                    <div className="bg-gradient-to-r from-red-50 to-orange-50 border border-red-200 rounded-lg p-4 mb-4">
                      <p className="text-red-700 text-sm leading-relaxed flex items-start gap-2">
                        <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                        <span>Для новых кабинетов <span className="font-semibold">обязательно</span> заполните данные рекламодателя, иначе можно получить штраф!</span>
                      </p>
                    </div>

                    <div className="grid md:grid-cols-2 gap-4">
                      <div className="bg-gradient-to-r from-yellow-50/50 to-amber-50/50 rounded-lg p-4 border border-yellow-100">
                        <p className="text-gray-800 text-sm font-medium mb-2">Яндекс.Директ:</p>
                        <p className="text-gray-600 text-xs">Название кабинета → &quot;Данные рекламодателя&quot; → заполнить: вид организации, ИНН, название, галочка &quot;я конечный рекламодатель&quot;</p>
                      </div>
                      <div className="bg-gradient-to-r from-blue-50/50 to-indigo-50/50 rounded-lg p-4 border border-blue-100">
                        <p className="text-gray-800 text-sm font-medium mb-2">VK Реклама:</p>
                        <p className="text-gray-600 text-xs">Для компаний: наименование, адрес, ОГРН. Для ИП: ФИО, ОГРНИП. Для самозанятых: ФИО, ИНН.</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Пополнение баланса */}
              <div className="group relative bg-white/80 backdrop-blur-sm border border-orange-100 rounded-xl p-6 hover:border-orange-300 hover:shadow-lg hover:shadow-orange-100/50 transition-all duration-300">
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-green-500 to-emerald-500 rounded-l-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 flex items-center justify-center bg-gradient-to-br from-green-100 to-emerald-100 rounded-xl group-hover:from-green-200 group-hover:to-emerald-200 transition-colors shadow-sm">
                      <DollarSign className="h-5 w-5 text-green-600" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 mb-3 text-lg">Пополнение баланса</h3>
                    
                    <p className="text-gray-600 text-sm mb-4">
                      Баланс кабинета пополняет клиент. Обратитесь к аккаунт-менеджеру в чате &quot;аккаунт&quot; для запроса пополнения.
                    </p>

                    <div className="grid md:grid-cols-2 gap-3">
                      <div className="bg-gradient-to-r from-green-50/50 to-emerald-50/50 rounded-lg p-3 border border-green-100">
                        <p className="text-gray-800 text-sm font-medium mb-1">Способы оплаты</p>
                        <p className="text-gray-500 text-xs">Физ.лицо по карте или юр.лицо по карте/счёту</p>
                      </div>
                      <div className="bg-gradient-to-r from-green-50/50 to-emerald-50/50 rounded-lg p-3 border border-green-100">
                        <p className="text-gray-800 text-sm font-medium mb-1">Рекомендуемая сумма</p>
                        <p className="text-gray-500 text-xs">Минимум 5 000 ₽ (оговаривалось 3-5 тыс.)</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
