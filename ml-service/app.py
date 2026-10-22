from flask import Flask, request, jsonify
import hmac
import os
import tempfile
from dotenv import load_dotenv
import mysql.connector
from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity

load_dotenv()

app = Flask(__name__)

# Loaded once at startup, not per request, this is what keeps recommendation
# calls under NFR-01's 3-second target instead of reloading the model each time.
MODEL = SentenceTransformer('BAAI/bge-small-en-v1.5')


def _ssl_options():
    """Hosted MySQL (for example Aiven) needs an encrypted connection.
    DB_SSL_CA holds the provider's CA certificate text, so the server is verified."""
    ca = os.getenv("DB_SSL_CA")
    if not ca:
        return {}
    path = os.path.join(tempfile.gettempdir(), "alumnet-db-ca.pem")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(ca.replace("\\n", "\n"))
    return {"ssl_ca": path, "ssl_verify_cert": True}


def get_connection():
    return mysql.connector.connect(
        host=os.getenv("DB_HOST"),
        port=int(os.getenv("DB_PORT", 3306)),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
        database=os.getenv("DB_NAME"),
        **_ssl_options()
    )


# When ML_API_KEY is set, only callers with the same key (the AlumNet backend)
# can ask for recommendations. This matters once the service is on the internet.
API_KEY = os.getenv("ML_API_KEY")


@app.before_request
def check_api_key():
    if not API_KEY or request.path == "/health":
        return None
    supplied = request.headers.get("X-API-Key", "")
    if not hmac.compare_digest(supplied, API_KEY):
        return jsonify(error="Unauthorized"), 401
    return None


def field(row, key):
    return (row.get(key) or '').strip()


def profile_text(row):
    """Whole-profile text used for the overall score (the deployed ranking)."""
    parts = [field(row, 'skills'), field(row, 'experience'), field(row, 'career_interests')]
    return '. '.join(p for p in parts if p)


def background_text(row):
    """What a mentor has actually done: skills plus experience, without their own interests."""
    parts = [field(row, 'skills'), field(row, 'experience')]
    return '. '.join(p for p in parts if p)


def pct(a, b):
    return round(float(cosine_similarity([a], [b])[0][0]) * 100, 1)


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
    # Mentors with an empty profile can't be meaningfully compared, so leave them out
    mentors = [m for m in cur.fetchall() if profile_text(m)]
    cur.close(); conn.close()

    if not mentors:
        return jsonify([])

    mentee_text = profile_text(mentee)
    me_skills = field(mentee, 'skills')
    me_exp = field(mentee, 'experience')
    me_goals = field(mentee, 'career_interests')

    # Gather every text that needs encoding and encode them in one batch:
    # 4 for the mentee, then 4 per mentor (whole profile, skills, experience, background)
    texts = [mentee_text, me_skills, me_exp, me_goals]
    for m in mentors:
        texts += [profile_text(m), field(m, 'skills'), field(m, 'experience'), background_text(m)]
    vectors = MODEL.encode(texts, normalize_embeddings=True)

    v_whole, v_skills, v_exp, v_goals = vectors[0], vectors[1], vectors[2], vectors[3]

    results = []
    for i, m in enumerate(mentors):
        base = 4 + 4 * i
        m_whole, m_skills, m_exp, m_background = vectors[base:base + 4]

        # Field-level explanation. "goals" deliberately compares the mentee's
        # career interests against what the mentor has DONE (skills + experience),
        # not against the mentor's own interests. A field is None when either
        # side left it empty, so the UI can say there isn't enough information.
        breakdown = {
            "skills": pct(v_skills, m_skills) if me_skills and field(m, 'skills') else None,
            "experience": pct(v_exp, m_exp) if me_exp and field(m, 'experience') else None,
            "goals": pct(v_goals, m_background) if me_goals and background_text(m) else None,
        }

        results.append({
            "mentor_id": m["user_id"],
            "name": m["name"],
            "department": m["department"],
            "years_of_experience": m["years_of_experience"],
            "score": pct(v_whole, m_whole),
            "breakdown": breakdown,
            "matched_attributes": matched_attributes(mentee_text, m)
        })

    results.sort(key=lambda r: r["score"], reverse=True)
    return jsonify(results[:10])


if __name__ == "__main__":
    app.run(port=int(os.getenv("PORT", 5000)), debug=os.getenv("FLASK_DEBUG") == "1")