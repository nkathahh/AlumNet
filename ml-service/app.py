from flask import Flask, request, jsonify
import os

app = Flask(__name__)


@app.get("/health")
def health():
    return jsonify(status="ok")


@app.get("/recommend")
def recommend():
    mentee_id = request.args.get("mentee_id")
    if not mentee_id:
        return jsonify(error="mentee_id is required"), 400

    return jsonify(error="Not implemented yet"), 501


if __name__ == "__main__":
    app.run(port=int(os.getenv("PORT", 5000)), debug=True)