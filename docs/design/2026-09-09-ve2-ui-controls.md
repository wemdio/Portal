# VE2: указатель элементов управления

Срез кода `734387bda`, 2026-09-09. Это декларации, а не одновременно видимые элементы. Подписи извлечены статически и могут объединять условные варианты. Для динамической подписи указан источник данных или обработчик. Поля без собственного текста подписаны соседним элементом в исходном компоненте.

Решения сгруппированы по смыслу в [аудите интерфейса](2026-09-09-ve2-auto-outreach-ui-audit.md). Указатель содержит 172 декларации в 18 TSX-компонентах, включая 111 нативных кнопок. `ui.tsx` не содержит элементов управления.

## LegacyArchivePanel.tsx

| Строка | Элемент | Подпись / источник динамического действия |
|---|---|---|
| [85](../../app/src/components/vertical-engine-v2/LegacyArchivePanel.tsx#L85) | `button` | legacy |
| [111](../../app/src/components/vertical-engine-v2/LegacyArchivePanel.tsx#L111) | `button` | Назад к архиву |

## LegacyReviewPanel.tsx

| Строка | Элемент | Подпись / источник динамического действия |
|---|---|---|
| [49](../../app/src/components/vertical-engine-v2/LegacyReviewPanel.tsx#L49) | `input` | Поиск по названию, сайту, статусу или рынку \| Поиск кандидатов |
| [116](../../app/src/components/vertical-engine-v2/LegacyReviewPanel.tsx#L116) | `button` | Удаляем… \| Точно убрать |
| [127](../../app/src/components/vertical-engine-v2/LegacyReviewPanel.tsx#L127) | `button` | Отмена |
| [137](../../app/src/components/vertical-engine-v2/LegacyReviewPanel.tsx#L137) | `button` | Убрать из архива |
| [154](../../app/src/components/vertical-engine-v2/LegacyReviewPanel.tsx#L154) | `input` | Например: прогон Сергея, апрель |
| [167](../../app/src/components/vertical-engine-v2/LegacyReviewPanel.tsx#L167) | `button` | Добавляем… \| Подтвердить внутренний проект |

## VerticalEngineV2View.tsx

| Строка | Элемент | Подпись / источник динамического действия |
|---|---|---|
| [272](../../app/src/components/vertical-engine-v2/VerticalEngineV2View.tsx#L272) | `a` | Legacy |
| [285](../../app/src/components/vertical-engine-v2/VerticalEngineV2View.tsx#L285) | `button` | {ve2-root-tab-${item.id}} |

## ContactSupplyPanel.tsx

| Строка | Элемент | Подпись / источник динамического действия |
|---|---|---|
| [97](../../app/src/components/vertical-engine-v2/engine/ContactSupplyPanel.tsx#L97) | `input` | {(event) => supply.setConfirmed(event.target.checked)} |
| [101](../../app/src/components/vertical-engine-v2/engine/ContactSupplyPanel.tsx#L101) | `button` | Сохраняем… \| Зафиксировать согласование |
| [113](../../app/src/components/vertical-engine-v2/engine/ContactSupplyPanel.tsx#L113) | `button` | Сохраняем… \| Приостановить пополнение \| Возобновить пополнение |

## HypothesisEngineView.tsx

| Строка | Элемент | Подпись / источник динамического действия |
|---|---|---|
| [148](../../app/src/components/vertical-engine-v2/engine/HypothesisEngineView.tsx#L148) | `button` | Проекты |
| [157](../../app/src/components/vertical-engine-v2/engine/HypothesisEngineView.tsx#L157) | `button` | Очередь запусков |
| [215](../../app/src/components/vertical-engine-v2/engine/HypothesisEngineView.tsx#L215) | `button` | Создан |
| [251](../../app/src/components/vertical-engine-v2/engine/HypothesisEngineView.tsx#L251) | `button` | Новый проект |
| [279](../../app/src/components/vertical-engine-v2/engine/HypothesisEngineView.tsx#L279) | `input` | "he-website" |
| [296](../../app/src/components/vertical-engine-v2/engine/HypothesisEngineView.tsx#L296) | `input` | Например, Acme RU |
| [321](../../app/src/components/vertical-engine-v2/engine/HypothesisEngineView.tsx#L321) | `button` | Закрыть предупреждение \| Закрыть |
| [331](../../app/src/components/vertical-engine-v2/engine/HypothesisEngineView.tsx#L331) | `button` | Всё равно создать в v2 |
| [342](../../app/src/components/vertical-engine-v2/engine/HypothesisEngineView.tsx#L342) | `button` | Создать проект |

## LaunchPortfolioView.tsx

| Строка | Элемент | Подпись / источник динамического действия |
|---|---|---|
| [412](../../app/src/components/vertical-engine-v2/engine/LaunchPortfolioView.tsx#L412) | `button` | {() => onProjectOpen(item.project_id)} |
| [432](../../app/src/components/vertical-engine-v2/engine/LaunchPortfolioView.tsx#L432) | `button` | Освободить слот вручную |
| [449](../../app/src/components/vertical-engine-v2/engine/LaunchPortfolioView.tsx#L449) | `button` | Изменить сезонное решение |
| [478](../../app/src/components/vertical-engine-v2/engine/LaunchPortfolioView.tsx#L478) | `a` | {href} |
| [512](../../app/src/components/vertical-engine-v2/engine/LaunchPortfolioView.tsx#L512) | `input` | {(event) => { setReviewedItemIds((current) => { const next = new Set(current); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; }); }} |
| [528](../../app/src/components/vertical-engine-v2/engine/LaunchPortfolioView.tsx#L528) | `button` | Активируем… \| Проверить слот и активировать \| Активировать отправку |
| [561](../../app/src/components/vertical-engine-v2/engine/LaunchPortfolioView.tsx#L561) | `textarea` | {releaseEditor.reason} |
| [572](../../app/src/components/vertical-engine-v2/engine/LaunchPortfolioView.tsx#L572) | `button` | Сохраняем… \| Подтвердить освобождение |
| [582](../../app/src/components/vertical-engine-v2/engine/LaunchPortfolioView.tsx#L582) | `button` | Отмена |
| [599](../../app/src/components/vertical-engine-v2/engine/LaunchPortfolioView.tsx#L599) | `input` | {() => setOverrideEditor({ ...overrideEditor, decision: 'activate_next' }) } |
| [611](../../app/src/components/vertical-engine-v2/engine/LaunchPortfolioView.tsx#L611) | `input` | {() => setOverrideEditor({ ...overrideEditor, decision: 'wait' })} |
| [622](../../app/src/components/vertical-engine-v2/engine/LaunchPortfolioView.tsx#L622) | `textarea` | {overrideEditor.reason} |
| [633](../../app/src/components/vertical-engine-v2/engine/LaunchPortfolioView.tsx#L633) | `button` | Сохраняем… \| Сохранить решение |
| [645](../../app/src/components/vertical-engine-v2/engine/LaunchPortfolioView.tsx#L645) | `button` | Отмена |

## ProjectDetail.tsx

| Строка | Элемент | Подпись / источник динамического действия |
|---|---|---|
| [504](../../app/src/components/vertical-engine-v2/engine/ProjectDetail.tsx#L504) | `select` | "ve2-selected-preview" |
| [638](../../app/src/components/vertical-engine-v2/engine/ProjectDetail.tsx#L638) | `button` | Все проекты |
| [656](../../app/src/components/vertical-engine-v2/engine/ProjectDetail.tsx#L656) | `a` | {project.website_url} |
| [699](../../app/src/components/vertical-engine-v2/engine/ProjectDetail.tsx#L699) | `button` | Остановить все активные задачи проекта \| Останавливаем… \| Остановить задачи |
| [716](../../app/src/components/vertical-engine-v2/engine/ProjectDetail.tsx#L716) | `button` | Скрыть |
| [748](../../app/src/components/vertical-engine-v2/engine/ProjectDetail.tsx#L748) | `summary` | Технические подробности |
| [774](../../app/src/components/vertical-engine-v2/engine/ProjectDetail.tsx#L774) | `button` | {onAction} |

## SeasonalitySummary.tsx

| Строка | Элемент | Подпись / источник динамического действия |
|---|---|---|
| [182](../../app/src/components/vertical-engine-v2/engine/SeasonalitySummary.tsx#L182) | `a` | {evidence.source_url} |

## CasesBlock.tsx

| Строка | Элемент | Подпись / источник динамического действия |
|---|---|---|
| [235](../../app/src/components/vertical-engine-v2/engine/steps/CasesBlock.tsx#L235) | `summary` | С сайта \| Добавлен вручную \| Задача: \| Не указано \| Результат: |
| [251](../../app/src/components/vertical-engine-v2/engine/steps/CasesBlock.tsx#L251) | `button` | Удалить |
| [272](../../app/src/components/vertical-engine-v2/engine/steps/CasesBlock.tsx#L272) | `input` | {Сохранить кейс ${index + 1}} |
| [281](../../app/src/components/vertical-engine-v2/engine/steps/CasesBlock.tsx#L281) | `button` | Сохранить выбранные ( \| ) |
| [285](../../app/src/components/vertical-engine-v2/engine/steps/CasesBlock.tsx#L285) | `button` | Изменить исходный текст |
| [296](../../app/src/components/vertical-engine-v2/engine/steps/CasesBlock.tsx#L296) | `textarea` | Кейс 1. Для кого работали, что сделали, какой результат получили. Кейс 2. Другой проект и его результат. |
| [299](../../app/src/components/vertical-engine-v2/engine/steps/CasesBlock.tsx#L299) | `input` | Например: презентация клиента, сентябрь |
| [300](../../app/src/components/vertical-engine-v2/engine/steps/CasesBlock.tsx#L300) | `button` | Разбираем кейсы… \| Разобрать текст |

## ClientBriefBlock.tsx

| Строка | Элемент | Подпись / источник динамического действия |
|---|---|---|
| [252](../../app/src/components/vertical-engine-v2/engine/steps/ClientBriefBlock.tsx#L252) | `button` | Свернуть \| Открыть бриф \| Загрузить бриф |
| [271](../../app/src/components/vertical-engine-v2/engine/steps/ClientBriefBlock.tsx#L271) | `input` | {(e) => { const file = e.target.files?.[0]; if (file) void handleUpload(file); }} |
| [281](../../app/src/components/vertical-engine-v2/engine/steps/ClientBriefBlock.tsx#L281) | `button` | Загрузить другой файл \| Выбрать файл брифа |
| [324](../../app/src/components/vertical-engine-v2/engine/steps/ClientBriefBlock.tsx#L324) | `textarea` | {value} |
| [331](../../app/src/components/vertical-engine-v2/engine/steps/ClientBriefBlock.tsx#L331) | `input` | {value} |
| [347](../../app/src/components/vertical-engine-v2/engine/steps/ClientBriefBlock.tsx#L347) | `select` | Не указана |
| [387](../../app/src/components/vertical-engine-v2/engine/steps/ClientBriefBlock.tsx#L387) | `textarea` | {icp[list.key].join('\n')} |
| [405](../../app/src/components/vertical-engine-v2/engine/steps/ClientBriefBlock.tsx#L405) | `input` | {icp[line.key]} |
| [427](../../app/src/components/vertical-engine-v2/engine/steps/ClientBriefBlock.tsx#L427) | `input` | {(e) => { setFields((prev) => ({ ...prev, social_proof: { ...prev.social_proof, [key]: { ...prev.social_proof[key], has: e.target.checked }, }, })); setDirty(true); }} |
| [443](../../app/src/components/vertical-engine-v2/engine/steps/ClientBriefBlock.tsx#L443) | `input` | Комментарий / ссылка |
| [466](../../app/src/components/vertical-engine-v2/engine/steps/ClientBriefBlock.tsx#L466) | `button` | Сохранить бриф |

## SegmentationAuditPanel.tsx

| Строка | Элемент | Подпись / источник динамического действия |
|---|---|---|
| [549](../../app/src/components/vertical-engine-v2/engine/steps/SegmentationAuditPanel.tsx#L549) | `a` | Открыть найденную кампанию в Instantly |
| [564](../../app/src/components/vertical-engine-v2/engine/steps/SegmentationAuditPanel.tsx#L564) | `textarea` | campaign-id; если кампаний несколько — через запятую |
| [581](../../app/src/components/vertical-engine-v2/engine/steps/SegmentationAuditPanel.tsx#L581) | `button` | Сохраняем… \| Кампания создана — зафиксировать |
| [590](../../app/src/components/vertical-engine-v2/engine/steps/SegmentationAuditPanel.tsx#L590) | `button` | Кампании нет — разрешить повтор |
| [738](../../app/src/components/vertical-engine-v2/engine/steps/SegmentationAuditPanel.tsx#L738) | `a` | Открыть в Instantly |
| [761](../../app/src/components/vertical-engine-v2/engine/steps/SegmentationAuditPanel.tsx#L761) | `button` | Повторить проверку |
| [783](../../app/src/components/vertical-engine-v2/engine/steps/SegmentationAuditPanel.tsx#L783) | `button` | Обновить проверку |
| [809](../../app/src/components/vertical-engine-v2/engine/steps/SegmentationAuditPanel.tsx#L809) | `button` | Повторить проверку |

## Step1Research.tsx

| Строка | Элемент | Подпись / источник динамического действия |
|---|---|---|
| [191](../../app/src/components/vertical-engine-v2/engine/steps/Step1Research.tsx#L191) | `button` | К выбору направления |
| [195](../../app/src/components/vertical-engine-v2/engine/steps/Step1Research.tsx#L195) | `button` | Перезапустить |
| [223](../../app/src/components/vertical-engine-v2/engine/steps/Step1Research.tsx#L223) | `button` | Да, перезапустить |
| [236](../../app/src/components/vertical-engine-v2/engine/steps/Step1Research.tsx#L236) | `button` | Отмена |
| [316](../../app/src/components/vertical-engine-v2/engine/steps/Step1Research.tsx#L316) | `button` | Запустить исследование |
| [419](../../app/src/components/vertical-engine-v2/engine/steps/Step1Research.tsx#L419) | `textarea` | Например: 3–5 встреч в месяц с HRD крупных работодателей, тест за 2 недели |
| [432](../../app/src/components/vertical-engine-v2/engine/steps/Step1Research.tsx#L432) | `button` | Сохранить |
| [479](../../app/src/components/vertical-engine-v2/engine/steps/Step1Research.tsx#L479) | `textarea` | Иван Иванов, руководитель направления, Polza, polzaagency.ru |
| [492](../../app/src/components/vertical-engine-v2/engine/steps/Step1Research.tsx#L492) | `button` | Сохранить |
| [549](../../app/src/components/vertical-engine-v2/engine/steps/Step1Research.tsx#L549) | `textarea` | Например: продаём корпоративное обучение по продажам для производственных компаний, сильны программами для В2Г-сектора… |
| [562](../../app/src/components/vertical-engine-v2/engine/steps/Step1Research.tsx#L562) | `button` | Сохранить |
| [618](../../app/src/components/vertical-engine-v2/engine/steps/Step1Research.tsx#L618) | `textarea` | Пример письма, которое нравится… |
| [631](../../app/src/components/vertical-engine-v2/engine/steps/Step1Research.tsx#L631) | `button` | Сохранить |
| [749](../../app/src/components/vertical-engine-v2/engine/steps/Step1Research.tsx#L749) | `button` | Попробовать снова |

## Step2Verticals.tsx

| Строка | Элемент | Подпись / источник динамического действия |
|---|---|---|
| [291](../../app/src/components/vertical-engine-v2/engine/steps/Step2Verticals.tsx#L291) | `button` | {() => setFilter(chip.id)} |
| [427](../../app/src/components/vertical-engine-v2/engine/steps/Step2Verticals.tsx#L427) | `button` | Выбрать направление |
| [459](../../app/src/components/vertical-engine-v2/engine/steps/Step2Verticals.tsx#L459) | `button` | Скрыть \| Подробнее |
| [501](../../app/src/components/vertical-engine-v2/engine/steps/Step2Verticals.tsx#L501) | `button` | Принять все |
| [509](../../app/src/components/vertical-engine-v2/engine/steps/Step2Verticals.tsx#L509) | `button` | Отклонить все |
| [517](../../app/src/components/vertical-engine-v2/engine/steps/Step2Verticals.tsx#L517) | `button` | Сбросить |
| [543](../../app/src/components/vertical-engine-v2/engine/steps/Step2Verticals.tsx#L543) | `button` | Да, отклонить |
| [552](../../app/src/components/vertical-engine-v2/engine/steps/Step2Verticals.tsx#L552) | `button` | Отмена |
| [740](../../app/src/components/vertical-engine-v2/engine/steps/Step2Verticals.tsx#L740) | `summary` | Доказательства ( \| ) |
| [746](../../app/src/components/vertical-engine-v2/engine/steps/Step2Verticals.tsx#L746) | `a` | {ev.source_url} |
| [767](../../app/src/components/vertical-engine-v2/engine/steps/Step2Verticals.tsx#L767) | `button` | Вернуть |
| [782](../../app/src/components/vertical-engine-v2/engine/steps/Step2Verticals.tsx#L782) | `button` | Вернуть |
| [793](../../app/src/components/vertical-engine-v2/engine/steps/Step2Verticals.tsx#L793) | `button` | Принять |
| [801](../../app/src/components/vertical-engine-v2/engine/steps/Step2Verticals.tsx#L801) | `button` | Отклонить |

## Step3Content.tsx

| Строка | Элемент | Подпись / источник динамического действия |
|---|---|---|
| [447](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L447) | `button` | сборка \| готово \| нет |
| [489](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L489) | `select` | Язык цепочки |
| [507](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L507) | `button` | Попробовать снова \| Перегенерировать \| Сгенерировать |
| [547](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L547) | `button` | Настроить интервалы |
| [627](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L627) | `button` | {() => { if (!requestEditorExit('swapVariant')) return; setVariantView({ key: chainKey, map: { ...viewMap, [idx]: sideIdx }, }); }} |
| [646](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L646) | `button` | Сохраняем… \| сделать основным |
| [658](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L658) | `button` | Скопировать письмо \| Скопировано \| Скопировать |
| [670](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L670) | `button` | Редактировать письмо \| Править |
| [700](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L700) | `button` | Добавить письмо |
| [714](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L714) | `button` | Далее: база |
| [749](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L749) | `button` | Попробовать снова \| Перегенерировать \| Сгенерировать |
| [800](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L800) | `button` | Попробовать снова \| Пересобрать \| Собрать досье |
| [837](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L837) | `button` | Далее: база |
| [898](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L898) | `button` | Вернуть по умолчанию |
| [906](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L906) | `button` | Отмена |
| [907](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L907) | `button` | Сохраняем… \| Сохранить интервалы |
| [932](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L932) | `input` | {Пауза перед письмом ${index + 1}, дней после предыдущего} |
| [1015](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L1015) | `input` | Тема письма |
| [1027](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L1027) | `textarea` | {body} |
| [1038](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L1038) | `button` | Отмена |
| [1041](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L1041) | `button` | Сохраняем… \| Сохранить |
| [1148](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L1148) | `summary` | Примеры вакансий ( \| ) |
| [1250](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L1250) | `summary` | Лучшие темы ( \| ) |
| [1262](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L1262) | `summary` | Вывод по кампаниям |
| [1270](../../app/src/components/vertical-engine-v2/engine/steps/Step3Content.tsx#L1270) | `summary` | Резюме рынка |

## Step4Base.tsx

| Строка | Элемент | Подпись / источник динамического действия |
|---|---|---|
| [419](../../app/src/components/vertical-engine-v2/engine/steps/Step4Base.tsx#L419) | `button` | Собрать автоматически |
| [430](../../app/src/components/vertical-engine-v2/engine/steps/Step4Base.tsx#L430) | `button` | Загрузить файл |
| [459](../../app/src/components/vertical-engine-v2/engine/steps/Step4Base.tsx#L459) | `button` | Все |
| [467](../../app/src/components/vertical-engine-v2/engine/steps/Step4Base.tsx#L467) | `button` | Нет |
| [522](../../app/src/components/vertical-engine-v2/engine/steps/Step4Base.tsx#L522) | `button` | Проверить запуск |
| [537](../../app/src/components/vertical-engine-v2/engine/steps/Step4Base.tsx#L537) | `button` | Продолжить подготовку превью \| Подготовить превью |
| [583](../../app/src/components/vertical-engine-v2/engine/steps/Step4Base.tsx#L583) | `button` | Убрать файл |
| [623](../../app/src/components/vertical-engine-v2/engine/steps/Step4Base.tsx#L623) | `button` | Загрузить базу |
| [634](../../app/src/components/vertical-engine-v2/engine/steps/Step4Base.tsx#L634) | `button` | Читаем файл… \| Выберите или перетащите файл \| CSV, TSV или XLSX · до \| строк |
| [663](../../app/src/components/vertical-engine-v2/engine/steps/Step4Base.tsx#L663) | `input` | {(event) => { const file = event.target.files?.[0]; if (file) void handleFile(file); }} |
| [748](../../app/src/components/vertical-engine-v2/engine/steps/Step4Base.tsx#L748) | `button` | Перейти к шаблону |
| [753](../../app/src/components/vertical-engine-v2/engine/steps/Step4Base.tsx#L753) | `button` | Собираем шаблон… \| Собрать шаблон |
| [912](../../app/src/components/vertical-engine-v2/engine/steps/Step4Base.tsx#L912) | `button` | Скрыть \| Готовые контакты \| Исходные кандидаты |
| [921](../../app/src/components/vertical-engine-v2/engine/steps/Step4Base.tsx#L921) | `button` | До 1000 проверенных контактов для согласования \| Все собранные строки, включая исключённые из запуска \| CSV превью \| Исходный CSV |
| [931](../../app/src/components/vertical-engine-v2/engine/steps/Step4Base.tsx#L931) | `button` | Сохранённые кандидаты с причинами проверки; не готовая база для рассылки \| Не допущенные контакты |
| [947](../../app/src/components/vertical-engine-v2/engine/steps/Step4Base.tsx#L947) | `button` | Запускаем проверку… \| Возобновить автопроверку |
| [1063](../../app/src/components/vertical-engine-v2/engine/steps/Step4Base.tsx#L1063) | `input` | {() => onToggle(hypothesis.id)} |

## Step5Template.tsx

| Строка | Элемент | Подпись / источник динамического действия |
|---|---|---|
| [184](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L184) | `summary` | Превью по лидам: письма глазами конкретных лидов из базы \| новое |
| [731](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L731) | `select` | Выберите проект |
| [750](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L750) | `input` | Точное число |
| [977](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L977) | `button` | Создать клиента и пресет |
| [1015](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1015) | `input` | "ve2-client-email" |
| [1033](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1033) | `input` | "ve2-client-password" |
| [1054](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1054) | `select` | Выберите workspace и тег \| · |
| [1080](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1080) | `button` | Создаём клиента… \| Создать клиента |
| [1087](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1087) | `button` | Отмена |
| [1250](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1250) | `a` | Открыть в Instantly |
| [1263](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1263) | `a` | Основная (дефолтный текст) |
| [1306](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1306) | `input` | {(event) => setReviewed(event.target.checked)} |
| [1319](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1319) | `button` | Запуск одобрен \| Отправка активирована \| Активируем… \| Активировать отправку |
| [1327](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1327) | `button` | Пересмотреть сезонное решение |
| [1418](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1418) | `button` | План и запас контактов |
| [1434](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1434) | `a` | Открыть в Instantly |
| [1445](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1445) | `a` | Основная (дефолтный текст) |
| [1490](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1490) | `select` | Выберите клиента \| Закреплённый пресет недоступен |
| [1544](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1544) | `button` | Создаём кампании… \| Создать кампанию (на паузе) |
| [1566](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1566) | `button` | Скачать CSV для запуска \| Готовим CSV… \| CSV для запуска |
| [1577](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1577) | `button` | Отмена |
| [1740](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1740) | `button` | Попробовать снова |
| [1754](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1754) | `button` | Собрать шаблон |
| [1783](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1783) | `button` | Правится на шаге 3: Контент |
| [1792](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1792) | `button` | Скопировано \| Скопировать |
| [1796](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1796) | `button` | Скачать JSON \| JSON |
| [1853](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1853) | `button` | Проверяем сегментацию… \| Проверка открыта \| Проверить результат запуска \| Проверить перед запуском |
| [1900](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1900) | `button` | Скопировать письмо \| Скопировано \| Скопировать |
| [1923](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1923) | `summary` | Вариант для сегмента: |
| [1993](../../app/src/components/vertical-engine-v2/engine/steps/Step5Template.tsx#L1993) | `summary` | Фиксированный блок (85%) |

## StepNav.tsx

| Строка | Элемент | Подпись / источник динамического действия |
|---|---|---|
| [54](../../app/src/components/vertical-engine-v2/engine/steps/StepNav.tsx#L54) | `button` | {() => { if (!locked) onJump(step.id); }} |
