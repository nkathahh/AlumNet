---
title: AlumNet Matching
colorFrom: blue
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

The AlumNet matching service. It turns profiles into embeddings with the
pre-trained `BAAI/bge-small-en-v1.5` sentence-transformer (the revision set in
the `MODEL_REVISION` secret, reported by `/health`) and ranks mentors,
opportunities and events by cosine similarity. It is not trained or fine-tuned.

Only the AlumNet server can call it: every request except `/health` needs the
shared `ML_API_KEY`. Updated from the `main` branch of the AlumNet GitHub
repository by `.github/workflows/deploy.yml`, after the tests pass.

Model card and licence: https://huggingface.co/BAAI/bge-small-en-v1.5
