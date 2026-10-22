"""
Tests for the recommendation service.

They run the real Flask app and the real embedding model against a MySQL
test database, seeded here with a small set of synthetic profiles. They
refuse to run unless DB_NAME ends in "_test".

Run from the ml-service folder:  python -m pytest -v
"""
import os
import sys

import pytest

if not os.getenv("DB_NAME", "").endswith("_test"):
    pytest.exit('Refusing to run: DB_NAME must end in "_test" so real data is never touched.', returncode=1)

os.environ["ML_API_KEY"] = "test-key"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as service  # noqa: E402  (loads the model once)

KEY = {"X-API-Key": "test-key"}

# Synthetic profiles: one mentee and three mentors with clearly different fits
PEOPLE = [
    # (user_id, name, department, role, skills, experience, interests)
    (9001, "Test Mentee", "Engineering & Maintenance", "mentee",
     "Aircraft maintenance, engine inspection, troubleshooting hydraulic systems",
     "Two years as a junior aircraft maintenance technician on Embraer jets",
     "Become a licensed aircraft engineer and lead a maintenance team"),
    (9002, "Engineering Mentor", "Engineering & Maintenance", "mentor",
     "Aircraft engine overhaul, maintenance planning, airworthiness and safety inspections",
     "Thirty years as a licensed aircraft maintenance engineer, later head of line maintenance",
     "Coaching young engineers"),
    (9003, "Cabin Mentor", "Cabin Services", "mentor",
     "In-flight customer service, passenger care, catering coordination",
     "Senior cabin crew on long-haul flights for twenty years",
     "Training new cabin crew"),
    (9004, "Empty Mentor", "Cargo", "mentor", None, None, None),
]


@pytest.fixture(scope="module", autouse=True)
def seed_profiles():
    conn = service.get_connection()
    cur = conn.cursor()
    for uid, name, dept, role, skills, exp, goals in PEOPLE:
        cur.execute(
            "INSERT INTO users (user_id, name, email, password_hash, department) VALUES (%s, %s, %s, 'x', %s)",
            (uid, name, f"user{uid}@example.com", dept),
        )
        table = "mentees" if role == "mentee" else "mentors"
        cur.execute(f"INSERT INTO {table} (user_id) VALUES (%s)", (uid,))
        cur.execute(
            "INSERT INTO profiles (user_id, skills, experience, career_interests) VALUES (%s, %s, %s, %s)",
            (uid, skills, exp, goals),
        )
    conn.commit()
    yield
    ids = tuple(p[0] for p in PEOPLE)
    marks = ",".join(["%s"] * len(ids))
    for table in ("profiles", "mentees", "mentors", "users"):
        cur.execute(f"DELETE FROM {table} WHERE user_id IN ({marks})", ids)
    conn.commit()
    cur.close()
    conn.close()


@pytest.fixture()
def client():
    return service.app.test_client()


def test_health_is_public(client):
    assert client.get("/health").status_code == 200


def test_requests_without_the_api_key_are_refused(client):
    assert client.get("/recommend?mentee_id=9001").status_code == 401


def test_a_wrong_api_key_is_refused(client):
    assert client.get("/recommend?mentee_id=9001", headers={"X-API-Key": "wrong"}).status_code == 401


def test_mentee_id_is_required(client):
    assert client.get("/recommend", headers=KEY).status_code == 400


def test_unknown_mentee_returns_404(client):
    assert client.get("/recommend?mentee_id=123456", headers=KEY).status_code == 404


def test_recommendations_are_ranked_and_explained(client):
    res = client.get("/recommend?mentee_id=9001", headers=KEY)
    assert res.status_code == 200
    results = [r for r in res.get_json() if r["mentor_id"] in (9002, 9003, 9004)]
    ids = [r["mentor_id"] for r in results]

    # The mentor whose background matches the mentee's goals ranks above the unrelated one
    assert ids.index(9002) < ids.index(9003)
    # Mentors with empty profiles cannot be compared, so they are left out
    assert 9004 not in ids

    for r in results:
        assert 0 <= r["score"] <= 100
        assert set(r["breakdown"]) == {"skills", "experience", "goals"}

    scores = [r["score"] for r in res.get_json()]
    assert scores == sorted(scores, reverse=True)


def test_mentor_vectors_are_cached_and_refreshed_when_a_profile_changes(client):
    client.get("/recommend?mentee_id=9001", headers=KEY)
    client.get("/recommend?mentee_id=9001", headers=KEY)
    # Nothing changed, so no mentor profile is encoded again
    assert service.app.config["LAST_ENCODED"] == 0

    conn = service.get_connection()
    cur = conn.cursor()
    cur.execute("UPDATE profiles SET skills = 'Cabin safety training, first aid' WHERE user_id = 9003")
    conn.commit()
    cur.close()
    conn.close()
    client.get("/recommend?mentee_id=9001", headers=KEY)
    # Only the edited mentor's texts that changed are encoded again
    assert 1 <= service.app.config["LAST_ENCODED"] <= 4


def test_search_finds_mentors_by_meaning_and_respects_the_filtered_list(client):
    assert client.post("/search", json={}, headers=KEY).status_code == 400
    res = client.post("/search", json={"q": "engine overhaul and airworthiness"}, headers=KEY)
    assert res.status_code == 200
    ranked = [r["mentor_id"] for r in res.get_json() if r["mentor_id"] in (9002, 9003)]
    assert ranked[0] == 9002
    only = client.post("/search", json={"q": "engine overhaul", "ids": [9003]}, headers=KEY).get_json()
    assert [r["mentor_id"] for r in only] == [9003]
