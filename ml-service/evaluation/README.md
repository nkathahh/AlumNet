# AlumNet matching evaluation

Evaluates the mentor recommendation engine against two baselines, using a
development set to choose the method and a held-out test set for the final result.

## Contents

| Path | Purpose |
|---|---|
| `data/mentors.json` | Pool of 20 synthetic mentors across 5 departments |
| `data/mentees_dev.json` | 5 development mentees, used to choose the method |
| `data/mentees_test.json` | 10 held-out test mentees, run once |
| `labels.py` | Creates blind labelling sheets for judges and combines their labels |
| `evaluate.py` | Runs the comparison and writes results |
| `benchmark_latency.py` | Times the live `/recommend` endpoint (NFR-01) |
| `plots.py` | Turns a saved run into Chapter 5 figures, tables and captions |
| `results/` | Timestamped results, including the earlier pilot runs |
| `figures/` | Output of `plots.py`, one folder per run |

All profiles are synthetic. They were drafted with AI assistance and do not
describe real Kenya Airways staff.

Mentees are tagged with `phrasing` (`standard`, or `paraphrase` when they describe
their work without the mentors' usual keywords) and `career_switch` (wanting to move
into a different kind of role), so results can be broken down by those groups.

## Steps

Run everything from the `ml-service` folder with the virtual environment active.

1. **Create the labelling sheets:** `python evaluation/labels.py make`
   This writes `labels/judge_A.csv` and `labels/judge_B.csv`. Each judge rates all
   300 mentee-mentor pairs: 2 = relevant, 1 = partly relevant, 0 = not relevant.
   The sheets show IDs and profile text only, with no names and no model scores.
2. **Combine the labels:** `python evaluation/labels.py combine`
   This reports agreement (Cohen's kappa) and writes `labels/final_labels.csv`. Any
   disagreements go to `labels/judge_C.csv` for a third judge; fill that in and run
   `combine` again.
3. **Development run:** `python evaluation/evaluate.py --split dev --latency`
   Add `--include-base` to also try `bge-base-en-v1.5`. This suggests a method and
   saves it to `selected_method.json`. Review that choice before going further.
4. **Set the acceptance targets** in the `ACCEPTANCE` block at the top of
   `evaluate.py` to the values agreed with the supervisor.
5. **Test run, once:** `python evaluation/evaluate.py --split test --latency`
   This reports the baselines, the deployed method and the selected method, and
   checks the acceptance criteria. The script refuses to run the test split a
   second time unless `--rerun-test` is passed, and records every test run in
   `results/TEST_RUN_DONE.json`.
6. **Live response time:** with `app.py` running,
   `python evaluation/benchmark_latency.py --mentee-id <user_id>`
7. **Figures and tables:** `python evaluation/plots.py --split test` (or `--split dev`).
   This writes four figures, three tables and suggested captions to
   `figures/<split>_<run_id>/`, read straight from the saved results. Fill in the
   "Your explanation" column of `table_error_analysis.csv` yourself.

## Metrics

A mentor counts as relevant when the final label is 2. Mentees with no relevant
mentor are excluded from the metrics, and the number excluded is reported.

- **Hit@3:** share of mentees with at least one relevant mentor in the top 3.
- **P@3:** share of the top 3 that are relevant.
- **P@3 capped:** the same, divided by the most relevant mentors that could have
  appeared (when a mentee has fewer than 3 relevant mentors, plain P@3 cannot reach 1).
- **MRR:** mean of 1 / (rank of the first relevant mentor).
- **Hit@3 lenient:** Hit@3 counting "partly relevant" as relevant.
