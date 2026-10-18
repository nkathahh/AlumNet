"""
Relevance labelling for the AlumNet matching evaluation.

Two independent judges rate every mentee-mentor pair, without seeing any model
scores and without names (only IDs and profile text, to reduce bias):
    2 = relevant          (this mentor would be a good choice for this mentee)
    1 = partly relevant   (some useful overlap, but not a strong choice)
    0 = not relevant

Steps (run from the ml-service folder):
    1. python evaluation/labels.py make
         Creates labels/judge_A.csv and labels/judge_B.csv. Give one to each judge.
    2. Judges fill in the "label" column (0, 1 or 2) and return the files.
    3. python evaluation/labels.py combine
         Measures agreement and writes labels/final_labels.csv. If the judges
         disagree on any pairs, it also writes labels/judge_C.csv containing only
         those pairs. Give that to a third judge, then run combine again.
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

JUDGE_SEEDS = {'A': 101, 'B': 202}  # different pair order per judge, reproducible
VALID = {'0', '1', '2'}


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


def make():
    os.makedirs(LABELS, exist_ok=True)
    pairs = all_pairs()
    for judge, seed in JUDGE_SEEDS.items():
        path = os.path.join(LABELS, f'judge_{judge}.csv')
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
    print('\nLabel each pair: 2 = relevant, 1 = partly relevant, 0 = not relevant.')


def read_judge(judge, required=True):
    path = os.path.join(LABELS, f'judge_{judge}.csv')
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
    }

    # Disagreements go to a third judge
    c_path = os.path.join(LABELS, 'judge_C.csv')
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
        })

    with open(os.path.join(LABELS, 'final_labels.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    stats['unresolved'] = unresolved
    with open(os.path.join(LABELS, 'agreement.json'), 'w', encoding='utf-8') as f:
        json.dump(stats, f, indent=2)

    print(json.dumps(stats, indent=2))
    if unresolved:
        print(f'\n{unresolved} pairs still need judge C. Fill in labels/judge_C.csv and run combine again.')
    else:
        print('\nAll pairs resolved. labels/final_labels.csv is ready for evaluate.py.')


if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    if command == 'make':
        make()
    elif command == 'combine':
        combine()
    else:
        print('Usage: python evaluation/labels.py make | combine')
