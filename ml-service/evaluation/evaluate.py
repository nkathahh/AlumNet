"""
AlumNet mentor matching evaluation: development and held-out test sets.

The development set is used to choose a method. The test set is run once, after
that choice is fixed, and gives the final result. This keeps the test set from
quietly becoming development data.

Run from the ml-service folder with the venv active:
    python evaluation/evaluate.py --split dev
    python evaluation/evaluate.py --split dev --latency       (also time each method)
    python evaluation/evaluate.py --split dev --include-base  (also try bge-base, about 440 MB download)
    python evaluation/evaluate.py --split test                (run once, after reviewing selected_method.json)

Relevance labels come from labels/final_labels.csv (see labels.py). No model is
trained. TF-IDF and BGE are deterministic; the only randomness is the
department baseline's tie-break, which uses a fixed seed.
"""
import argparse
import csv
import json
import os
import platform
import random
import statistics
import subprocess
import sys
import time
from datetime import datetime

import numpy as np
import sklearn
import sentence_transformers
from sentence_transformers import SentenceTransformer
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')
LABELS_FILE = os.path.join(HERE, 'labels', 'final_labels.csv')
RESULTS = os.path.join(HERE, 'results')
SELECTION_FILE = os.path.join(HERE, 'selected_method.json')
TEST_LOCK = os.path.join(RESULTS, 'TEST_RUN_DONE.json')

K = 3            # metrics look at the top 3 recommendations
RELEVANT = 2     # final label meaning "relevant"; 1 = partly relevant, 0 = not relevant
SEED = 42        # department baseline tie-break

MODELS = {'small': 'BAAI/bge-small-en-v1.5', 'base': 'BAAI/bge-base-en-v1.5'}
DEPLOYED = 'BGE-small whole profile'

# A few fixed weightings rather than a fine search: with a small development set,
# trying many combinations would just fit noise.
WEIGHT_PRESETS = {
    'equal': {'skills': 1 / 3, 'experience': 1 / 3, 'goals': 1 / 3},
    'goals 40%': {'skills': 0.35, 'experience': 0.25, 'goals': 0.40},
    'goals 50%': {'skills': 0.25, 'experience': 0.25, 'goals': 0.50},
}

TFIDF_SETTINGS = {'stop_words': 'english', 'ngram_range': (1, 2)}

# Acceptance criteria. Update these to whatever is agreed with the supervisor,
# and do it BEFORE running the test split.
ACCEPTANCE = {
    'AC1_hit_rate_at_3': 0.80,
    'AC2_precision_at_3': 0.50,
    'AC5_median_latency_seconds': 3.0,
    'AC6_max_department_gap': 0.20,
}
# Where the targets came from, saved with every test run
ACCEPTANCE_SOURCE = ('Default targets, fixed before the test run on 24 October 2026. '
                     'The supervisor could not be reached, so they were not changed or approved.')

LATENCY_POOL_SIZES = [20, 100, 200]
LATENCY_REPEATS = 5


# ---------------------------------------------------------------- data

def load_json(name):
    with open(os.path.join(DATA, name), encoding='utf-8') as f:
        return json.load(f)


def whole(p):
    return '. '.join(x for x in [p['skills'], p['experience'], p['career_interests']] if x)


def background(p):
    """What a mentor has done: skills plus experience, without their own interests."""
    return '. '.join(x for x in [p['skills'], p['experience']] if x)


def load_labels(split, mentees, mentors):
    if not os.path.exists(LABELS_FILE):
        sys.exit('labels/final_labels.csv not found. Collect the judges\' sheets and run labels.py combine first.')
    labels = {}
    with open(LABELS_FILE, encoding='utf-8') as f:
        for row in csv.DictReader(f):
            if row['split'] == split:
                if not row['final_label']:
                    sys.exit(f'Pair {row["pair_id"]} has no final label yet. Resolve it with judge C first.')
                labels[(row['mentee_id'], row['mentor_id'])] = int(row['final_label'])
    matrix = np.zeros((len(mentees), len(mentors)), dtype=int)
    for i, me in enumerate(mentees):
        for j, mt in enumerate(mentors):
            key = (me['id'], mt['id'])
            if key not in labels:
                sys.exit(f'Missing label for {key}. Every mentee-mentor pair must be labelled.')
            matrix[i, j] = labels[key]
    return matrix


# ---------------------------------------------------------------- scoring
# Each function returns a matrix: one row per mentee, one column per mentor.

def department_scores(mentees, mentors):
    """Simplest baseline: recommend mentors from the mentee's own department."""
    rng = random.Random(SEED)
    return np.array([[(1.0 if me['department'] == mt['department'] else 0.0) + rng.random() * 1e-3
                      for mt in mentors] for me in mentees])


def tfidf_scores(mentees, mentors):
    # The vocabulary and IDF weights are fitted on the mentor pool only, so no
    # information from the evaluation mentees leaks into the baseline.
    vectorizer = TfidfVectorizer(**TFIDF_SETTINGS).fit([whole(m) for m in mentors])
    return cosine_similarity(vectorizer.transform([whole(m) for m in mentees]),
                             vectorizer.transform([whole(m) for m in mentors]))


def embed(model, texts):
    return model.encode(texts, normalize_embeddings=True)


def bge_components(model, mentees, mentors):
    """Encode each text once; return the whole-profile and per-field similarity matrices."""
    me_whole = embed(model, [whole(m) for m in mentees])
    me_skills = embed(model, [m['skills'] for m in mentees])
    me_exp = embed(model, [m['experience'] for m in mentees])
    me_goals = embed(model, [m['career_interests'] for m in mentees])
    mt_whole = embed(model, [whole(m) for m in mentors])
    mt_skills = embed(model, [m['skills'] for m in mentors])
    mt_exp = embed(model, [m['experience'] for m in mentors])
    mt_background = embed(model, [background(m) for m in mentors])
    return {
        'whole': cosine_similarity(me_whole, mt_whole),
        'skills': cosine_similarity(me_skills, mt_skills),
        'experience': cosine_similarity(me_exp, mt_exp),
        'goals': cosine_similarity(me_goals, mt_background),
    }


def field_weighted(components, weights):
    return (weights['skills'] * components['skills']
            + weights['experience'] * components['experience']
            + weights['goals'] * components['goals'])


# ---------------------------------------------------------------- metrics

def per_mentee_metrics(scores_row, labels_row):
    order = np.argsort(-scores_row, kind='stable')
    top = order[:K]
    n_relevant = int((labels_row >= RELEVANT).sum())
    first_relevant = next((r + 1 for r, j in enumerate(order) if labels_row[j] >= RELEVANT), None)
    return {
        'n_relevant': n_relevant,
        'hit_at_3': bool(any(labels_row[j] >= RELEVANT for j in top)),
        'precision_at_3': float(sum(1 for j in top if labels_row[j] >= RELEVANT) / K),
        # Plain P@3 can never reach 1.0 when a mentee has fewer than 3 relevant mentors,
        # so the capped version divides by the most that were achievable instead.
        'precision_at_3_capped': (float(sum(1 for j in top if labels_row[j] >= RELEVANT) / min(K, n_relevant))
                                  if n_relevant else 0.0),
        'hit_at_3_lenient': bool(any(labels_row[j] >= 1 for j in top)),  # counts "partly relevant" too
        'reciprocal_rank': 1.0 / first_relevant if first_relevant else 0.0,
        'first_relevant_rank': first_relevant,
        'top': [int(j) for j in top],
    }


def aggregate(rows):
    """Mean metrics over mentees that have at least one relevant mentor."""
    usable = [r for r in rows if r['n_relevant'] > 0]
    if not usable:
        return {'mentees': 0, 'excluded_no_relevant': len(rows)}
    hits = sum(r['hit_at_3'] for r in usable)
    return {
        'mentees': len(usable),
        'excluded_no_relevant': len(rows) - len(usable),
        'hit_at_3': round(hits / len(usable), 3),
        'hit_at_3_count': f'{hits}/{len(usable)}',
        'precision_at_3': round(statistics.mean(r['precision_at_3'] for r in usable), 3),
        'precision_at_3_capped': round(statistics.mean(r['precision_at_3_capped'] for r in usable), 3),
        'mrr': round(statistics.mean(r['reciprocal_rank'] for r in usable), 3),
        'hit_at_3_lenient': round(sum(r['hit_at_3_lenient'] for r in usable) / len(usable), 3),
    }


def subsets(rows, mentees):
    groups = {}
    for key in ('department', 'phrasing', 'career_switch'):
        values = sorted({str(m[key]) for m in mentees})
        groups[key] = {v: aggregate([r for r, m in zip(rows, mentees) if str(m[key]) == v]) for v in values}
    return groups


# ---------------------------------------------------------------- latency

def time_like_app(model, mentee, mentors):
    """Mirror app.py: encode the mentee and every mentor on each request, then rank."""
    start = time.perf_counter()
    texts = [whole(mentee), mentee['skills'], mentee['experience'], mentee['career_interests']]
    for m in mentors:
        texts += [whole(m), m['skills'], m['experience'], background(m)]
    vectors = embed(model, texts)
    cosine_similarity(vectors[:1], vectors[4::4])
    return time.perf_counter() - start


def latency_profile(model, mentee, mentors):
    results = {}
    for size in LATENCY_POOL_SIZES:
        pool = (mentors * (size // len(mentors) + 1))[:size]  # repeat the pool to simulate more mentors
        time_like_app(model, mentee, pool)  # warm-up, not counted
        runs = [time_like_app(model, mentee, pool) for _ in range(LATENCY_REPEATS)]
        results[str(size)] = {'median_s': round(statistics.median(runs), 3), 'max_s': round(max(runs), 3)}
    return results


# ---------------------------------------------------------------- helpers

def git_commit():
    try:
        return subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'],
                                       stderr=subprocess.DEVNULL).decode().strip()
    except Exception:
        return 'unknown'


def method_key(method):
    """Which embedding model a method name uses, or None for the baselines."""
    for key in MODELS:
        if method.startswith(f'BGE-{key} '):
            return key
    return None


def build_methods(split, mentees, mentors, models, selection):
    methods = {
        'Department baseline': department_scores(mentees, mentors),
        'TF-IDF baseline': tfidf_scores(mentees, mentors),
    }
    for key, model in models.items():
        comps = bge_components(model, mentees, mentors)
        methods[f'BGE-{key} whole profile'] = comps['whole']
        for preset, weights in WEIGHT_PRESETS.items():
            methods[f'BGE-{key} field ({preset})'] = field_weighted(comps, weights)

    if split == 'test':
        # On the test set, report only the baselines, the deployed method and the
        # method chosen on the development set. Reporting every variant here would
        # invite picking whichever happened to do best on the test set.
        keep = {'Department baseline', 'TF-IDF baseline', DEPLOYED, selection['method']}
        methods = {k: v for k, v in methods.items() if k in keep}
    return methods


# ---------------------------------------------------------------- main

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--split', choices=['dev', 'test'], required=True)
    parser.add_argument('--include-base', action='store_true', help='also evaluate bge-base-en-v1.5')
    parser.add_argument('--latency', action='store_true', help='measure per-request time for each embedding model')
    parser.add_argument('--rerun-test', action='store_true', help='allow the test split to run again')
    args = parser.parse_args()

    selection = None
    if args.split == 'test':
        if not os.path.exists(SELECTION_FILE):
            sys.exit('Run the dev split first. It writes selected_method.json, which the test run needs.')
        with open(SELECTION_FILE, encoding='utf-8') as f:
            selection = json.load(f)
        if os.path.exists(TEST_LOCK) and not args.rerun_test:
            sys.exit('The test set has already been run. Rerunning it after seeing the results turns it into '
                     'development data. If you must, pass --rerun-test; the result will be marked as a rerun.')

    mentors = load_json('mentors.json')
    mentees = load_json(f'mentees_{args.split}.json')
    labels = load_labels(args.split, mentees, mentors)

    keys = ['small']
    if args.include_base or (selection and method_key(selection['method']) == 'base'):
        keys.append('base')
    models = {}
    for key in keys:
        print(f'Loading {MODELS[key]}...')
        models[key] = SentenceTransformer(MODELS[key])

    methods = build_methods(args.split, mentees, mentors, models, selection)

    run_id = datetime.now().strftime('%Y%m%d_%H%M%S')
    os.makedirs(RESULTS, exist_ok=True)
    summary, csv_rows, pair_rows = {}, [], []

    print(f'\n=== {args.split.upper()} set: {len(mentees)} mentees, {len(mentors)} mentors ===\n')
    print(f'{"Method":<32} {"Hit@3":>12} {"P@3":>6} {"P@3 capped":>11} {"MRR":>6} {"Hit@3 lenient":>14}')

    for method, scores in methods.items():
        rows = [per_mentee_metrics(scores[i], labels[i]) for i in range(len(mentees))]
        agg = aggregate(rows)
        summary[method] = {'overall': agg, 'subsets': subsets(rows, mentees)}

        # Every mentee-mentor score with its label and rank, used by plots.py
        for i, me in enumerate(mentees):
            order = np.argsort(-scores[i], kind='stable')
            rank_of = {int(j): r + 1 for r, j in enumerate(order)}
            for j, mt in enumerate(mentors):
                pair_rows.append({
                    'run_id': run_id, 'split': args.split, 'method': method,
                    'mentee_id': me['id'], 'mentor_id': mt['id'],
                    'score': round(float(scores[i, j]), 5),
                    'label': int(labels[i, j]), 'rank': rank_of[j],
                })

        for me, r in zip(mentees, rows):
            csv_rows.append({
                'run_id': run_id, 'split': args.split, 'method': method,
                'mentee_id': me['id'], 'department': me['department'],
                'phrasing': me['phrasing'], 'career_switch': me['career_switch'],
                'n_relevant': r['n_relevant'], 'hit_at_3': r['hit_at_3'],
                'precision_at_3': round(r['precision_at_3'], 3),
                'precision_at_3_capped': round(r['precision_at_3_capped'], 3),
                'first_relevant_rank': r['first_relevant_rank'] or '',
                'top_3': '; '.join(mentors[j]['id'] for j in r['top']),
            })

        if agg['mentees']:
            print(f'{method:<32} {agg["hit_at_3"]:>6.2f} ({agg["hit_at_3_count"]:>5}) '
                  f'{agg["precision_at_3"]:>6.2f} {agg["precision_at_3_capped"]:>11.2f} '
                  f'{agg["mrr"]:>6.2f} {agg["hit_at_3_lenient"]:>14.2f}')

    excluded = next(iter(summary.values()))['overall'].get('excluded_no_relevant', 0)
    if excluded:
        print(f'\nNote: {excluded} mentee(s) had no mentor labelled relevant and are excluded from the metrics.')

    print('\nBy phrasing (Hit@3):')
    for method, s in summary.items():
        parts = ', '.join(f'{k} {v.get("hit_at_3_count", "-")}' for k, v in s['subsets']['phrasing'].items())
        print(f'  {method:<32} {parts}')

    latency = {}
    if args.latency:
        print('\nMeasuring response time (this mirrors app.py and can take a few minutes)...')
        for key, model in models.items():
            latency[MODELS[key]] = latency_profile(model, mentees[0], mentors)
            for size, v in latency[MODELS[key]].items():
                print(f'  {MODELS[key]:<24} {size:>4} mentors: median {v["median_s"]:.3f}s, max {v["max_s"]:.3f}s')

    meta = {
        'run_id': run_id,
        'split': args.split,
        'git_commit': git_commit(),
        'python': platform.python_version(),
        'sentence_transformers': sentence_transformers.__version__,
        'scikit_learn': sklearn.__version__,
        'models': {k: MODELS[k] for k in models},
        'k': K,
        'relevant_label': RELEVANT,
        'weight_presets': WEIGHT_PRESETS,
        'tfidf_settings': {k: list(v) if isinstance(v, tuple) else v for k, v in TFIDF_SETTINGS.items()},
        'department_tiebreak_seed': SEED,
        'mentees': len(mentees),
        'mentors': len(mentors),
        'results': summary,
        'latency': latency,
    }
    # How the labels were made (pooled or every pair, and how far the judges agreed)
    agreement_file = os.path.join(HERE, 'labels', 'agreement.json')
    if os.path.exists(agreement_file):
        with open(agreement_file, encoding='utf-8') as f:
            meta['labels'] = json.load(f)

    if args.split == 'dev':
        # Suggest the best embedding method on the development set. Baselines are
        # excluded because the point is to choose which BGE configuration to deploy.
        candidates = {m: s['overall'] for m, s in summary.items() if method_key(m) and s['overall'].get('mentees')}
        best = max(candidates, key=lambda m: (candidates[m]['hit_at_3'], candidates[m]['precision_at_3'],
                                              candidates[m]['mrr'], m == DEPLOYED))
        selection_record = {
            'method': best,
            'chosen_on': 'development set',
            'dev_run_id': run_id,
            'dev_metrics': candidates[best],
            'git_commit': meta['git_commit'],
            'note': 'Review this choice before running the test split. Ties favour the deployed method.',
        }
        with open(SELECTION_FILE, 'w', encoding='utf-8') as f:
            json.dump(selection_record, f, indent=2)
        meta['selection'] = selection_record
        print(f'\nSuggested method (highest Hit@3, then P@3, then MRR on the dev set): {best}')
        print('Saved to evaluation/selected_method.json. Review it before running --split test.')

    else:
        meta['selection'] = selection
        meta['test_set_untouched'] = not os.path.exists(TEST_LOCK)
        chosen = summary[selection['method']]['overall']
        tfidf = summary['TF-IDF baseline']['overall']
        dept = summary['Department baseline']['overall']
        chosen_para = summary[selection['method']]['subsets']['phrasing'].get('paraphrase', {})
        tfidf_para = summary['TF-IDF baseline']['subsets']['phrasing'].get('paraphrase', {})
        dept_hits = [v['hit_at_3'] for v in summary[selection['method']]['subsets']['department'].values()
                     if v.get('mentees')]

        checks = {
            'AC1 Hit@3': chosen['hit_at_3'] >= ACCEPTANCE['AC1_hit_rate_at_3'],
            'AC2 P@3 (capped)': chosen['precision_at_3_capped'] >= ACCEPTANCE['AC2_precision_at_3'],
            'AC3 beats both baselines': chosen['hit_at_3'] > max(tfidf['hit_at_3'], dept['hit_at_3']),
            'AC4 beats TF-IDF on paraphrases': (chosen_para.get('hit_at_3', 0) > tfidf_para.get('hit_at_3', 0)
                                                if chosen_para.get('mentees') else None),
            'AC6 department gap': (chosen['hit_at_3'] - min(dept_hits) <= ACCEPTANCE['AC6_max_department_gap']
                                   if dept_hits else None),
        }
        key = method_key(selection['method'])
        if latency and key:
            median_20 = latency[MODELS[key]]['20']['median_s']
            checks['AC5 latency (20 mentors)'] = median_20 <= ACCEPTANCE['AC5_median_latency_seconds']
        meta['acceptance_targets'] = ACCEPTANCE
        meta['acceptance_source'] = ACCEPTANCE_SOURCE
        meta['acceptance_checks'] = checks

        print(f'\nAcceptance checks for the selected method ({selection["method"]}):')
        for name, ok in checks.items():
            print(f'  {name:<34} {"PASS" if ok else ("n/a" if ok is None else "FAIL")}')
        if not latency:
            print('  AC5 latency                        not measured (add --latency)')

        # Keep a history of every test run, so a rerun can never hide the first result
        history = {'runs': []}
        if os.path.exists(TEST_LOCK):
            with open(TEST_LOCK, encoding='utf-8') as f:
                history = json.load(f)
        history['runs'].append({'run_id': run_id, 'untouched': meta['test_set_untouched']})
        with open(TEST_LOCK, 'w', encoding='utf-8') as f:
            json.dump(history, f, indent=2)

    per_mentee_path = os.path.join(RESULTS, f'{args.split}_run_{run_id}_per_mentee.csv')
    with open(per_mentee_path, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=list(csv_rows[0].keys()))
        w.writeheader()
        w.writerows(csv_rows)

    pairs_path = os.path.join(RESULTS, f'{args.split}_run_{run_id}_pairs.csv')
    with open(pairs_path, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=list(pair_rows[0].keys()))
        w.writeheader()
        w.writerows(pair_rows)

    summary_path = os.path.join(RESULTS, f'{args.split}_run_{run_id}_summary.json')
    with open(summary_path, 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=2)

    print(f'\nSaved:\n  {per_mentee_path}\n  {pairs_path}\n  {summary_path}')


if __name__ == '__main__':
    main()
