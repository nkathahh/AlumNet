from flask import Flask, request, jsonify
import hashlib
import hmac
import json
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
MODEL_NAME = 'BAAI/bge-small-en-v1.5'
MODEL = SentenceTransformer(MODEL_NAME)

# BGE models find passages better when a search query starts with this instruction
QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '


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


def search_text(row):
    """Everything a mentee might search for: headline, about, skills, experience, department."""
    parts = [field(row, 'headline'), field(row, 'bio'), field(row, 'skills'), field(row, 'experience'), field(row, 'department')]
    return '. '.join(p for p in parts if p)


def encode_cached(conn, items):
    """
    items: list of (user_id, kind, text). Returns a dict {(user_id, kind): vector}.

    A profile is only re-encoded when its text changes. The text is hashed with
    the model name, so switching models also refreshes every vector. If the
    cache table is missing or read-only, it falls back to encoding everything.
    """
    result = {}
    wanted = {}
    for user_id, kind, text in items:
        if not text:
            continue
        digest = hashlib.sha256(f"{MODEL_NAME}|{text}".encode('utf-8')).hexdigest()
        wanted[(user_id, kind)] = (text, digest)

    cached = {}
    try:
        if wanted:
            cur = conn.cursor(dictionary=True)
            ids = sorted({u for u, _ in wanted})
            marks = ','.join(['%s'] * len(ids))
            cur.execute(f"SELECT user_id, kind, text_hash, vector FROM profile_embeddings WHERE user_id IN ({marks})", ids)
            for row in cur.fetchall():
                cached[(row['user_id'], row['kind'])] = (row['text_hash'], row['vector'])
            cur.close()
    except Exception:
        cached = {}

    missing = []
    for key, (text, digest) in wanted.items():
        hit = cached.get(key)
        if hit and hit[0] == digest:
            result[key] = json.loads(hit[1])
        else:
            missing.append((key, text, digest))

    if missing:
        vectors = MODEL.encode([m[1] for m in missing], normalize_embeddings=True)
        rows = []
        for (key, _text, digest), vec in zip(missing, vectors):
            values = [round(float(x), 6) for x in vec]
            result[key] = values
            rows.append((key[0], key[1], digest, json.dumps(values)))
        try:
            cur = conn.cursor()
            cur.executemany(
                """INSERT INTO profile_embeddings (user_id, kind, text_hash, vector) VALUES (%s, %s, %s, %s)
                   ON DUPLICATE KEY UPDATE text_hash = VALUES(text_hash), vector = VALUES(vector)""",
                rows
            )
            conn.commit()
            cur.close()
        except Exception:
            pass
    app.config['LAST_ENCODED'] = len(missing)
    return result


def eligible_mentors(cur, exclude_id=None, ids=None):
    """Active former staff with a profile. ids limits the list to mentors the backend already filtered."""
    sql = """
        SELECT u.user_id, u.name, u.department, mt.years_of_experience,
               (sd.staff_number IS NOT NULL) AS verified,
               p.skills, p.experience, p.career_interests, p.industry, p.headline, p.bio
        FROM mentors mt
        JOIN users u ON u.user_id = mt.user_id
        JOIN profiles p ON p.user_id = mt.user_id
        LEFT JOIN staff_directory sd ON sd.staff_number = u.staff_number
        WHERE u.status = 'active'
          -- Only people HR lists as former staff (or older accounts not linked to HR)
          AND (sd.staff_number IS NULL OR (sd.employment_status = 'former' AND sd.alumni_eligible = 1))
    """
    params = []
    if exclude_id is not None:
        sql += " AND mt.user_id != %s"
        params.append(exclude_id)
    if ids:
        sql += f" AND mt.user_id IN ({','.join(['%s'] * len(ids))})"
        params += list(ids)
    cur.execute(sql, params)
    return cur.fetchall()


@app.get("/health")
def health():
    return jsonify(status="ok")


@app.post("/search")
def search():
    """
    Search mentors by meaning, not just exact words: "help moving into
    management" finds a mentor whose profile says "led a team of 40".
    The JSON body is {"q": "...", "ids": [1, 2, 3]}; ids limits the search to
    mentors the backend has already filtered (department, experience and so
    on). It is a POST so the list can be any length.
    """
    body = request.get_json(silent=True) or {}
    q = str(body.get('q') or '').strip()
    if not q:
        return jsonify(error="q is required"), 400
    if len(q) > 200:
        return jsonify(error="Keep the search under 200 characters"), 400
    ids = [int(x) for x in (body.get('ids') or []) if str(x).isdigit()][:5000]

    conn = get_connection()
    cur = conn.cursor(dictionary=True)
    mentors = [m for m in eligible_mentors(cur, ids=ids or None) if search_text(m)]
    cur.close()
    if not mentors:
        conn.close()
        return jsonify([])

    vectors = encode_cached(conn, [(m['user_id'], 'search', search_text(m)) for m in mentors])
    conn.close()
    query_vec = MODEL.encode([QUERY_PREFIX + q], normalize_embeddings=True)[0]

    results = []
    for m in mentors:
        vec = vectors.get((m['user_id'], 'search'))
        if vec is None:
            continue
        results.append({"mentor_id": m['user_id'], "score": pct(query_vec, vec)})
    results.sort(key=lambda r: r['score'], reverse=True)
    return jsonify(results)


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

    # Mentors with an empty profile can't be meaningfully compared, so leave them out
    mentors = [m for m in eligible_mentors(cur, exclude_id=mentee_id) if profile_text(m)]
    cur.close()

    if not mentors:
        conn.close()
        return jsonify([])

    mentee_text = profile_text(mentee)
    me_skills = field(mentee, 'skills')
    me_exp = field(mentee, 'experience')
    me_goals = field(mentee, 'career_interests')

    # Mentee texts change often and are cheap, so they are encoded fresh.
    # Mentor vectors come from the cache and are only re-encoded when a profile changes.
    v_whole, v_skills, v_exp, v_goals = MODEL.encode([mentee_text or ' ', me_skills or ' ', me_exp or ' ', me_goals or ' '], normalize_embeddings=True)
    items = []
    for m in mentors:
        uid = m['user_id']
        items += [(uid, 'whole', profile_text(m)), (uid, 'skills', field(m, 'skills')),
                  (uid, 'experience', field(m, 'experience')), (uid, 'background', background_text(m))]
    cache = encode_cached(conn, items)
    conn.close()

    results = []
    for m in mentors:
        uid = m['user_id']
        m_whole = cache.get((uid, 'whole'))
        m_skills = cache.get((uid, 'skills'))
        m_exp = cache.get((uid, 'experience'))
        m_background = cache.get((uid, 'background'))

        # Field-level explanation. "goals" deliberately compares the mentee's
        # career interests against what the mentor has DONE (skills + experience),
        # not against the mentor's own interests. A field is None when either
        # side left it empty, so the UI can say there isn't enough information.
        breakdown = {
            "skills": pct(v_skills, m_skills) if me_skills and m_skills is not None else None,
            "experience": pct(v_exp, m_exp) if me_exp and m_exp is not None else None,
            "goals": pct(v_goals, m_background) if me_goals and m_background is not None else None,
        }

        results.append({
            "mentor_id": m["user_id"],
            "name": m["name"],
            "department": m["department"],
            "years_of_experience": m["years_of_experience"],
            "verified": bool(m.get("verified")),
            "score": pct(v_whole, m_whole),
            "breakdown": breakdown,
            "matched_attributes": matched_attributes(mentee_text, m)
        })

    results.sort(key=lambda r: r["score"], reverse=True)
    # The backend removes mentors who are full or not taking mentees, so send a few extra
    return jsonify(results[:25])


if __name__ == "__main__":
    app.run(port=int(os.getenv("PORT", 5000)), debug=os.getenv("FLASK_DEBUG") == "1")