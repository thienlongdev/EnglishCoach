"""Build the optional history gloss table from the shipped offline EN–VI source."""
import gzip
import re
import sqlite3
from pathlib import Path

resources = Path(__file__).resolve().parents[2] / "backend/src/main/resources"
db = sqlite3.connect((resources / "lexical/dictionary_en_vi.db").as_uri() + "?mode=ro", uri=True)
rows = {}
for word, gloss in db.execute("""
    SELECT w.word,d.definition FROM words w JOIN word_definitions wd ON w.id=wd.word_id
    JOIN definitions d ON wd.definition_id=d.id WHERE length(w.word) BETWEEN 3 AND 8
    ORDER BY w.id,wd.rowid
"""):
    word, gloss = word.lower(), " ".join((gloss or "").split())
    if re.fullmatch("[a-z]{3,8}", word) and 0 < len(gloss) <= 140:
        rows.setdefault(word, gloss)
# The owner's learner-facing senses take precedence over dictionary ordering.
rows.update(brave="Dũng cảm", discover="Khám phá, phát hiện", achieve="Đạt được")
out = resources / "data/king/conquest-vi.tsv.gz"
out.write_bytes(gzip.compress("".join(f"{k}\t{v}\n" for k,v in sorted(rows.items())).encode(), mtime=0))
