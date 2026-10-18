"""
Offline evaluation of AlumNet's mentor matching on a held-out set of demo profiles.

Compares three approaches on the same profiles:
  1. TF-IDF baseline           - classical keyword matching (literature review baseline)
  2. BGE whole profile         - the approach deployed in app.py
  3. BGE field-weighted        - candidate improvement: per-field similarity, weighted

No model is trained, and both TF-IDF and BGE are deterministic, so there are no
random seeds to record. Each run is saved with a timestamp, the git commit and
library versions so it can be reproduced.

Run from the ml-service folder (with the venv active):
    python evaluate.py
"""
import csv
import json
import os
import platform
import subprocess
from datetime import datetime

import numpy as np
import sklearn
import sentence_transformers
from scipy.stats import spearmanr
from sentence_transformers import SentenceTransformer
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

MODEL_NAME = 'BAAI/bge-small-en-v1.5'
FIELD_WEIGHTS = {'skills': 0.35, 'experience': 0.25, 'goals': 0.40}
TFIDF_SETTINGS = {'stop_words': 'english', 'ngram_range': (1, 2)}

# Held-out evaluation profiles (synthetic, matching the demo profile guide)
MENTORS = [
    {
        'name': 'Brian Otieno',
        'skills': 'Crew scheduling, route planning, operational safety audits, dispatch coordination, regulatory compliance reporting.',
        'experience': 'Former Head of Flight Operations with 15 years experience across intercontinental routes, led the crew scheduling team.',
        'career_interests': 'Mentoring flight operations staff moving into scheduling and safety leadership roles.'
    },
    {
        'name': 'Catherine Akinyi',
        'skills': 'Route planning, flight dispatch, operational reporting, team coordination.',
        'experience': 'Flight operations supervisor, 9 years at Kenya Airways, oversaw dispatch coordination for regional routes.',
        'career_interests': 'Advising on flight operations career progression and dispatch systems.'
    },
    {
        'name': 'Milka Njeri',
        'skills': 'Crew rostering, administrative coordination, scheduling software.',
        'experience': 'Crew rostering coordinator at Kenya Airways for 5 years.',
        'career_interests': 'Open to mentoring on rostering and administrative operations.'
    },
    {
        'name': 'Ruth Njoroge',
        'skills': 'Aircraft maintenance inspection, technical compliance documentation, engineering quality control.',
        'experience': 'Aircraft maintenance engineer at Kenya Airways for 11 years, specializing in technical inspections.',
        'career_interests': 'Mentoring engineers entering aircraft maintenance and technical compliance roles.'
    },
]

TEST_CASES = [
    {
        # Full expected ordering, defined in the demo profile guide before any scores were computed
        'mentee': {
            'name': 'Joyce Wafula',
            'skills': 'Flight dispatch coordination, route planning software, crew scheduling systems, operational safety reporting.',
            'experience': 'Flight operations officer at Kenya Airways for 3 years, supporting route planning and dispatch for intercontinental flights.',
            'career_interests': 'Moving into a senior flight operations or crew scheduling leadership role, learning more about operational safety audits.'
        },
        'expected_order': ['Brian Otieno', 'Catherine Akinyi', 'Milka Njeri', 'Ruth Njoroge']
    },
    {
        # Control case: an engineering mentee, where only the top match is clear-cut
        'mentee': {
            'name': 'Daniel Mwangi',
            'skills': 'Aircraft systems troubleshooting, maintenance logbook records, inspection checklists.',
            'experience': 'Junior maintenance technician at Kenya Airways for 2 years, assisting on line maintenance checks.',
            'career_interests': 'Becoming a licensed aircraft maintenance engineer and learning technical compliance and quality control.'
        },
        'expected_top': 'Ruth Njoroge'
    },
        {
        # Paraphrase case: same domain as Brian, but avoids his exact keywords
        # (no "crew scheduling", "route planning" or "dispatch"), to test whether
        # each method matches on meaning rather than shared words
        'mentee': {
            'name': 'Peter Kamau',
            'skills': 'Building duty rosters for pilots and cabin staff, preparing flight plans, tracking rest-time rules.',
            'experience': 'Two years in the operations control centre at Kenya Airways, handling same-day changes to flight timetables.',
            'career_interests': 'Leading the team that assigns aircrew to flights, and taking part in reviews of operational safety.'
        },
        'expected_top': 'Brian Otieno'
    },
]


def whole(p):
    return '. '.join(x for x in [p['skills'], p['experience'], p['career_interests']] if x)


def background(p):
    return '. '.join(x for x in [p['skills'], p['experience']] if x)


def tfidf_scores(mentee, mentors):
    docs = [whole(mentee)] + [whole(m) for m in mentors]
    matrix = TfidfVectorizer(**TFIDF_SETTINGS).fit_transform(docs)
    return cosine_similarity(matrix[0], matrix[1:])[0]


def bge_whole_scores(model, mentee, mentors):
    v = model.encode([whole(mentee)] + [whole(m) for m in mentors], normalize_embeddings=True)
    return cosine_similarity(v[:1], v[1:])[0]


def bge_field_scores(model, mentee, mentors):
    me = model.encode([mentee['skills'], mentee['experience'], mentee['career_interests']], normalize_embeddings=True)
    scores = []
    for m in mentors:
        mt = model.encode([m['skills'], m['experience'], background(m)], normalize_embeddings=True)
        s = (FIELD_WEIGHTS['skills'] * cosine_similarity(me[0:1], mt[0:1])[0][0]
             + FIELD_WEIGHTS['experience'] * cosine_similarity(me[1:2], mt[1:2])[0][0]
             + FIELD_WEIGHTS['goals'] * cosine_similarity(me[2:3], mt[2:3])[0][0])
        scores.append(s)
    return np.array(scores)


def git_commit():
    try:
        return subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'],
                                       stderr=subprocess.DEVNULL).decode().strip()
    except Exception:
        return 'unknown'


def main():
    print(f'Loading {MODEL_NAME}...')
    model = SentenceTransformer(MODEL_NAME)

    methods = {
        'TF-IDF baseline': lambda me, ms: tfidf_scores(me, ms),
        'BGE whole profile (deployed)': lambda me, ms: bge_whole_scores(model, me, ms),
        'BGE field-weighted': lambda me, ms: bge_field_scores(model, me, ms),
    }

    run_id = datetime.now().strftime('%Y%m%d_%H%M%S')
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'evaluation', 'results')
    os.makedirs(out_dir, exist_ok=True)

    score_rows, summary = [], []

    for case in TEST_CASES:
        mentee = case['mentee']
        print(f"\n=== Mentee: {mentee['name']} ===")

        for method, fn in methods.items():
            scores = fn(mentee, MENTORS)
            order = np.argsort(-scores)
            ranked = [MENTORS[i]['name'] for i in order]
            actual_rank = {name: r + 1 for r, name in enumerate(ranked)}

            expected = case.get('expected_order')
            for m, s in zip(MENTORS, scores):
                score_rows.append({
                    'run_id': run_id,
                    'mentee': mentee['name'],
                    'method': method,
                    'mentor': m['name'],
                    'expected_rank': expected.index(m['name']) + 1 if expected else '',
                    'actual_rank': actual_rank[m['name']],
                    'score': round(float(s) * 100, 1),
                })

            result = {
                'mentee': mentee['name'],
                'method': method,
                'top_match': ranked[0],
                'score_spread': round(float(scores.max() - scores.min()) * 100, 1),
            }
            if expected:
                rho = spearmanr(
                    [expected.index(m['name']) + 1 for m in MENTORS],
                    [actual_rank[m['name']] for m in MENTORS]
                ).correlation
                result['top1_correct'] = ranked[0] == expected[0]
                result['order_exact'] = ranked == expected
                result['spearman_rho'] = round(float(rho), 3)
            else:
                result['top1_correct'] = ranked[0] == case['expected_top']
            summary.append(result)

            print(f'\n  {method}')
            for name in ranked:
                s = scores[[m['name'] for m in MENTORS].index(name)]
                print(f'    {actual_rank[name]}. {name:<18} {s * 100:5.1f}')
            extra = f", order exact: {result['order_exact']}, Spearman rho: {result['spearman_rho']}" if expected else ''
            print(f"    Top match correct: {result['top1_correct']}{extra}, score spread: {result['score_spread']}")

    csv_path = os.path.join(out_dir, f'run_{run_id}_scores.csv')
    with open(csv_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=list(score_rows[0].keys()))
        writer.writeheader()
        writer.writerows(score_rows)

    meta_path = os.path.join(out_dir, f'run_{run_id}_summary.json')
    with open(meta_path, 'w', encoding='utf-8') as f:
        json.dump({
            'run_id': run_id,
            'git_commit': git_commit(),
            'model': MODEL_NAME,
            'python': platform.python_version(),
            'sentence_transformers': sentence_transformers.__version__,
            'scikit_learn': sklearn.__version__,
            'field_weights': FIELD_WEIGHTS,
            'tfidf_settings': {k: list(v) if isinstance(v, tuple) else v for k, v in TFIDF_SETTINGS.items()},
            'summary': summary,
        }, f, indent=2)

    print(f'\nSaved:\n  {csv_path}\n  {meta_path}')


if __name__ == '__main__':
    main()