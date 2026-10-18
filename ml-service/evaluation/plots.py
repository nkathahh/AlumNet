"""
Figures and tables for Chapter 5, generated from a saved evaluation run.

Run from the ml-service folder after evaluate.py:
    python evaluation/plots.py --split test          (latest test run)
    python evaluation/plots.py --split dev           (latest dev run)
    python evaluation/plots.py --run-id 20261020_101500 --split test

Everything is read from the result files, so the figures always match the
numbers in the report. Output goes to evaluation/figures/<split>_<run_id>/:
    fig_hit_rate_by_method.png    Hit@3 per method
    fig_score_separation.png      scores of relevant vs non-relevant pairs
    fig_hit_by_phrasing.png       standard vs paraphrased mentees
    fig_latency.png               response time vs mentor pool size (if measured)
    table_method_comparison.csv
    table_error_analysis.csv      misses and near misses, with a column for your explanation
    table_dataset_summary.csv
    captions.txt                  suggested captions with the run's conditions
"""
import argparse
import csv
import glob
import json
import os
import sys
from collections import Counter, defaultdict

import matplotlib
matplotlib.use('Agg')  # write files only, no window
import matplotlib.pyplot as plt
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')
RESULTS = os.path.join(HERE, 'results')
FIGURES = os.path.join(HERE, 'figures')

# Colours from a colour-blind-checked palette (validated for these two series)
SERIES_1 = '#2a78d6'   # blue: embedding methods, standard phrasing, bge-small
SERIES_2 = '#eb6834'   # orange: paraphrased mentees, bge-base
BASELINE = '#898781'   # neutral grey for the baselines
INK = '#0b0b0b'
INK_SECONDARY = '#52514e'
GRID = '#e1e0d9'
AXIS = '#c3c2b7'
SURFACE = '#fcfcfb'

plt.rcParams.update({
    'font.family': 'sans-serif',
    'font.size': 10,
    'axes.edgecolor': AXIS,
    'axes.labelcolor': INK_SECONDARY,
    'axes.titlecolor': INK,
    'axes.titlesize': 11,
    'axes.titleweight': 'bold',
    'xtick.color': INK_SECONDARY,
    'ytick.color': INK_SECONDARY,
    'axes.facecolor': SURFACE,
    'figure.facecolor': SURFACE,
    'savefig.facecolor': SURFACE,
    'axes.spines.top': False,
    'axes.spines.right': False,
    'legend.frameon': False,
})


# ---------------------------------------------------------------- loading

def latest_run(split):
    files = sorted(glob.glob(os.path.join(RESULTS, f'{split}_run_*_summary.json')))
    if not files:
        sys.exit(f'No {split} runs found in evaluation/results. Run evaluate.py --split {split} first.')
    return os.path.basename(files[-1])[len(f'{split}_run_'):-len('_summary.json')]


def load_run(split, run_id):
    base = os.path.join(RESULTS, f'{split}_run_{run_id}')
    for suffix in ('_summary.json', '_per_mentee.csv', '_pairs.csv'):
        if not os.path.exists(base + suffix):
            sys.exit(f'Missing {base + suffix}. Re-run evaluate.py so it saves all three result files.')
    with open(base + '_summary.json', encoding='utf-8') as f:
        summary = json.load(f)
    with open(base + '_per_mentee.csv', encoding='utf-8') as f:
        per_mentee = list(csv.DictReader(f))
    with open(base + '_pairs.csv', encoding='utf-8') as f:
        pairs = list(csv.DictReader(f))
    return summary, per_mentee, pairs


def load_profiles():
    def read(name):
        with open(os.path.join(DATA, name), encoding='utf-8') as f:
            return json.load(f)
    mentors = {m['id']: m for m in read('mentors.json')}
    mentees = {m['id']: m for m in read('mentees_dev.json') + read('mentees_test.json')}
    return mentors, mentees


def is_baseline(method):
    return 'baseline' in method.lower()


def short(method):
    return method.replace(' profile', '').replace('BGE-', 'BGE ')


# ---------------------------------------------------------------- figures

def fig_hit_rate(summary, selected, path):
    methods = [m for m, v in summary['results'].items() if v['overall'].get('mentees')]
    values = [summary['results'][m]['overall']['hit_at_3'] for m in methods]
    counts = [summary['results'][m]['overall']['hit_at_3_count'] for m in methods]
    colours = [BASELINE if is_baseline(m) else SERIES_1 for m in methods]

    fig, ax = plt.subplots(figsize=(7, 0.5 * len(methods) + 1.4))
    y = np.arange(len(methods))[::-1]
    ax.barh(y, values, color=colours, height=0.6, edgecolor=SURFACE, linewidth=2)
    for yi, v, c in zip(y, values, counts):
        ax.text(v + 0.01, yi, f'{v:.0%}  ({c})', va='center', color=INK, fontsize=9)
    ax.set_yticks(y)
    ax.set_yticklabels([short(m) + ('  (selected)' if m == selected else '') for m in methods])
    for label, m in zip(ax.get_yticklabels(), methods):
        if m == selected:
            label.set_fontweight('bold')
    ax.set_xlim(0, 1.32)
    ax.set_xticks([0, 0.25, 0.5, 0.75, 1.0])
    ax.set_xticklabels(['0%', '25%', '50%', '75%', '100%'])
    ax.xaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    ax.set_xlabel('Hit@3: mentees with a relevant mentor in the top 3')
    ax.set_title('Hit@3 by method', pad=26)
    ax.legend(handles=[plt.Rectangle((0, 0), 1, 1, color=BASELINE), plt.Rectangle((0, 0), 1, 1, color=SERIES_1)],
              labels=['Baseline', 'BGE embedding'], loc='lower left', bbox_to_anchor=(0, 1.0), ncol=2, fontsize=9)
    fig.tight_layout()
    fig.savefig(path, dpi=200)
    plt.close(fig)


def separation_auc(pairs_for_method):
    """Per mentee: chance a relevant mentor (label 2) outscores a non-relevant one (label 0).
    Averaged over mentees that have both. 0.5 is chance, 1.0 is perfect separation."""
    by_mentee = defaultdict(lambda: {'rel': [], 'non': []})
    for p in pairs_for_method:
        if p['label'] == '2':
            by_mentee[p['mentee_id']]['rel'].append(float(p['score']))
        elif p['label'] == '0':
            by_mentee[p['mentee_id']]['non'].append(float(p['score']))
    aucs = []
    for g in by_mentee.values():
        if g['rel'] and g['non']:
            wins = sum((r > n) + 0.5 * (r == n) for r in g['rel'] for n in g['non'])
            aucs.append(wins / (len(g['rel']) * len(g['non'])))
    return float(np.mean(aucs)) if aucs else None


def fig_score_separation(summary, pairs, path):
    methods = [m for m in summary['results'] if m != 'Department baseline']  # its scores are 0 or 1 by design
    ncols = min(3, len(methods))
    nrows = int(np.ceil(len(methods) / ncols))
    fig, axes = plt.subplots(nrows, ncols, figsize=(3.0 * ncols + 0.6, 3.2 * nrows + 0.6), squeeze=False)
    flat = axes.flatten()
    for ax in flat[len(methods):]:
        ax.set_visible(False)  # empty cells in the last row
    rng = np.random.default_rng(0)
    aucs = {}
    groups = [('2', 'Relevant'), ('1', 'Partly'), ('0', 'Not relevant')]
    for idx, (ax, method) in enumerate(zip(flat, methods)):
        rows = [p for p in pairs if p['method'] == method]
        aucs[method] = separation_auc(rows)
        for x, (label, _) in enumerate(groups):
            vals = np.array([float(p['score']) for p in rows if p['label'] == label])
            if not len(vals):
                continue
            colour = SERIES_1 if label == '2' else (BASELINE if label == '0' else '#86b6ef')
            ax.scatter(x + rng.uniform(-0.18, 0.18, len(vals)), vals, s=14, color=colour, alpha=0.75,
                       edgecolors=SURFACE, linewidths=0.6)
            ax.hlines(np.median(vals), x - 0.3, x + 0.3, color=INK, linewidth=2)
        ax.set_xticks(range(len(groups)))
        ax.set_xticklabels([g[1] for g in groups], fontsize=8)
        ax.yaxis.grid(True, color=GRID, linewidth=0.8)
        ax.set_axisbelow(True)
        auc_text = f'separation {aucs[method]:.2f}' if aucs[method] is not None else 'separation n/a'
        ax.set_title(f'{short(method)}\n{auc_text}', fontsize=9)
        if idx % ncols == 0:
            ax.set_ylabel('Similarity score')
    fig.suptitle('Scores of relevant and non-relevant pairs\n(black line = median; each panel has its own scale)',
                 fontsize=10, color=INK)
    fig.tight_layout()
    fig.savefig(path, dpi=200)
    plt.close(fig)
    return aucs


def fig_hit_by_phrasing(summary, path):
    methods = [m for m in summary['results'] if summary['results'][m]['overall'].get('mentees')]
    fig, ax = plt.subplots(figsize=(1.5 * len(methods) + 1.5, 3.8))
    x = np.arange(len(methods))
    width = 0.36
    for offset, key, colour, hatch, name in ((-width / 2, 'standard', SERIES_1, None, 'Standard wording'),
                                             (width / 2, 'paraphrase', SERIES_2, '//', 'Paraphrased wording')):
        vals, labels = [], []
        for m in methods:
            g = summary['results'][m]['subsets']['phrasing'].get(key, {})
            vals.append(g.get('hit_at_3', 0) if g.get('mentees') else 0)
            labels.append(g.get('hit_at_3_count', 'n/a'))
        # Hatching keeps the two series distinguishable in greyscale print
        bars = ax.bar(x + offset, vals, width, color=colour, hatch=hatch, edgecolor=SURFACE, linewidth=2,
                      label=name)
        for b, lab in zip(bars, labels):
            ax.text(b.get_x() + b.get_width() / 2, b.get_height() + 0.02, lab, ha='center', fontsize=8, color=INK)
    ax.set_xticks(x)
    ax.set_xticklabels([short(m) for m in methods], rotation=20, ha='right', fontsize=8)
    ax.set_ylim(0, 1.1)
    ax.set_yticks([0, 0.25, 0.5, 0.75, 1.0])
    ax.set_yticklabels(['0%', '25%', '50%', '75%', '100%'])
    ax.yaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    ax.set_ylabel('Hit@3')
    ax.set_title('Hit@3 for standard and paraphrased mentee profiles', pad=26)
    ax.legend(loc='lower left', bbox_to_anchor=(0, 1.0), ncol=2, fontsize=8)
    fig.tight_layout()
    fig.savefig(path, dpi=200)
    plt.close(fig)


def fig_latency(summary, path):
    latency = summary.get('latency') or {}
    if not latency:
        return False
    fig, ax = plt.subplots(figsize=(6.4, 3.8))
    ends = []
    for (model, values), colour in zip(latency.items(), (SERIES_1, SERIES_2)):
        sizes = sorted(values, key=int)
        xs = [int(s) for s in sizes]
        ys = [values[s]['median_s'] for s in sizes]
        ax.plot(xs, ys, color=colour, linewidth=2, marker='o', markersize=7,
                markeredgecolor=SURFACE, markeredgewidth=1.5)
        ends.append([xs[-1], ys[-1], model.split('/')[-1], ys[-1]])  # last item: label position
    top = max(3.4, max(e[1] for e in ends) * 1.15)
    ax.set_ylim(0, top)
    # Direct labels at the line ends, nudged apart if they would overlap
    # Only the label position moves; the printed value is always the measured one
    ends.sort(key=lambda e: e[1])
    for i in range(1, len(ends)):
        if ends[i][3] - ends[i - 1][3] < 0.07 * top:
            ends[i][3] = ends[i - 1][3] + 0.07 * top
    for x, value, name, label_y in ends:
        ax.text(x + 6, label_y, f'{name}: {value:.2f} s', va='center', fontsize=8, color=INK)
    ax.axhline(3.0, color=INK_SECONDARY, linewidth=1, linestyle='--')
    ax.text(0.99, 3.0 / top, 'NFR-01 target: 3 s', transform=ax.transAxes, ha='right', va='bottom',
            fontsize=8, color=INK_SECONDARY)
    ax.set_xlim(0, max(e[0] for e in ends) * 1.45)
    ax.set_xlabel('Number of mentors compared per request')
    ax.set_ylabel('Median response time (s)')
    ax.yaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    ax.set_title('Recommendation time as the mentor pool grows')
    fig.tight_layout()
    fig.savefig(path, dpi=200)
    plt.close(fig)
    return True


# ---------------------------------------------------------------- tables

def write_csv(path, rows):
    with open(path, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


def table_methods(summary, aucs, path):
    rows = []
    for m, v in summary['results'].items():
        o = v['overall']
        if not o.get('mentees'):
            continue
        rows.append({
            'Method': m,
            'Mentees': o['mentees'],
            'Hit@3': o['hit_at_3'],
            'Hit@3 (count)': o['hit_at_3_count'],
            'P@3': o['precision_at_3'],
            'P@3 capped': o['precision_at_3_capped'],
            'MRR': o['mrr'],
            'Hit@3 lenient': o['hit_at_3_lenient'],
            'Separation': round(aucs[m], 3) if aucs.get(m) is not None else '',
        })
    write_csv(path, rows)


def table_errors(per_mentee, pairs, method, mentors, mentees, path):
    rows = []
    for r in [r for r in per_mentee if r['method'] == method]:
        if r['n_relevant'] == '0':
            continue
        first = int(r['first_relevant_rank']) if r['first_relevant_rank'] else None
        if r['hit_at_3'] == 'True' and first == 1:
            continue  # correct at the very top, not an error
        outcome = 'Miss: no relevant mentor in top 3' if r['hit_at_3'] != 'True' else 'Near miss: relevant mentor not first'
        mine = [p for p in pairs if p['method'] == method and p['mentee_id'] == r['mentee_id']]
        top3 = sorted(mine, key=lambda p: int(p['rank']))[:3]
        relevant = sorted([p for p in mine if p['label'] == '2'], key=lambda p: int(p['rank']))
        me = mentees[r['mentee_id']]
        rows.append({
            'Mentee': f"{r['mentee_id']} {me['name']}",
            'Department': me['department'],
            'Phrasing': me['phrasing'],
            'Career interests': me['career_interests'],
            'Outcome': outcome,
            'Top 3 (label)': '; '.join(f"{mentors[p['mentor_id']]['name']} ({p['label']})" for p in top3),
            'Relevant mentors (rank)': '; '.join(f"{mentors[p['mentor_id']]['name']} (#{p['rank']})" for p in relevant),
            'Your explanation': '',
        })
    if rows:
        write_csv(path, rows)
    return len(rows)


def table_dataset(path):
    mentors, mentees = load_profiles()
    rows = []
    for dept, n in sorted(Counter(m['department'] for m in mentors.values()).items()):
        rows.append({'Group': 'Mentors by department', 'Category': dept, 'Count': n})
    for split, prefix in (('Development mentees', 'D'), ('Test mentees', 'T')):
        group = [m for k, m in mentees.items() if k.startswith(prefix)]
        rows.append({'Group': split, 'Category': 'Total', 'Count': len(group)})
        for dept, n in sorted(Counter(m['department'] for m in group).items()):
            rows.append({'Group': split, 'Category': dept, 'Count': n})
        rows.append({'Group': split, 'Category': 'Paraphrased wording',
                     'Count': sum(m['phrasing'] == 'paraphrase' for m in group)})
        rows.append({'Group': split, 'Category': 'Career switch',
                     'Count': sum(bool(m['career_switch']) for m in group)})
    labels_path = os.path.join(HERE, 'labels', 'final_labels.csv')
    if os.path.exists(labels_path):
        with open(labels_path, encoding='utf-8') as f:
            labels = list(csv.DictReader(f))
        for split in ('dev', 'test'):
            counts = Counter(r['final_label'] for r in labels if r['split'] == split)
            for value, name in (('2', 'Relevant'), ('1', 'Partly relevant'), ('0', 'Not relevant')):
                rows.append({'Group': f'Labels ({split})', 'Category': name, 'Count': counts.get(value, 0)})
    agreement_path = os.path.join(HERE, 'labels', 'agreement.json')
    if os.path.exists(agreement_path):
        with open(agreement_path, encoding='utf-8') as f:
            a = json.load(f)
        rows.append({'Group': 'Label agreement', 'Category': 'Exact agreement', 'Count': a['exact_agreement']})
        rows.append({'Group': 'Label agreement', 'Category': "Cohen's kappa", 'Count': a['cohen_kappa']})
        rows.append({'Group': 'Label agreement', 'Category': "Cohen's kappa (linear weights)",
                     'Count': a['cohen_kappa_linear']})
    write_csv(path, rows)


# ---------------------------------------------------------------- main

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--split', choices=['dev', 'test'], required=True)
    parser.add_argument('--run-id', help='defaults to the latest run for the split')
    args = parser.parse_args()

    run_id = args.run_id or latest_run(args.split)
    summary, per_mentee, pairs = load_run(args.split, run_id)
    mentors, mentees = load_profiles()
    selected = (summary.get('selection') or {}).get('method')

    out = os.path.join(FIGURES, f'{args.split}_{run_id}')
    os.makedirs(out, exist_ok=True)

    fig_hit_rate(summary, selected, os.path.join(out, 'fig_hit_rate_by_method.png'))
    aucs = fig_score_separation(summary, pairs, os.path.join(out, 'fig_score_separation.png'))
    fig_hit_by_phrasing(summary, os.path.join(out, 'fig_hit_by_phrasing.png'))
    has_latency = fig_latency(summary, os.path.join(out, 'fig_latency.png'))

    table_methods(summary, aucs, os.path.join(out, 'table_method_comparison.csv'))
    error_method = selected or 'BGE-small whole profile'
    n_errors = table_errors(per_mentee, pairs, error_method, mentors, mentees,
                            os.path.join(out, 'table_error_analysis.csv'))
    table_dataset(os.path.join(out, 'table_dataset_summary.csv'))

    conditions = (f"{summary['split']} set, {summary['mentees']} mentees against {summary['mentors']} mentors, "
                  f"run {run_id}, commit {summary['git_commit']}")
    captions = [
        f'Figure 5.X: Hit@3 for each matching method ({conditions}). Bars show the share of mentees with at '
        f'least one relevant mentor in the top three, with counts in brackets.',
        f'Figure 5.X: Similarity scores of relevant, partly relevant and non-relevant mentee-mentor pairs for '
        f'each method ({conditions}). Separation is the probability that a relevant mentor outscores a '
        f'non-relevant one for the same mentee (0.5 is chance, 1.0 is perfect).',
        f'Figure 5.X: Hit@3 for mentees described in standard and paraphrased wording ({conditions}).',
    ]
    if has_latency:
        captions.append('Figure 5.X: Median recommendation time as the number of mentors compared grows, '
                        f'measured on the development laptop, run {run_id}. '
                        'The dashed line marks the NFR-01 target of 3 seconds.')
    captions += [
        f'Table 5.X: Comparison of matching methods ({conditions}).',
        f'Table 5.X: Error analysis for {error_method}: mentees with no relevant mentor in the top three, or '
        f'whose relevant mentor was not ranked first ({conditions}).',
        'Table 5.X: Composition of the evaluation dataset and relevance labels.',
    ]
    with open(os.path.join(out, 'captions.txt'), 'w', encoding='utf-8') as f:
        f.write('\n\n'.join(captions) + '\n')

    print(f'Saved figures and tables to {out}')
    print(f'  Error analysis for {error_method}: {n_errors} mentee(s) to explain'
          + ('' if n_errors else ' (no errors, so no table was written)'))
    if not has_latency:
        print('  No latency figure: run evaluate.py with --latency to include one.')


if __name__ == '__main__':
    main()
