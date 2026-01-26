'use client';

import { useState, useRef, useEffect } from 'react';
import { 
  CheckCircle2, Clock, Database, Mail, FileText, Pin, Globe, 
  BarChart3, AlertCircle, User, Calendar, MessageSquare, 
  Users, Shield, BookOpen, ExternalLink, ArrowRight, PenTool, 
  Video, Book, CheckSquare, Image as ImageIcon, Search
} from 'lucide-react';

interface SearchResult {
  id: string;
  title: string;
  context: string;
  sectionId: string;
  searchText: string;
}

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
              searchText: searchQuery
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
  useEffect(() => {
    if (searchQuery.trim()) {
      const results = searchInContent(searchQuery);
      setSearchResults(results);
      setShowResults(true);
    } else {
      setSearchResults([]);
      setShowResults(false);
    }
  }, [searchQuery]);

  // Плавная прокрутка к найденному тексту
  const scrollToResult = (result: SearchResult) => {
    const query = result.searchText.toLowerCase();
    setShowResults(false);
    setSearchQuery('');
    
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
              } catch (surroundError) {
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
            } catch (highlightError) {
              // Игнорируем ошибки подсветки
            }
          }, 600);
        } catch (e) {
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
              onChange={(e) => setSearchQuery(e.target.value)}
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
            {[
              { icon: Clock, title: 'Рабочий день', content: 'Рабочий день начинается с 10:00 по МСК до 19:00 по МСК с определения своих задач и проблем по проектам, список которых нужно отправить в общий чат Polza в Телеграм. В течение рабочего дня записываем все, что сделано и как решили проблемы. В конце дня отправляем в общий чат этот список. Каждый день в 12ч. по мск общий звонок в Гугл мит.' },
              { icon: Calendar, title: 'Таймлайн проекта', content: 'В чате с клиентом всегда по датам расписаны шаги (заполнение брифа клиентом, сбор базы, создание цепочки писем, запуск). Если неизвестно, сколько времени займет задача, лучше начать ее выполнение за 1-2 дня до назначенного срока (при условии, что клиент заполнил бриф).' },
              { icon: Database, title: 'База', content: 'Собираем базу компаний, которым будем отправлять рассылку. Есть разные способы собрать базу: HH, карты 2gis, 70+, экспортбэйс (дорого), LinkedIn и Аполло (для иностранных баз), кворк и др. Если база компаний состоит из сайтов, а имейлов в ней нет, получаем имейлы в экстракторе. Согласовываем базу с руководителем, после чего отправляем на согласование клиенту в чат. Важно: если понимаете, что по итогу сбора баз выходит меньше 200 контактов, то нужно написать клиенту уточняющие вопросы по расширению критериев для их поиска, т.к. они неосознанно сами же могут урезать возможность для выборки (из вариантов: шире география, доп отрасли, конкретные оквэды, инн и т.д). Верифицировать собранные базы - проверять на актуальность рабочие/не рабочие (или даже если они из готовых баз) нужно через letsextract.' },
              { icon: Mail, title: 'Оффер', content: 'В чате с клиентом берем заполненный клиентом бриф, изучаем его, определяем целевую аудиторию и пишем цепочку писем (оффер). Отправляем цепочку на проверку своему наставнику по обучению. Потом нужно будет сделать правки и отправить оффер на согласование клиенту в чат и внести правки от клиента.' },
            ].map((item, idx) => (
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

            {[
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
            ].map((item, idx) => (
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

          <div className="space-y-6">
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-gray-700 mb-3">
                <strong>Видео про создание кампаний в Instantly:</strong><br />
                <a href="https://youtu.be/Y-J2HEjtl1E" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">https://youtu.be/Y-J2HEjtl1E</a>
              </p>
              <div className="bg-yellow-50 border-l-4 border-yellow-500 p-4 mb-4">
                <p className="text-gray-700">
                  <strong>Поправка к видео:</strong> по поводу времени работы кампании - лучше всегда делать с 9 утра до 18 вечера, чтобы instantly точно успел отправить необходимое количество писем. (если в базе сборная солянка из городов, то лучше поставить до 3х дня по мск)
                </p>
              </div>
              <p className="text-gray-700 mb-3">
                После того как мы добавили почты в instantly (пункт 5 в работе с почтами), собрали базу и написали цепочку, мы приступаем к созданию кампаний в instantly. Для этого переходим в соответствующую вкладку на сайте, нажимаем «+ADD NEW» и называем кампанию. Нас перебросит в окно «Leads», где нам необходимо импортировать базу емэйлов. Для этого жмем синюю кнопку «Import» → Emails Manually, вставляем список спарсеных емэйлов и жмем на кнопку «Import Emails».
              </p>
              <p className="text-gray-700 mb-3">
                При добавлении контактов из Гугл Таблиц, выбираем google sheets (мы сейчас всегда импортируем через гугл таблицы)
              </p>
              <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                <img 
                  src="/images/instantly-import-options.png"
                  alt="Опции импорта в Instantly"
                  className="w-full h-auto"
                />
              </div>
              <p className="text-gray-700 mb-3">
                После добавления базы емэйлов переходим во вкладку «Sequences», вписываем тему письма: Краткий запрос, вставляем и форматируем текст (добавляем ссылки в слова, выделяем жирным и убираем форматирование), затем нажимаем на шестеренку и вписываем количество дней ожидания. Обычно связка дней строится по системе: 1/3/5/7. Жмем «Save». В следующих письмах добавлять название темы не нужно. Чтобы добавить новое письмо жмем «Add step».
              </p>
              <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                <img 
                  src="/images/instantly-sequences-editor.png"
                  alt="Редактор цепочки писем в Instantly"
                  className="w-full h-auto"
                />
              </div>
              <p className="text-gray-700 mb-3">
                Чтобы убрать форматирование текста выделяем его и нажимаем как показано на скриншоте ниже:
              </p>
              <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/3">
                <img 
                  src="/images/clear-formatting-button.png"
                  alt="Кнопка очистки форматирования"
                  className="w-full h-auto"
                />
              </div>
              <p className="text-gray-700 mb-3">
                После того как все письма добавлены и сохранены переходим ко следующей вкладке «Schedule». Выбираем дни рассылки без выходных, устанавливаем временной пояс получателя и жмем «Save».
              </p>
              <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                <img 
                  src="/images/instantly-schedule-settings.png"
                  alt="Настройки расписания в Instantly"
                  className="w-full h-auto"
                />
              </div>
              <p className="text-gray-700 mb-3">
                В следующей вкладке «Options» выбираем аккаунты для рассылки, которые мы создали и добавили. В самом низу страницы не забываем сохранить. После того как все проделано, можно запускать по кнопке «Launch».
              </p>
              <div className="border border-gray-300 rounded-lg overflow-hidden bg-white mb-3 w-1/2">
                <img 
                  src="/images/instantly-accounts-select.png"
                  alt="Выбор аккаунтов для рассылки"
                  className="w-full h-auto"
                />
              </div>
              <div className="bg-red-50 border-l-4 border-red-500 p-4">
                <p className="text-gray-700">
                  <strong>Важный момент!</strong> Если пользователь отвечает на нашу рассылку, то он больше не будет получать письма из нее.
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
