"""
Relevance labelling for the AlumNet matching evaluation.

Two independent judges rate each mentee-mentor pair in their sheet, without seeing any model
scores and without names (only IDs and profile text, to reduce bias):
    2 = relevant          (this mentor would be a good choice for this mentee)
    1 = partly relevant   (some useful overlap, but not a strong choice)
    0 = not relevant

Two ways to build the sheets (run from the ml-service folder):

    python evaluation/labels.py make
        Every pair: 15 mentees x 20 mentors = 300 pairs per judge.

    python evaluation/labels.py pool
        Pooled judging, the usual method in search evaluation: for each mentee,
        only the mentors that at least one method ranks in its top 5, plus 2
        mentors picked at random, are judged. Pairs nobody ranks that high are
        taken as not relevant. Writes labels/pooled/judge_A.csv and judge_B.csv
        and records exactly how the pool was built in labels/pooled/pool.json.
        The random pairs check that assumption: if judges often find relevant
        mentors among them, the pool was too shallow (combine reports this).

Then:
    1. Judges fill in the "label" column (0, 1 or 2), or use labeller.html.
       Each judge works alone and does not see the other's sheet.
    2. python evaluation/labels.py combine
         Measures agreement and writes labels/final_labels.csv. If the judges
         disagree on any pairs, it also writes judge_C.csv containing only those
         pairs. Give that to a third judge, then run combine again.
"""
import csv
import json
import os
import random
import sys

from sklearn.metrics import cohen_kappa_score

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')
LABELS = os.path.join(HERE, 'labels')

POOLED = os.path.join(LABELS, 'pooled')
POOL_FILE = os.path.join(POOLED, 'pool.json')

JUDGE_SEEDS = {'A': 101, 'B': 202}  # different pair order per judge, reproducible
VALID = {'0', '1', '2'}
POOL_DEPTH = 5           # top 5 of every method, deeper than the top 3 the metrics use
POOL_RANDOM = 2          # extra random mentors per mentee, to check what the pool missed
POOL_SEED = 303


def sheet_dir():
    """Pooled judging keeps its sheets in labels/pooled, so the full sheets are never mixed in."""
    return POOLED if os.path.exists(POOL_FILE) else LABELS


def load(name):
    with open(os.path.join(DATA, name), encoding='utf-8') as f:
        return json.load(f)


def describe(p):
    return (f"Department: {p['department']}\n"
            f"Skills: {p['skills']}\n"
            f"Experience: {p['experience']}\n"
            f"Career interests: {p['career_interests']}")


def all_pairs():
    mentors = load('mentors.json')
    mentees = load('mentees_dev.json') + load('mentees_test.json')
    return [(me, mt) for me in mentees for mt in mentors]


def write_sheets(folder, pairs):
    os.makedirs(folder, exist_ok=True)
    for judge, seed in JUDGE_SEEDS.items():
        path = os.path.join(folder, f'judge_{judge}.csv')
        if os.path.exists(path):
            print(f'{path} already exists, not overwriting it.')
            continue
        shuffled = pairs[:]
        random.Random(seed).shuffle(shuffled)
        # utf-8-sig so the file opens cleanly in Excel
        with open(path, 'w', newline='', encoding='utf-8-sig') as f:
            w = csv.writer(f)
            w.writerow(['pair_id', 'mentee_profile', 'mentor_profile', 'label'])
            for me, mt in shuffled:
                w.writerow([f"{me['id']}-{mt['id']}", describe(me), describe(mt), ''])
        print(f'Wrote {path} ({len(shuffled)} pairs)')


def pool(include_base=False):
    """Builds the pooled sheets from every method's top POOL_DEPTH mentors per mentee."""
    if os.path.exists(POOL_FILE):
        sys.exit(f'{POOL_FILE} already exists. The pool is fixed once judging starts; delete the pooled folder only if nobody has labelled yet.')
    sys.path.insert(0, HERE)
    import numpy as np
    from sentence_transformers import SentenceTransformer
    import evaluate as ev

    mentors = load('mentors.json')
    mentees = load('mentees_dev.json') + load('mentees_test.json')
    keys = ['small', 'base'] if include_base else ['small']
    models = {}
    for key in keys:
        print(f'Loading {ev.MODELS[key]}...')
        models[key] = SentenceTransformer(ev.MODELS[key])
    # Every method the development run compares, so no method is judged on unjudged pairs
    methods = ev.build_methods('dev', mentees, mentors, models, None)

    rng = random.Random(POOL_SEED)
    chosen, per_mentee = [], {}
    for i, me in enumerate(mentees):
        picked = set()
        for scores in methods.values():
            picked.update(int(j) for j in np.argsort(-scores[i], kind='stable')[:POOL_DEPTH])
        rest = [j for j in range(len(mentors)) if j not in picked]
        extra = rng.sample(rest, min(POOL_RANDOM, len(rest)))
        per_mentee[me['id']] = {
            'from_methods': sorted(mentors[j]['id'] for j in picked),
            'random_check': sorted(mentors[j]['id'] for j in extra),
        }
        chosen += [(me, mentors[j]) for j in sorted(picked | set(extra))]

    write_sheets(POOLED, chosen)
    record = {
        'depth': POOL_DEPTH,
        'random_per_mentee': POOL_RANDOM,
        'random_seed': POOL_SEED,
        'methods': list(methods.keys()),
        'models': {k: ev.MODELS[k] for k in models},
        'pairs_judged': len(chosen),
        'pairs_total': len(mentees) * len(mentors),
        'mentees': per_mentee,
    }
    with open(POOL_FILE, 'w', encoding='utf-8') as f:
        json.dump(record, f, indent=2)
    print(f'\nPooled {len(chosen)} of {record["pairs_total"]} pairs '
          f'(top {POOL_DEPTH} of {len(methods)} methods plus {POOL_RANDOM} random per mentee).')
    print(f'Saved how the pool was built to {POOL_FILE}.')
    print('Label each pair: 2 = relevant, 1 = partly relevant, 0 = not relevant.')


def carry(judge):
    """Copies one judge's ratings from the full sheet into their pooled sheet (same judge only)."""
    full = os.path.join(LABELS, f'judge_{judge}.csv')
    pooled = os.path.join(POOLED, f'judge_{judge}.csv')
    if not os.path.exists(pooled):
        sys.exit('Run "pool" first.')
    with open(full, encoding='utf-8-sig') as f:
        done = {r['pair_id']: (r.get('label') or '').strip() for r in csv.DictReader(f)}
    with open(pooled, encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        fields, rows = reader.fieldnames, list(reader)
    copied = 0
    for r in rows:
        if not (r.get('label') or '').strip() and done.get(r['pair_id']) in VALID:
            r['label'] = done[r['pair_id']]
            copied += 1
    with open(pooled, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    left = sum(1 for r in rows if not (r.get('label') or '').strip())
    print(f'Copied {copied} ratings into {pooled}. {left} of {len(rows)} pairs left to rate.')


def make():
    write_sheets(LABELS, all_pairs())
    print('\nLabel each pair: 2 = relevant, 1 = partly relevant, 0 = not relevant.')


def read_judge(judge, required=True):
    path = os.path.join(sheet_dir(), f'judge_{judge}.csv')
    if not os.path.exists(path):
        if required:
            sys.exit(f'Missing {path}. Run "make" first and collect the completed sheet.')
        return None
    labels = {}
    with open(path, encoding='utf-8-sig') as f:
        for row in csv.DictReader(f):
            value = (row.get('label') or '').strip()
            if value and value not in VALID:
                sys.exit(f'{path}: pair {row["pair_id"]} has label "{value}". Use 0, 1 or 2.')
            labels[row['pair_id']] = value
    return labels


def combine():
    a = read_judge('A')
    b = read_judge('B')
    c = read_judge('C', required=False) or {}

    missing = [p for p in a if not a[p] or not b.get(p)]
    if missing:
        sys.exit(f'{len(missing)} pairs are still unlabelled by judge A or B (for example {missing[0]}).')

    pooled = None
    if os.path.exists(POOL_FILE):
        with open(POOL_FILE, encoding='utf-8') as f:
            pooled = json.load(f)
    pair_ids = sorted(a)
    agree = [p for p in pair_ids if a[p] == b[p]]
    disagree = [p for p in pair_ids if a[p] != b[p]]
    ya = [int(a[p]) for p in pair_ids]
    yb = [int(b[p]) for p in pair_ids]

    stats = {
        'pairs': len(pair_ids),
        'exact_agreement': round(len(agree) / len(pair_ids), 3),
        'cohen_kappa': round(float(cohen_kappa_score(ya, yb)), 3),
        # Linear weights treat 0 vs 2 as a bigger disagreement than 0 vs 1
        'cohen_kappa_linear': round(float(cohen_kappa_score(ya, yb, weights='linear')), 3),
        'disagreements': len(disagree),
        'pooled': bool(pooled),
    }

    # Disagreements go to a third judge
    c_path = os.path.join(sheet_dir(), 'judge_C.csv')
    if disagree and not os.path.exists(c_path):
        lookup = {f"{me['id']}-{mt['id']}": (me, mt) for me, mt in all_pairs()}
        with open(c_path, 'w', newline='', encoding='utf-8-sig') as f:
            w = csv.writer(f)
            w.writerow(['pair_id', 'mentee_profile', 'mentor_profile', 'label'])
            for p in disagree:
                me, mt = lookup[p]
                w.writerow([p, describe(me), describe(mt), ''])
        print(f'Wrote {c_path} with {len(disagree)} disagreements for a third judge.')

    unresolved = 0
    rows = []
    for p in pair_ids:
        mentee_id, mentor_id = p.split('-')
        if a[p] == b[p]:
            final = a[p]
        else:
            final = c.get(p, '')
            if not final:
                unresolved += 1
        rows.append({
            'pair_id': p,
            'split': 'dev' if mentee_id.startswith('D') else 'test',
            'mentee_id': mentee_id,
            'mentor_id': mentor_id,
            'judge_a': a[p],
            'judge_b': b[p],
            'judge_c': c.get(p, ''),
            'final_label': final,
            'judged': 'yes',
        })

    # Pooled judging: every pair outside the pool is taken as not relevant
    if pooled:
        judged = set(pair_ids)
        for me, mt in all_pairs():
            p = f"{me['id']}-{mt['id']}"
            if p in judged:
                continue
            rows.append({'pair_id': p, 'split': 'dev' if me['id'].startswith('D') else 'test',
                         'mentee_id': me['id'], 'mentor_id': mt['id'], 'judge_a': '', 'judge_b': '',
                         'judge_c': '', 'final_label': '0', 'judged': 'no (outside the pool)'})
        rows.sort(key=lambda r: r['pair_id'])
        # How often the random check pairs turned out relevant: a sign of how much the pool missed
        final_of = {r['pair_id']: r['final_label'] for r in rows}
        checks = [f'{m}-{t}' for m, v in pooled['mentees'].items() for t in v['random_check']]
        found = [p for p in checks if final_of.get(p) == '2']
        stats.update({
            'pairs_judged': len(pair_ids),
            'pairs_assumed_not_relevant': len(rows) - len(pair_ids),
            'pool_depth': pooled['depth'],
            'random_check_pairs': len(checks),
            'random_check_relevant': len(found),
        })

    with open(os.path.join(LABELS, 'final_labels.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    stats['unresolved'] = unresolved
    with open(os.path.join(LABELS, 'agreement.json'), 'w', encoding='utf-8') as f:
        json.dump(stats, f, indent=2)

    print(json.dumps(stats, indent=2))
    if pooled and stats['random_check_relevant']:
        print(f"\nNote: {stats['random_check_relevant']} of {stats['random_check_pairs']} random check pairs were labelled relevant. "
              'Report this: it estimates how many relevant mentors the pool missed.')
    if unresolved:
        print(f'\n{unresolved} pairs still need judge C. Fill in {os.path.relpath(c_path, HERE)} and run combine again.')
    else:
        print('\nAll pairs resolved. labels/final_labels.csv is ready for evaluate.py.')


if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    if command == 'make':
        make()
    elif command == 'pool':
        pool(include_base='--include-base' in sys.argv)
    elif command == 'carry' and len(sys.argv) > 2 and sys.argv[2] in JUDGE_SEEDS:
        carry(sys.argv[2])
    elif command == 'combine':
        combine()
    else:
        print('Usage: python evaluation/labels.py make | pool [--include-base] | carry A|B | combine')
