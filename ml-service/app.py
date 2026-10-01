from flask import Flask, request, jsonify
import os
from dotenv import load_dotenv
import mysql.connector
from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity

load_dotenv()

app = Flask(__name__)

# Loaded once at startup, not per request, this is what keeps recommendation
# calls under NFR-01's 3-second target instead of reloading the model each time.
MODEL = SentenceTransformer('BAAI/bge-small-en-v1.5')


def get_connection():
    return mysql.connector.connect(
        host=os.getenv("DB_HOST"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
        database=os.getenv("DB_NAME")
    )


def profile_text(row):
    parts = [row.get('skills') or '', row.get('experience') or '', row.get('career_interests') or '']
    return '. '.join(p for p in parts if p).strip()


def matched_attributes(mentee_text, mentor_row):
    """Simple word-overlap signal for explainability (NFR-07). This is NOT
    what drives the ranking, cosine similarity on the embeddings does that,
    this just surfaces a few shared terms to show the mentee why a match
    was suggested."""
    mentee_words = set(mentee_text.lower().split())
    mentor_words = set(profile_text(mentor_row).lower().split())
    matches = [w for w in mentor_words if w in mentee_words and len(w) > 4]
    return matches[:3]


@app.get("/health")
def health():
    return jsonify(status="ok")


@app.get("/recommend")
def recommend():
    mentee_id = request.args.get("mentee_id")
    if not mentee_id:
        return jsonify(error="mentee_id is required"), 400

    conn = get_connection()
    cur = conn.cursor(dictionary=True)

    cur.execute(
        "SELECT skills, experience, career_interests, industry FROM profiles WHERE user_id = %s",
        (mentee_id,)
    )
    mentee = cur.fetchone()
    if not mentee:
        cur.close(); conn.close()
        return jsonify(error="Mentee profile not found"), 404

    cur.execute("""
        SELECT u.user_id, u.name, u.department, mt.years_of_experience,
               p.skills, p.experience, p.career_interests, p.industry
        FROM mentors mt
        JOIN users u ON u.user_id = mt.user_id
        JOIN profiles p ON p.user_id = mt.user_id
        WHERE mt.user_id != %s
    """, (mentee_id,))
    mentors = cur.fetchall()
    cur.close(); conn.close()

    if not mentors:
        return jsonify([])

    mentee_text = profile_text(mentee)
    mentor_texts = [profile_text(m) for m in mentors]

    mentee_embedding = MODEL.encode([mentee_text])
    mentor_embeddings = MODEL.encode(mentor_texts)
    scores = cosine_similarity(mentee_embedding, mentor_embeddings)[0]

    results = [{
        "mentor_id": m["user_id"],
        "name": m["name"],
        "department": m["department"],
        "years_of_experience": m["years_of_experience"],
        "score": round(float(s) * 100, 1),
        "matched_attributes": matched_attributes(mentee_text, m)
    } for m, s in zip(mentors, scores)]

    results.sort(key=lambda r: r["score"], reverse=True)
    return jsonify(results[:10])


if __name__ == "__main__":
    app.run(port=int(os.getenv("PORT", 5000)), debug=True)