"""SCRAM-SHA-256 verifier for a PostgreSQL role password (RFC 5802 / 7677, PostgreSQL's stored format).

Reads the password from standard input and prints only the verifier, so that

    ALTER ROLE english_coach_app PASSWORD 'SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>'

stores the password without the clear text ever reaching the database server, its statement log or this host's
process list. Used by the least-privilege role switch (docs/performance/capacity-2026-10/DATABASE-LEAST-PRIVILEGE.md).
Use an ASCII password (the switch generates a random base64url one), which needs no SASLprep normalisation.

    python3 ec-scram-verifier.py < password-file
"""
import base64
import hashlib
import hmac
import os
import sys

ITERATIONS = 4096  # PostgreSQL's scram_iterations default


def verifier(password: str) -> str:
    if not password or not password.isascii():
        raise SystemExit("password must be non-empty ASCII")
    salt = os.urandom(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS, 32)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    b64 = lambda raw: base64.b64encode(raw).decode()
    return f"SCRAM-SHA-256${ITERATIONS}:{b64(salt)}${b64(stored_key)}:{b64(server_key)}"


if __name__ == "__main__":
    print(verifier(sys.stdin.read().strip()))
