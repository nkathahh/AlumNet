"""
Does the "more free places first" rule spread mentees more evenly, and what
does it cost in match quality? (Review row 12.)

AlumNet ranks mentors by similarity, but compares scores in 2-point bands:
inside a band, the mentor with more free places comes first. This simulation
replays many sign-up orders with and without that rule and compares:

    Gini of mentees per mentor   0 = perfectly even, 1 = all on one mentor
    Mentors left with nobody     how many of the 20 got no mentee
    Relevant matches             share of matches the judges labelled relevant (2)
    Mean label                   average judge label of the chosen mentor (0 to 2)

Each simulated mentee is one of the 15 evaluation mentees, picked at random
(so a profile can appear more than once, as similar staff would). They pick
the first available mentor on their list, or, in the second scenario, one of
the top three at random. A mentor with no free places drops off the list.

Run from the ml-service folder (no ML service needed, the model loads here):
    python evaluation/fairness_sim.py
    python evaluation/fairness_sim.py --mentees 45 --capacity 3 --trials 300

Results are saved to evaluation/results/fairness_<time>.json for Chapter 5.
"""
import argparse
import csv
import json
import os
import random
import statistics
import sys
from datetime import datetime

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import evaluate as ev  # noqa: E402  (same text and embedding code as the evaluation)


def gini(values):
    xs = sorted(values)
    n, total = len(xs), sum(xs)
    if not n or not total:
        return 0.0
    cumulative = sum((i + 1) * x for i, x in enumerate(xs))
    return (2 * cumulative) / (n * total) - (n + 1) / n


def load_labels():
    path = os.path.join(HERE, 'labels', 'final_labels.csv')
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as f:
        return {(r['mentee_id'], r['mentor_id']): int(r['final_label']) for r in csv.DictReader(f) if r['final_label']}


def ranked(scores_row, free, use_rule):
    """Mentor indexes in the order AlumNet would list them for one mentee."""
    pct = np.round(scores_row * 100, 1)  # the app shows similarity as a percentage
    order = [j for j in range(len(pct)) if free[j] > 0]
    if use_rule:
        order.sort(key=lambda j: (-np.floor(pct[j] / 2), -free[j], -pct[j]))
    else:
        order.sort(key=lambda j: -pct[j])
    return order


def run(scores, mentees, mentors, labels, args, use_rule, pick):
    results = []
    for t in range(args.trials):
        rng = random.Random(args.seed + t)
        free = [args.capacity] * len(mentors)
        taken = [0] * len(mentors)
        chosen_labels, unplaced = [], 0
        for _ in range(args.mentees):
            i = rng.randrange(len(mentees))
            order = ranked(scores[i], free, use_rule)
            if not order:
                unplaced += 1
                continue
            j = order[0] if pick == 'first' else rng.choice(order[:3])
            free[j] -= 1
            taken[j] += 1
            if labels:
                chosen_labels.append(labels.get((mentees[i]['id'], mentors[j]['id']), 0))
        results.append({
            'gini': gini(taken),
            'mentors_with_none': sum(1 for x in taken if x == 0),
            'relevant_share': (sum(1 for x in chosen_labels if x == 2) / len(chosen_labels)) if chosen_labels else None,
            'mean_label': statistics.mean(chosen_labels) if chosen_labels else None,
            'unplaced': unplaced,
        })

    def summary(key):
        xs = [r[key] for r in results if r[key] is not None]
        return {'mean': round(statistics.mean(xs), 3), 'sd': round(statistics.pstdev(xs), 3)} if xs else None

    return {k: summary(k) for k in ('gini', 'mentors_with_none', 'relevant_share', 'mean_label', 'unplaced')}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mentees', type=int, default=40, help='mentees signing up in each trial')
    parser.add_argument('--capacity', type=int, default=3, help='places per mentor (the app default is 3)')
    parser.add_argument('--trials', type=int, default=200)
    parser.add_argument('--seed', type=int, default=7)
    args = parser.parse_args()

    mentors = ev.load_json('mentors.json')
    mentees = ev.load_json('mentees_dev.json') + ev.load_json('mentees_test.json')
    labels = load_labels()
    print(f'Loading {ev.MODELS["small"]}...')
    model = ev.SentenceTransformer(ev.MODELS['small'])
    # The deployed ranking: whole-profile similarity
    scores = ev.bge_components(model, mentees, mentors)['whole']

    out = {
        'run_at': datetime.now().isoformat(timespec='seconds'),
        'settings': vars(args) | {'mentors': len(mentors), 'mentee_profiles': len(mentees), 'places_total': len(mentors) * args.capacity,
                                  'band_points': 2, 'model': ev.MODELS['small'], 'labels_used': bool(labels)},
        'scenarios': {}
    }
    print(f'\n{args.trials} trials, {args.mentees} mentees, {len(mentors)} mentors with {args.capacity} places each\n')
    print(f'{"Scenario":<62}{"Gini":>8}{"No mentee":>11}{"Relevant":>10}{"Mean label":>12}')
    for pick, pick_words in (('first', 'picks the first'), ('top3', 'picks one of the top 3')):
        for use_rule in (False, True):
            name = f'{"With" if use_rule else "Without"} the free-places rule, mentee {pick_words}'
            s = run(scores, mentees, mentors, labels, args, use_rule, pick)
            out['scenarios'][name] = s
            rel = f'{s["relevant_share"]["mean"]:.0%}' if s['relevant_share'] else 'n/a'
            ml = f'{s["mean_label"]["mean"]:.2f}' if s['mean_label'] else 'n/a'
            print(f'{name:<62}{s["gini"]["mean"]:>8.2f}{s["mentors_with_none"]["mean"]:>11.1f}{rel:>10}{ml:>12}')

    os.makedirs(os.path.join(HERE, 'results'), exist_ok=True)
    path = os.path.join(HERE, 'results', f'fairness_{datetime.now().strftime("%Y%m%d_%H%M%S")}.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2)
    print(f'\nSaved {path}')
    print('Lower Gini and fewer mentors with no mentee mean a fairer spread. Compare the relevant share to see what fairness costs.')


if __name__ == '__main__':
    main()
