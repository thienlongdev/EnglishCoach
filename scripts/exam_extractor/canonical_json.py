"""Jackson-compatible canonical JSON + content hash for ExamContentPackage.

ExamContentPackageValidator#computeContentHash serialises the parsed package with alphabetically sorted
properties and map keys, no indentation, ISO-8601 instants, and the manifest's contentHash removed, then
SHA-256s the UTF-8 bytes. The same canonical form is produced here so the declared hash matches. Verified against
the original pilot packages (content/exams/original-pilot) and re-checked by the Java staging validation test,
which fails on CONTENT_HASH_MISMATCH.

Parity rules kept by the builder: every record field is present (null when empty), text contains no control
characters except \\n and \\t, floats only as simple decimals (1.0, 0.5), instants as 'YYYY-MM-DDTHH:MM:SSZ'.
"""
from __future__ import annotations

import copy
import datetime
from decimal import Decimal, ROUND_FLOOR
import hashlib
import json
import re


def canonical_bytes(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def package_content_hash(pkg: dict) -> str:
    clone = copy.deepcopy(pkg)
    # Jackson serializes nullable record components even when an older JSON
    # envelope omitted them. Normalize only record fields; metadata maps are
    # opaque and must retain their original values.
    if isinstance(clone.get("form"), dict):
        clone["form"].setdefault("primaryHealthStatus", None)
    for item in clone.get("items", []):
        item.setdefault("ordinal", None)
    records = [clone.get("manifest", {}), clone.get("form", {})]
    for name, value in clone.items():
        if isinstance(value, list):
            records.extend(row for row in value if isinstance(row, dict))
    for row in records:
        for field in ("createdAt", "publishedAt", "retiredAt", "validFrom", "validUntil"):
            if field in row and row[field] is not None:
                row[field] = _instant(row[field])
    clone.get("manifest", {}).pop("contentHash", None)
    return hashlib.sha256(canonical_bytes(clone)).hexdigest()


def _instant(value):
    """Jackson JavaTime Instant: epoch seconds or ISO text -> UTC ISO, 0/3/6/9 fractional digits."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        seconds = Decimal(str(value))
        whole = int(seconds.to_integral_value(rounding=ROUND_FLOOR))
        nanos = int((seconds - whole) * 1_000_000_000)
        stamp = (datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
                 + datetime.timedelta(seconds=whole)).strftime("%Y-%m-%dT%H:%M:%S")
    elif isinstance(value, str):
        match = re.fullmatch(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z", value)
        if match is None:
            return value
        stamp = match.group(1)
        nanos = int((match.group(2) or "").ljust(9, "0") or "0")
    else:
        return value
    if not nanos:
        return stamp + "Z"
    digits = 3 if nanos % 1_000_000 == 0 else 6 if nanos % 1_000 == 0 else 9
    return stamp + "." + f"{nanos:09d}"[:digits] + "Z"


def sha256_obj(obj) -> str:
    return hashlib.sha256(canonical_bytes(obj)).hexdigest()
