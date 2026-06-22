"""XLSX report formatter.

Copied verbatim from polza_bot/formatter.py — only difference: the Campaign
import now resolves to models.py instead of scraper.py.

Builds a styled .xlsx file by writing the OOXML parts directly into a zip,
so the service can stay dependency-light (no openpyxl). Anything you change
here will end up in the Excel report the user downloads.
"""
from __future__ import annotations

from io import BytesIO
from datetime import datetime
from zipfile import ZIP_DEFLATED, ZipFile
from xml.sax.saxutils import escape

from models import Campaign


def format_report(campaigns: list[Campaign]) -> list[str]:
    """Render a Markdown-style text report (kept for parity with polza_bot)."""
    now = datetime.now().strftime("%d.%m.%Y %H:%M")
    lines: list[str] = []

    lines.append(f"📊 *Отчёт по рассылкам Coldy*")
    lines.append(f"🕐 {now}\n")

    if not campaigns:
        lines.append("_Кампании не найдены._")
        return ["\n".join(lines)]

    # Summary totals
    total_sent = sum(c.sent for c in campaigns)
    total_opened = sum(c.opened for c in campaigns)
    total_replied = sum(c.replied for c in campaigns)
    open_rate = round(total_opened / total_sent * 100, 1) if total_sent else 0
    reply_rate = round(total_replied / total_sent * 100, 1) if total_sent else 0

    lines.append("*Итого по всем кампаниям:*")
    lines.append(f"  Писем отправлено: *{total_sent}*")
    lines.append(f"  Открыли:          *{total_opened}* ({open_rate}%)")
    lines.append(f"  Ответили:         *{total_replied}* ({reply_rate}%)")
    lines.append("")

    chunks: list[str] = []
    header_text = "\n".join(lines)

    for camp in campaigns:
        block: list[str] = []
        block.append(f"━━━━━━━━━━━━━━━━━━━━")
        block.append(f"📧 *{_escape(camp.name)}*")
        block.append(f"   Статус: {_escape(camp.status)}  |  Создано: {camp.created}")
        block.append(f"   Писем отправлено: *{camp.sent}*")
        block.append(f"   Связались:        {camp.connected_reached}/{camp.connected_total}")
        block.append(f"   Открыли:          *{camp.opened}* ({camp.opened_pct:.0f}%)")
        block.append(f"   Ответили:         *{camp.replied}* ({camp.replied_pct:.0f}%)")

        if camp.analytics:
            a = camp.analytics
            if a.interested:
                block.append(f"   Заинтересованы:   *{a.interested}* ({a.interested_pct:.0f}%)")

            if a.letters:
                block.append(f"\n   📨 *По письмам:*")
                for lt in a.letters:
                    block.append(
                        f"   • {_escape(lt.name)}: "
                        f"отправлено {lt.sent}, "
                        f"открыли {lt.opened} ({lt.opened_pct:.0f}%), "
                        f"ответили {lt.replied} ({lt.replied_pct:.0f}%)"
                    )

        chunks.append("\n".join(block))

    # Split into Telegram-safe messages (max 4096 chars)
    messages: list[str] = []
    current = header_text
    for chunk in chunks:
        candidate = current + "\n\n" + chunk
        if len(candidate) > 4000:
            messages.append(current)
            current = chunk
        else:
            current = candidate

    messages.append(current)
    return messages


def format_xlsx_report(
    campaigns: list[Campaign],
    include_created: bool = True,
    include_base_left: bool = True,
    weighted_reply_rate: bool = False,
) -> bytes:
    report_date = datetime.now().strftime("%d.%m.%Y")
    header_row = [
        "Название кампании",
        "Создано",
        "Связались",
        "Всего контактов",
        "Всего открытий",
        "% открываемости",
        "Ответов",
        "% ответов",
        "Лидов",
        "Отправлено писем",
        "Остаток базы",
    ]
    if not include_created:
        header_row.pop(1)
    if not include_base_left:
        header_row.pop()

    width = len(header_row)
    empty_row = [""] * width

    rows: list[list[object]] = [
        ["Отчет по email-кампании", *[""] * (width - 1)],
        [f"Период: c {report_date} по {report_date}", *[""] * (width - 1)],
        empty_row.copy(),
        ["Статистика по кампаниям:", *[""] * (width - 1)],
        header_row,
    ]

    campaign_rows: list[list[object]] = []
    sent_totals: list[int] = []
    replied_totals: list[int] = []

    for camp in campaigns:
        letters = camp.analytics.letters if camp.analytics else []
        main_letters = [letter for letter in letters if not letter.is_variant]
        sent_total = sum(letter.sent for letter in main_letters) if main_letters else camp.sent
        replied_total = sum(letter.replied for letter in main_letters) if main_letters else camp.replied
        base_left = camp.connected_total - camp.connected_reached

        campaign_row = [
            camp.name,
            camp.created,
            camp.connected_reached,
            camp.connected_total,
            camp.opened,
            f"{camp.opened_pct:.1f}%",
            replied_total,
            f"{camp.replied_pct:.1f}%",
            "",
            sent_total,
            base_left,
        ]
        if not include_created:
            campaign_row.pop(1)
        if not include_base_left:
            campaign_row.pop()

        campaign_rows.append(campaign_row)
        sent_totals.append(sent_total)
        replied_totals.append(replied_total)

    rows.extend(campaign_rows)

    avg_open_rate = sum(camp.opened_pct for camp in campaigns) / len(campaigns) if campaigns else 0
    if weighted_reply_rate:
        # Взвешенная отвечаемость для итога: все ответы / все связавшиеся (как «Итого»
        # в Тригге), а не среднее арифметическое процентов по кампаниям. Среднее
        # искажает результат при кампаниях разного размера и обнуляется кампаниями
        # с 0 ответов (давало 0.6% вместо реальных 2.4%). Trigga-фикс 2026-06.
        total_contacts = sum(camp.connected_reached for camp in campaigns)
        avg_reply_rate = round(sum(replied_totals) / total_contacts * 100, 1) if total_contacts else 0
    else:
        avg_reply_rate = sum(camp.replied_pct for camp in campaigns) / len(campaigns) if campaigns else 0

    summary_merge_rows: set[int] = set()

    rows.extend([
        empty_row.copy(),
        ["Общая статистика:", *[""] * (width - 1)],
        ["Показатель", "Значение", "Конверсия в след. этап", *[""] * (width - 3)],
        ["Общее количество контактов", sum(camp.connected_reached for camp in campaigns), "", *[""] * (width - 3)],
        ["Общее количество отправленных писем", sum(sent_totals), "", *[""] * (width - 3)],
        ["Количество открытий", sum(camp.opened for camp in campaigns), f"{avg_open_rate:.1f}%", *[""] * (width - 3)],
        ["Количество ответов", sum(replied_totals), f"{avg_reply_rate:.1f}%", *[""] * (width - 3)],
        ["Общее количество лидов", "", "", *[""] * (width - 3)],
    ])
    summary_header_row = len(campaign_rows) + 8
    summary_last_row = summary_header_row + 5
    summary_merge_rows.update(range(summary_header_row, summary_last_row + 1))

    detail_title_rows: set[int] = set()
    rows.append(empty_row.copy())
    rows.append(["Детализация по письмам:", *[""] * (width - 1)])

    for camp in campaigns:
        letters = camp.analytics.letters if camp.analytics else []
        if not letters:
            continue

        rows.append([camp.name, *[""] * (width - 1)])
        detail_title_rows.add(len(rows))
        rows.append(["Шаг", "Отправлено", "Открыто", "Ответов", *[""] * (width - 4)])

        for index, letter in enumerate(letters, start=1):
            letter_name = letter.name or f"Письмо {index}"
            rows.append([
                letter_name,
                letter.sent,
                f"{letter.opened} | {letter.opened_pct:.1f}%",
                f"{letter.replied} | {letter.replied_pct:.1f}%",
                *[""] * (width - 4),
            ])

        rows.append(empty_row.copy())

    sheet_name = f"Отчет {datetime.now().strftime('%d.%m')}"
    return _build_xlsx(rows, detail_title_rows, summary_merge_rows, sheet_name, width)


def _build_xlsx(
    rows: list[list[object]],
    detail_title_rows: set[int] | None = None,
    summary_merge_rows: set[int] | None = None,
    sheet_name: str = "Отчет",
    width: int = 11,
) -> bytes:
    output = BytesIO()
    sheet_xml = _worksheet_xml(rows, detail_title_rows or set(), summary_merge_rows or set(), width)

    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", _content_types_xml())
        archive.writestr("_rels/.rels", _root_rels_xml())
        archive.writestr("xl/workbook.xml", _workbook_xml(sheet_name))
        archive.writestr("xl/_rels/workbook.xml.rels", _workbook_rels_xml())
        archive.writestr("xl/styles.xml", _styles_xml())
        archive.writestr("xl/worksheets/sheet1.xml", sheet_xml)

    return output.getvalue()


def _worksheet_xml(
    rows: list[list[object]],
    detail_title_rows: set[int],
    summary_merge_rows: set[int],
    width: int,
) -> str:
    row_xml = []
    for row_number, values in enumerate(rows, start=1):
        cells = []
        for col_number, value in enumerate(values, start=1):
            style = _style_for_cell(row_number, col_number, values, detail_title_rows)
            cells.append(_cell_xml(_cell_ref(row_number, col_number), value, style))
        row_xml.append(f'<row r="{row_number}">{"".join(cells)}</row>')

    merges = [
        f"A1:{_column_name(width)}1",
        f"A2:{_column_name(width)}2",
        f"A3:{_column_name(width)}3",
        f"A4:{_column_name(width)}4",
    ]
    merges.extend(f"A{row_number}:D{row_number}" for row_number in sorted(detail_title_rows))
    merges.extend(f"C{row_number}:D{row_number}" for row_number in sorted(summary_merge_rows))
    merge_xml = "".join(f'<mergeCell ref="{ref}"/>' for ref in merges)

    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>
    <col min="1" max="1" width="46" customWidth="1"/>
    <col min="2" max="2" width="13" customWidth="1"/>
    <col min="3" max="{width}" width="16" customWidth="1"/>
  </cols>
  <sheetData>{"".join(row_xml)}</sheetData>
  <mergeCells count="{len(merges)}">{merge_xml}</mergeCells>
</worksheet>'''


def _cell_xml(ref: str, value: object, style: int) -> str:
    style_attr = f' s="{style}"' if style else ""
    if value == "":
        return f'<c r="{ref}"{style_attr}/>'
    if isinstance(value, int | float):
        return f'<c r="{ref}"{style_attr}><v>{value}</v></c>'
    return f'<c r="{ref}" t="inlineStr"{style_attr}><is><t>{escape(str(value))}</t></is></c>'


def _style_for_cell(
    row_number: int,
    col_number: int,
    values: list[object],
    detail_title_rows: set[int],
) -> int:
    if row_number == 1:
        return 1
    if row_number == 2:
        return 2
    if row_number == 4:
        return 3
    if row_number == 5:
        return 5
    if row_number in detail_title_rows:
        return 7 if col_number <= 4 else 6
    if values and values[0] in {"Общая статистика:", "Детализация по письмам:"}:
        return 3
    if values and values[0] in {"Показатель", "Шаг"}:
        if values[0] in {"Показатель", "Шаг"}:
            return 8 if col_number <= 4 else 6
    if values and str(values[0]).startswith("Письмо "):
        return 10 if col_number <= 4 else 6
    return 6


def _cell_ref(row_number: int, col_number: int) -> str:
    return f"{_column_name(col_number)}{row_number}"


def _column_name(col_number: int) -> str:
    col = ""
    while col_number:
        col_number, remainder = divmod(col_number - 1, 26)
        col = chr(65 + remainder) + col
    return col


def _content_types_xml() -> str:
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>'''


def _root_rels_xml() -> str:
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>'''


def _workbook_xml(sheet_name: str) -> str:
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="''' + escape(sheet_name) + '''" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>'''


def _workbook_rels_xml() -> str:
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''


def _styles_xml() -> str:
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="6">
    <font><sz val="9"/><name val="Arial"/></font>
    <font><b/><sz val="14"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>
    <font><sz val="9"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>
    <font><b/><sz val="9"/><name val="Arial"/></font>
    <font><b/><sz val="9"/><name val="Arial"/></font>
    <font><b/><sz val="9"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>
  </fonts>
  <fills count="6">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1E4E79"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF5B9BD5"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE2EFDA"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFD9E1F2"/></left>
      <right style="thin"><color rgb="FFD9E1F2"/></right>
      <top style="thin"><color rgb="FFD9E1F2"/></top>
      <bottom style="thin"><color rgb="FFD9E1F2"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="11">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="5" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="5" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="3" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
  </cellXfs>
</styleSheet>'''


def _escape(text: str) -> str:
    """Escape Markdown special chars for Telegram MarkdownV1."""
    for ch in ["*", "_", "`", "["]:
        text = text.replace(ch, f"\\{ch}")
    return text
