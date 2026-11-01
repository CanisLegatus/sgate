#!/usr/bin/env python3
"""Reproduce factual data checks; report source conflicts without correcting XLSX."""
import argparse
from collections import Counter
from decimal import Decimal
import hashlib
import json
from pathlib import Path
from extract_unique_values import load_order, product_rows


def audit_data(path):
    sheet, rows, layout = load_order(path)
    products = list(product_rows(rows))
    if not products:
        raise ValueError('Товарные строки не найдены.')
    def number(cells, key):
        return Decimal(cells.get(key, '0').replace(',', '.'))
    codes = Counter(c['A'] for _, c in products)
    amount = Decimal(0)
    positive = set()
    conflicts = []
    mismatch = []
    invalid_k = []
    for row, cells in products:
        if number(cells, 'V') > 0:
            positive.add(cells['A'])
            amount += number(cells, 'V') * number(cells, 'N')
        if number(cells, 'U') != sum(number(cells, k) for k in 'QRST'):
            mismatch.append(row)
        k, stock, recommendation = (number(cells, key) for key in ['K', 'L', 'Y'])
        if k <= 0 or k % 1:
            invalid_k.append(row)
        reasons = []
        if recommendation > stock:
            reasons.append('recommendation_exceeds_central_stock')
        if k > 0 and recommendation % k:
            reasons.append('recommendation_not_multiple_of_batch')
        if reasons:
            conflicts.append({'row': row, 'sku': cells['A'], 'batch': str(k),
                              'central_stock': str(stock), 'recommendation': str(recommendation),
                              'reasons': reasons})
    return {'source': str(path), 'sha256': hashlib.sha256(Path(path).read_bytes()).hexdigest(),
            'sheet': sheet, 'physical_layout': layout,
            'product_rows': len(products), 'positive_stock_sku': len(positive),
            'duplicate_sku': {sku: n for sku, n in codes.items() if n > 1},
            'blank_numeric_cells': {layout[k]: sum(not c.get(k) for _, c in products)
                                    for k in ['Q','R','S','T','V','L']},
            'retail_stock_value_rub': str(amount.quantize(Decimal('0.01'))),
            'sales_total_mismatch_rows': mismatch, 'invalid_batch_rows': invalid_k,
            'web_conflicts': conflicts}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    args = parser.parse_args()
    print(json.dumps(audit_data(args.input), ensure_ascii=False, indent=2))
