#!/usr/bin/env python3
"""Show exact candidate blocking values in column I; no output files created."""
import argparse
from collections import Counter
from extract_unique_values import load_order, product_rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input')
    args = parser.parse_args()
    _, rows, _ = load_order(args.input)
    values = Counter(cells.get('I', '') for _, cells in product_rows(rows))
    for value, count in sorted(values.items()):
        compact = ''.join(value.casefold().split()).replace('_', '')
        if compact.startswith('зо') or 'внеам' in compact:
            print(f'{value!r}: {count}')


if __name__ == '__main__':
    main()
