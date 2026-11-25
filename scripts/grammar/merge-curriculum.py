#!/usr/bin/env python
# Groups closely related curriculum units into one chapter (owner directive 2026-11-01): the child's knowledge stays searchable and
# is taught inside the parent's file, nothing is dropped. Run once; a merged child disappears as a slug and its links point at the parent.
import json, os, sys
sys.stdout.reconfigure(encoding="utf8")
ROOT = os.path.join(os.path.dirname(__file__), "../../backend/src/main/resources/grammar")
MERGE = {
    "word-conversion": "form-and-function", "interjections-and-response-words": "parts-of-speech",
    "irregular-plurals": "regular-plurals", "partitives": "uncountable-traps", "noun-modifiers": "compound-nouns",
    "few-little": "much-many-a-lot", "possessive-pronouns": "possessive-determiners", "each-other": "reflexive-pronouns",
    "phrasal-verbs-register": "phrasal-verbs-separable",
    "past-perfect-continuous": "past-perfect", "future-continuous": "future-perfect",
    "shall-offers-suggestions": "permission-and-requests", "need-dare": "semi-modals",
    "superlatives": "comparatives", "dependent-prepositions-nouns": "dependent-prepositions-adjectives", "prepositions-plus-ing": "dependent-prepositions-verbs",
    "echo-and-reply-questions": "negative-questions", "double-negatives": "negation-scope",
    "relative-pronoun-omission": "relative-clauses-defining", "clauses-purpose": "clauses-reason-result",
    "even-if-in-case": "unless-provided-as-long-as",
    "passive-two-objects": "passive-tenses-modals", "get-passive": "passive-use",
    "reporting-deictics": "backshift", "split-infinitives": "prescriptive-vs-descriptive",
    "so-such-inversion": "negative-inversion", "wh-clefts": "it-clefts", "substitution": "ellipsis", "dislocation-spoken": "spoken-grammar", "end-weight": "given-before-new",
    "sequencing-framing": "connectors-overview", "stance-and-evaluation": "hedging",
    "hyphens": "compound-nouns", "quotation-marks": "semicolons-colons-dashes",
    "were-subjunctive": "mandative-subjunctive", "comment-clauses": "pragmatic-softening",
    "ielts-task1-comparison": "ielts-task1-trends",
}
path = os.path.join(ROOT, "curriculum.json")
c = json.load(open(path, encoding="utf8"))
topics = {t["slug"]: t for d in c["domains"] for t in d["topics"]}
for child, parent in MERGE.items():
    if not os.path.exists(os.path.join(ROOT, "topics")): break
    assert child in topics and parent in topics, (child, parent)
    for d in c["domains"]:
        if os.path.exists(os.path.join(ROOT, "topics", d["id"], child + ".json")):
            raise SystemExit("already authored: " + child)
for d in c["domains"]:
    kept = []
    for t in d["topics"]:
        parent = MERGE.get(t["slug"])
        if parent:
            topics[parent].setdefault("includes", []).append({"slug": t["slug"], "vi": t["vi"], "en": t["en"]})
        else:
            kept.append(t)
    d["topics"] = kept
for d in c["domains"]:
    for t in d["topics"]:
        if t.get("prerequisites"):
            mapped = []
            for p in t["prerequisites"]:
                q = MERGE.get(p, p)
                if q != t["slug"] and q not in mapped:
                    mapped.append(q)
            t["prerequisites"] = mapped
with open(path, "w", encoding="utf8", newline="\n") as f:
    json.dump(c, f, ensure_ascii=False, indent=1)
print("topics now", sum(len(d["topics"]) for d in c["domains"]))
