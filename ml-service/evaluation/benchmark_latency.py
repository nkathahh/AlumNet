"""
Measure the live response time of the recommendation service (NFR-01).

Start app.py first, then run from the ml-service folder:
    python evaluation/benchmark_latency.py --mentee-id 12

Use the user_id of a real mentee who has a completed profile. The first request
is a warm-up and is not counted.
"""
import argparse
import json
import os
import statistics
import time
import urllib.request
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mentee-id', required=True)
    parser.add_argument('--runs', type=int, default=10)
    parser.add_argument('--url', default='http://localhost:5000/recommend')
    args = parser.parse_args()

    url = f'{args.url}?mentee_id={args.mentee_id}'

    def call():
        start = time.perf_counter()
        with urllib.request.urlopen(url, timeout=60) as resp:
            body = json.loads(resp.read())
        return time.perf_counter() - start, body

    _, body = call()  # warm-up
    if isinstance(body, dict) and body.get('error'):
        raise SystemExit(f'Service returned an error: {body["error"]}')

    times = [call()[0] for _ in range(args.runs)]
    ordered = sorted(times)
    result = {
        'timestamp': datetime.now().isoformat(timespec='seconds'),
        'url': args.url,
        'mentee_id': args.mentee_id,
        'mentors_returned': len(body),
        'runs': args.runs,
        'median_s': round(statistics.median(times), 3),
        'mean_s': round(statistics.mean(times), 3),
        'min_s': round(ordered[0], 3),
        'max_s': round(ordered[-1], 3),
        'p90_s': round(ordered[max(0, int(0.9 * len(ordered)) - 1)], 3),
        'meets_nfr01_3s': statistics.median(times) <= 3.0,
    }

    print(json.dumps(result, indent=2))
    os.makedirs(os.path.join(HERE, 'results'), exist_ok=True)
    path = os.path.join(HERE, 'results', f'latency_{datetime.now().strftime("%Y%m%d_%H%M%S")}.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2)
    print(f'Saved {path}')


if __name__ == '__main__':
    main()
