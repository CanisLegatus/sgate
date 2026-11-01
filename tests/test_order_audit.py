"""Business edge cases, independent XLSX decoding, and checked data regressions."""
import json
from pathlib import Path
import re
import sys
import unittest
from unittest.mock import patch
from xml.etree import ElementTree as ET
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from analyze_cubes import audit, classify
from audit_order_data import audit_data
from extract_unique_values import analyze, load_order, parameters, product_rows, read_rows


def independent_rows(path):
    ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with ZipFile(path) as z:
        strings = []
        if 'xl/sharedStrings.xml' in z.namelist():
            strings = [''.join(t.text or '' for t in si.findall('.//s:t', ns))
                       for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('s:si', ns)]
        rows = []
        for row in ET.fromstring(z.read('xl/worksheets/sheet1.xml')).findall('s:sheetData/s:row', ns):
            cells = {}
            for cell in row.findall('s:c', ns):
                value = cell.find('s:v', ns)
                value = '' if value is None else value.text or ''
                if cell.get('t') == 's' and value:
                    value = strings[int(value)]
                if cell.get('t') == 'inlineStr':
                    value = ''.join(t.text or '' for t in cell.findall('.//s:t', ns))
                if value.strip():
                    cells[re.sub('[0-9]', '', cell.get('r'))] = value
            rows.append((int(row.get('r')), cells))
        return rows


class CubeRules(unittest.TestCase):
    def test_decisions(self):
        for product, store, expected in [
            ('А-0,8','А-0.5','outside'), ('А-0,1','А-0.5','inside'),
            ('А-0,1','','closed'), ('А-0,5','А-0.5','inside'),
            ('А-2','А-10','inside'), ('А-0.1','Б-9','different_family'),
            ('!А-1','А-1','different_family'), ('РП','А-1','unparsed'),
            ('СС_ЗОЛОТО-1','СС_ЗОЛОТО-1','inside')]:
            with self.subTest(product=product, store=store):
                self.assertEqual(classify(product, store), expected)
        for block in ['ЗО','ЗО вр','ЗО сеть','!ВНЕ_АМ-1']:
            self.assertEqual(classify(block, 'А-99'), 'explicit_block')

    def test_missing_cube_column_is_not_closed_cell(self):
        with patch('analyze_cubes.load_order', return_value=('test', [(7, {'A':'Код','B':'Группа/Товар'})], {})):
            with self.assertRaisesRegex(ValueError, 'нет столбца КУБ'):
                audit(Path('unused'))

    def test_no_products_is_error(self):
        with patch('analyze_cubes.load_order', return_value=('test', [(10, {'A':'Код','B':'Группа/Товар'})], {'STORE_CUBE':'Y'})):
            with self.assertRaisesRegex(ValueError, 'Товарные строки не найдены'):
                audit(Path('unused'))

    def test_header_not_hardcoded_to_row_seven(self):
        rows = [(10, {'A':'Код','B':'Группа/Товар'}), (11, {'A':'100-001','B':'Товар','K':'1','I':'А-1','STORE_CUBE':'А-2'})]
        with patch('analyze_cubes.load_order', return_value=('test', rows, {'STORE_CUBE':'Y'})), patch('pathlib.Path.read_bytes', return_value=b'fixture'):
            self.assertEqual(audit(Path('unused'))['counts'], {'inside':1})

    def test_malformed_data_not_silently_skipped(self):
        rows = [(7, {'A':'Код','B':'Группа/Товар'}), (8, {'A':'100-001'})]
        with self.assertRaisesRegex(ValueError, 'Неоднозначная строка 8'):
            list(product_rows(rows))

    def test_labels_not_duplicated(self):
        self.assertEqual(parameters('C', 'ТОП-100, И,ТОП-100'), {'ТОП-100','И'})
        self.assertEqual(parameters('AJ', 'текст, пояснение'), {'текст, пояснение'})


@unittest.skipUnless(all((ROOT / name).exists() for name in [
    'example-files/order-full.xlsx', 'example-files/order-cut.xlsx', 'analysis/cube-audit.json']),
    'Локальные Excel и аудит не публикуются; интеграционные проверки требуют локальных данных.')
class ActualFiles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.path = ROOT / 'example-files/order-full.xlsx'
        cls.raw = independent_rows(cls.path)
        cls.cubes = audit(cls.path)

    def test_raw_decoder_independently(self):
        self.assertEqual(read_rows(self.path)[1], self.raw)
        cut = ROOT / 'example-files/order-cut.xlsx'
        self.assertEqual(read_rows(cut)[1], independent_rows(cut))

    def test_both_schemas_and_shifted_values(self):
        _, rows, mapping = load_order(self.path)
        self.assertEqual({key:mapping[key] for key in ['Y','Z','AA','AD','AJ']},
                         {'Y':'Z','Z':'AA','AA':'AB','AD':'AE','AJ':'AK'})
        self.assertEqual(analyze(self.path)[1]['products'], 10626)
        self.assertEqual(analyze(ROOT / 'example-files/order-cut.xlsx')[1]['products'], 9)
        raw = dict(self.raw)
        for n, cells in rows:
            for logical, physical in mapping.items():
                self.assertEqual(cells.get(logical), raw[n].get(physical))

    def test_cube_inventory_matches_saved_and_raw(self):
        saved = json.loads((ROOT / 'analysis/cube-audit.json').read_text())
        actual = dict(self.cubes, source='example-files/order-full.xlsx')
        self.assertEqual(actual, saved)
        self.assertEqual(actual['counts'], {'explicit_block':3514,'inside':6801,'closed':235,'outside':76})
        raw = dict(self.raw)
        for result in saved['rows']:
            cells = raw[result['row']]
            self.assertEqual((result['sku'], result['product_cube'], result['store_cube'], result['web_recommendation'], result['web_total']),
                             (cells['A'],cells.get('I',''),cells.get('Y',''),cells.get('Z'),cells.get('AB')))

    def test_quality_and_known_web_conflicts(self):
        data = audit_data(self.path)
        self.assertEqual(data['product_rows'], 10626)
        self.assertEqual(data['positive_stock_sku'], 7665)
        self.assertEqual(data['retail_stock_value_rub'], '18156991.30')
        self.assertEqual(data['duplicate_sku'], {})
        self.assertEqual(data['invalid_batch_rows'], [])
        self.assertEqual(data['sales_total_mismatch_rows'], [])
        self.assertEqual({r['sku']:r['reasons'] for r in data['web_conflicts']}, {
            '398-875':['recommendation_not_multiple_of_batch'],
            '398-874':['recommendation_not_multiple_of_batch'],
            '392-153':['recommendation_exceeds_central_stock'],
            '461-704':['recommendation_exceeds_central_stock']})


if __name__ == '__main__':
    unittest.main()
