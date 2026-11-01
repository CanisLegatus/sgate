#!/usr/bin/env python3
"""Audit cube eligibility and exact spellings; writes JSON to stdout."""
import argparse
from collections import Counter
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re
from extract_unique_values import load_order, product_rows

BLOCKS = {'ЗО', 'ЗО вр', 'ЗО сеть', '!ВНЕ_АМ-1'}


def parse_cube(value):
    match = re.fullmatch(r'(.+)-(\d+(?:[.,]\d+)?)', value.strip())
    return (match[1], Decimal(match[2].replace(',', '.'))) if match else None


def classify(product, store):
    if product.strip() in BLOCKS:
        return 'explicit_block'
    if not store.strip():
        return 'closed'
    left, right = parse_cube(product), parse_cube(store)
    if not left or not right:
        return 'unparsed'
    if left[0] != right[0]:
        return 'different_family'
    return 'inside' if left[1] <= right[1] else 'outside'


def audit(path):
    sheet, rows, layout = load_order(path)
    if 'STORE_CUBE' not in layout:
        raise ValueError('В этой версии выгрузки нет столбца КУБ; это не закрытый куб.')
    counts = Counter()
    product_values, store_values, pairs = Counter(), Counter(), Counter()
    details = []
    for n, cells in product_rows(rows):
        product, store = cells.get('I', ''), cells.get('STORE_CUBE', '')
        status = classify(product, store)
        counts[status] += 1
        product_values[product] += 1
        store_values[store] += 1
        pairs[(product, store, status)] += 1
        details.append({'row': n, 'sku': cells['A'], 'product_cube': product,
                        'store_cube': store, 'status': status,
                        'web_recommendation': cells.get('Y'), 'web_total': cells.get('AA')})
    if not details:
        raise ValueError('Товарные строки не найдены.')
    assert sum(counts.values()) == len(details)
    return {'source': str(path), 'sha256': hashlib.sha256(Path(path).read_bytes()).hexdigest(),
            'sheet': sheet, 'layout': layout, 'total': len(details), 'counts': dict(counts),
            'product_values': dict(sorted(product_values.items())),
            'store_values': dict(sorted(store_values.items())),
            'pairs': [{'product': a, 'store': b, 'status': c, 'count': count}
                      for (a, b, c), count in sorted(pairs.items())], 'rows': details}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    args = parser.parse_args()
    print(json.dumps(audit(args.input), ensure_ascii=False, indent=2))
