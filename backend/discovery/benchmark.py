"""Measure discovery recall against a manually curated list of known domains.

python -m backend.discovery.benchmark result.json expected.json
expected.json: {"domains": ["supplier.example", ...]}
This reports recall against the benchmark, never total market coverage.
"""
import argparse
import json
from urllib.parse import urlsplit


def measure(result, expected):
    found = set()
    for supplier in result['suppliers'] + result.get('deferred_suppliers', []):
        found.add(urlsplit(supplier['website']).hostname.removeprefix('www.').lower())
        found.update(a.lower().removeprefix('www.') for a in supplier.get('aliases', []))
    expected = {d.lower().removeprefix('www.').strip('/') for d in expected}
    return dict(expected=len(expected), found=len(expected & found),
                recall=len(expected & found) / len(expected) if expected else None,
                missed=sorted(expected - found))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('result')
    parser.add_argument('expected')
    args = parser.parse_args()
    with open(args.result) as stream:
        result = json.load(stream)
    with open(args.expected) as stream:
        expected = json.load(stream)['domains']
    print(json.dumps(measure(result.get('result', result), expected), indent=2))


if __name__ == '__main__':
    main()
