#!/usr/bin/env python3
"""Extract exact categorical values from a Web-order XLSX (standard library only)."""
import argparse
from collections import Counter
import hashlib
import html
from pathlib import Path
import posixpath
import xml.etree.ElementTree as ET
from zipfile import ZipFile

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
COLUMNS = {
    'C': 'Коммерческая категория', 'D': 'Коммерческая категория',
    'E': 'Мерчендайзинговая категория', 'F': 'Категория торговая',
    'G': 'Акции', 'H': 'Категория цены магазина',
    'J': 'ТОП100 на дату поставки', 'AI': 'Склад прихода товара',
    'AJ': 'Комментарий', 'AK': 'Предупреждения',
}


MULTIVALUE_COLUMNS = {'C', 'D', 'E'}


def parameters(column, value):
    """Count each comma-separated label at most once per product row."""
    if column in MULTIVALUE_COLUMNS:
        return {part.strip() for part in value.split(',') if part.strip()} or {''}
    return {value} if value.strip() else {''}


def text_content(element):
    return ''.join(node.text or '' for node in element.iterfind('.//s:t', NS))


def read_rows(path):
    """Read actual cells, ignoring the unreliable worksheet dimension attribute."""
    with ZipFile(path) as archive:
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            root = ET.fromstring(archive.read('xl/sharedStrings.xml'))
            strings = [text_content(si) for si in root.findall('s:si', NS)]
        workbook = ET.fromstring(archive.read('xl/workbook.xml'))
        sheets = workbook.findall('s:sheets/s:sheet', NS)
        if len(sheets) != 1:
            raise ValueError('Ожидается ровно один лист; выбор листа требует уточнения.')
        sheet = sheets[0]
        rel_id = sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
        rels = ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
        target = next(r.get('Target') for r in rels if r.get('Id') == rel_id)
        member = target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/' + target)
        root = ET.fromstring(archive.read(member))
        rows = []
        for row in root.findall('s:sheetData/s:row', NS):
            cells = {}
            for cell in row.findall('s:c', NS):
                ref = cell.get('r', '')
                column = ''.join(c for c in ref if c.isalpha())
                value = cell.find('s:v', NS)
                raw = value.text or '' if value is not None else ''
                kind = cell.get('t')
                if kind == 's' and raw:
                    raw = strings[int(raw)]
                elif kind == 'inlineStr':
                    raw = text_content(cell)
                if cell.find('s:f', NS) is not None:
                    raise ValueError(f'Формула в {ref}: нужен проверенный экспорт значений.')
                if kind == 'e':
                    raise ValueError(f'Ошибка Excel в {ref}: {raw}')
                if raw.strip():
                    cells[column] = raw  # Preserve whitespace, case, and combined labels.
            rows.append((int(row.get('r')), cells))
        return sheet.get('name'), rows


def load_order(path):
    """Return legacy logical keys plus the actual column mapping for both exports."""
    sheet, rows = read_rows(path)
    found = [(n, c) for n, c in rows if c.get('A') == 'Код' and c.get('B') == 'Группа/Товар']
    if len(found) != 1:
        raise ValueError('Не найдена однозначная строка заголовков.')
    number, header = found[0]
    legacy = ['Код', 'Группа/Товар', 'Коммерческая категория', 'Коммерческая категория',
              'Мерчендайзинговая категория', 'Категория торговая', 'Акции',
              'Категория цены магазина', 'Категория куб', 'ТОП100 на дату поставки',
              'Мин. партия', 'Всего Кол-во', 'Себестоимость', 'Цена магазина',
              'Наценка факт', 'Дата последней поставки',
              'История продаж (Продажи -4 недели)', 'История продаж (Продажи -3 недели)',
              'История продаж (Продажи -2 недели)', 'История продаж (Продажи -1 неделя)',
              'Продажи всего', 'Остаток факт', 'Запас факт', 'МТЗ', 'Рек', 'Заказ УМ',
              'Заказ итого', 'Запас дней (план)', 'Товар в пути', 'Товар в поставке',
              'Распределения', 'Необработанные заказы', 'Дата окончания продаж',
              'Дата прихода следующей партии товара (контейнера)', 'Склад прихода товара',
              'Комментарий', 'Предупреждения']
    def letter(index):
        return chr(65 + index) if index < 26 else 'A' + chr(65 + index - 26)
    mapping = {}
    used = set()
    for index, title in enumerate(legacy):
        matches = [col for col, name in header.items() if name == title and col not in used]
        if len(matches) != (2 if index == 2 else 1):
            raise ValueError(f'Неоднозначный/отсутствующий заголовок: {title}')
        col = matches[0]
        mapping[letter(index)] = col
        used.add(col)
    cube = [col for col, name in header.items() if name == 'КУБ']
    if len(cube) > 1:
        raise ValueError('Повтор заголовка КУБ')
    if cube:
        mapping['STORE_CUBE'] = cube[0]
    inverse = {actual: logical for logical, actual in mapping.items()}
    normalized = [(n, {inverse.get(col, 'EXTRA_' + col): value for col, value in cells.items()})
                  for n, cells in rows]
    return sheet, normalized, mapping


def order_header(rows):
    matches = [(n, c) for n, c in rows if c.get('A') == 'Код' and c.get('B') == 'Группа/Товар']
    if len(matches) != 1:
        raise ValueError('Не найдена однозначная строка заголовков.')
    return matches[0]


def product_rows(rows):
    """Shared classification; never silently discard a malformed data row."""
    header_row, _ = order_header(rows)
    for number, cells in rows:
        if number <= header_row or not cells:
            continue
        if set(cells) == {'A', 'B'} or set(cells) == {'B'}:
            continue
        if not (cells.get('A') and cells.get('B') and cells.get('K')):
            raise ValueError(f'Неоднозначная строка {number}: поля {sorted(cells)}')
        yield number, cells


def analyze(path):
    sheet, rows, _ = load_order(path)
    headers = [(n, c) for n, c in rows if c.get('A') == 'Код' and c.get('B') == 'Группа/Товар']
    if len(headers) != 1:
        raise ValueError('Не найдена однозначная строка заголовков.')
    header_row, headers = headers[0]
    for column, expected in COLUMNS.items():
        if headers.get(column) != expected:
            raise ValueError(f'Неожиданный заголовок {column}: {headers.get(column)!r}')
    counts = {c: Counter() for c in COLUMNS}
    totals = Counter(xml_rows=len(rows), filled_rows=sum(bool(c) for _, c in rows))
    for number, cells in rows:
        if number <= header_row:
            continue
        if not cells:
            totals['empty_rows'] += 1
        elif set(cells) <= {'A', 'B'} and cells.get('A') and cells.get('B'):
            totals['groups'] += 1
        elif set(cells) == {'B'}:
            totals['name_only_rows'] += 1
        elif cells.get('A') and cells.get('B') and cells.get('K'):
            # In these exports every product has a minimum batch; groups have A/B only.
            totals['products'] += 1
            for column in COLUMNS:
                counts[column].update(parameters(column, cells.get(column, '')))
        else:
            raise ValueError(f'Неоднозначная строка {number}: поля {sorted(cells)}')
    if not totals['products']:
        raise ValueError('Товарные строки не найдены.')
    filled_header = sum(bool(c) for n, c in rows if n <= header_row)
    assert totals['filled_rows'] == filled_header + totals['groups'] + totals['products'] + totals['name_only_rows']
    assert all(0 < frequency <= totals['products'] for counter in counts.values() for frequency in counter.values())
    assert all(sum(counter.values()) == totals['products'] for column, counter in counts.items() if column not in MULTIVALUE_COLUMNS)
    return sheet, totals, counts


def md(value):
    # Make exact whitespace visible; do not merge distinct source values.
    escaped = html.escape(value).replace('|', '&#124;')
    return escaped.replace('\r', '&#92;r').replace('\n', '&#92;n').replace('\t', '&#92;t').replace(' ', '&nbsp;')


def report(path, sheet, totals, counts):
    _, _, layout = load_order(path)
    lines = ['# Уникальные значения для разбора логики заказа', '',
             f'Источник: `{path.name}`. Лист: `{sheet}`.',
             f'SHA-256 исходного файла: `{hashlib.sha256(path.read_bytes()).hexdigest()}`.', '',
             f"Товарных строк: **{totals['products']}**; групп: **{totals['groups']}**; "
             f"заполненных строк вместе с шапкой: **{totals['filled_rows']}**.",
             f"Строк только с названием в B (исключены отдельно): **{totals['name_only_rows']}**.", '',
             'Частоты считаются по товарным строкам, а не по уникальным артикулам. '
             'Строки групп содержат только A/B; товары определены по заполненным A/B/K. '
             'Строки только с B учтены отдельно: выбранные поля в них пусты. '
             'Прочие неоднозначные строки вызывают ошибку скрипта.', '',
             'В C, D и E значения разделены по запятым; пробелы по краям параметров удалены. '
             'Повтор параметра внутри одной ячейки учитывается один раз. '
             'Частота параметра включает как отдельные значения, так и сочетания; '
             'поэтому сумма частот может превышать число товарных строк. '
             'Остальные поля сохранены целиком. Пустые значения учитываются отдельно.', '',
             'Заполни «Влияет на решение?» (да / нет / зависит) и пояснение. '
             'Пустое значение тоже можно прокомментировать. '
             'Это все значения в данном файле, а не все возможные значения системы.', '',
             '## Сводка', '', '| Колонка | Поле | Уникальных непустых | Пустых строк |',
             '| --- | --- | ---: | ---: |']
    for column, title in COLUMNS.items():
        counter = counts[column]
        lines.append(f'| {layout[column]} | {title} | {len(counter) - int("" in counter)} | {counter[""]} |')
    for column, title in COLUMNS.items():
        counter = counts[column]
        lines += ['', f'## {layout[column]} — {title}', '',
                  '| Значение | Товарных строк | Влияет на решение? | Как влияет / пояснение |',
                  '| --- | ---: | --- | --- |']
        for value, count in sorted(counter.items(), key=lambda pair: (-pair[1], pair[0])):
            label = md(value) if value else '**(пусто)**'
            lines.append(f'| {label} | {count} | | |')
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path, help='Новый файл Markdown или - для stdout')
    args = parser.parse_args()
    sheet, totals, counts = analyze(args.input)
    if str(args.output) == '-':
        print(report(args.input, sheet, totals, counts), end='')
        return
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Never overwrite a report that may already contain the owner's annotations.
    with args.output.open('x', encoding='utf-8') as output:
        output.write(report(args.input, sheet, totals, counts))
    print(f'{args.output}: {dict(totals)}')
    print('Unique nonempty:', {c: len(v) - int('' in v) for c, v in counts.items()})


if __name__ == '__main__':
    main()
