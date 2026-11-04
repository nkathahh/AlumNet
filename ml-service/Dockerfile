# Recommendation service image. The deploy workflow builds it from this file,
# app.py and requirements-deploy.txt, and Azure Container Apps runs it.
FROM python:3.11-slim

# The exact model release that was evaluated (the commit id from the model's
# "Files and versions" page). The workflow passes it in; app.py loads the same one.
ARG MODEL_REVISION=main

# Run as an ordinary user, never as root
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    HF_HOME=/home/user/.cache/huggingface \
    PYTHONUNBUFFERED=1 \
    ML_REQUIRE_KEY=1 \
    MODEL_REVISION=${MODEL_REVISION}
WORKDIR /home/user/app

COPY --chown=user requirements-deploy.txt .
RUN pip install --no-cache-dir --user torch==2.4.1 --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir --user -r requirements-deploy.txt

# Download the pinned model while building, so the service starts quickly
RUN python -c "import os; from sentence_transformers import SentenceTransformer; SentenceTransformer('BAAI/bge-small-en-v1.5', revision=os.environ['MODEL_REVISION'])"

COPY --chown=user app.py .

EXPOSE 7860
CMD ["gunicorn", "--bind", "0.0.0.0:7860", "--workers", "1", "--threads", "4", "--timeout", "120", "app:app"]
