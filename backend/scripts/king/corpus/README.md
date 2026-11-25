# King qualified review-preview corpus

Offline, source-backed qualification builds two indexed SQLite shards. Source
confidence never grants human approval. PRODUCTION ACTIVE remains zero. No deploy.

## Reuse verified cache and reproduce

Run stages serially from the authoritative Games worktree:

```powershell
python -X utf8 backend/scripts/king/corpus/sources.py verify
python -X utf8 backend/scripts/king/corpus/reproduce.py
python -X utf8 backend/scripts/king/corpus/verify_normalization_replay.py
python -X utf8 backend/scripts/king/corpus/quality.py
python -X utf8 backend/scripts/king/corpus/review_preview.py
python -X utf8 -m unittest discover -s backend/scripts/king/corpus -p 'test_*.py' -v
```

Reproduce repeats derive → typed raw phrase ingestion → full OANC collocation
mining → qualify → build_runtime. Complete candidate and runtime logical hashes
must match an identical subsequent replay. Existing Conquest boards are preserved.
verify_normalization_replay uses the original normalization/OANC adapters in an
isolated DB and compares eleven canonical tables; it leaves the working DB intact.
Cached raw files are checksum verified, without redundant downloads.

A cold build uses sources.py fetch, normalize.py, mine_oanc.py, derive.py and
build_boards.py --count 150 --attempts 100000 before the qualification stages.
Do not overwrite an existing valuable working index or its preserved boards.

## Sources and licenses

Core: OEWN/Princeton WordNet, OANC, CEFR-J vocabulary/grammar, SCOWL US/GB.
Kaikki English-edition raw Wiktextract 2026-09-28 supplies typed definitions in a
separate CC BY-SA 4.0 shard. Examples, quotations, translations, etymologies and
media are excluded. Unknown/validation-only sources, including existing EN-VI
SQLite, supply no new question truth. Official terms evidence is locked locally.

Raw and working/verification DBs remain in ignored .cache/king-corpus/. No raw
multi-GB data belong in Git. Compact deployable resources live under
backend/src/main/resources/data/king/corpus/: two .sqlite.gz shards, manifest.json,
sources.lock.json, ATTRIBUTION.md and licenses/. Maven packages these together.
Preserve the separate ShareAlike shard, attribution URLs and modification notices.

## Qualification and identities

Reorder preserves source constituent chunks, anchored openings, recognized
relative/subordinate clauses and whole adjunct/time alternatives. Unproven
separability, coordination, scope-sensitive placement or annotation stays in
review. Typed particle chunks cannot be split. Some soft distribution goals
remain short; the hard total and largest-category cap are separate gates.

Reflex relations retain named senses; capitalized proper-name senses are excluded.
POS retains one unique annotated occurrence. Collocations require full-population
frequency >=5, documents >=3, logDice >=5 and lexical cross-confirmation. Typed
phrases retain explicit source entry/type/meaning/license and closed choices.
Grammar uses CEFR-J source rules and exactly one valid offered present-BE answer.
Spelling variants share semantic identity and validated forms protect distractors.

Explain evaluates all learner senses, excludes capitalized and explicit specialist
domain senses, uses same-synset aliases/exact forms and hypernym definition →
marked exact definition excerpt → full definition. Lexical signatures must narrow
learner concepts and add information; all clues pass exact/alias/spelling guards.
Source glosses can still be formal. Human pedagogy review remains pending.
UNKNOWN CEFR stays UNKNOWN; estimated difficulty is never claimed as direct CEFR.
Exact phrase occurrence links do not claim a contextual phrase sense.

## Runtime and next preview task

KingCorpus verifies gzip/logical hashes, source lock, schema/build, shard license
and provider floors. Shared immutable read-only shards and ID indexes have no raw,
working-DB, internet or runtime LLM truth dependency. One 512-entry LRU decoded
cache expires after 15 minutes. Rooms retain IDs and bounded gameplay state.

Server king.content-channel controls PRODUCTION, REVIEW_PREVIEW or ENGINEERING.
Engineering is forbidden in production profiles. Preview uses qualified source
records only, with HUMAN_REVIEW_PENDING. The client reads server capability and
attribution and cannot choose trust. The next explicitly authorized preview task
sets --king.content-channel=REVIEW_PREVIEW or KING_CONTENT_CHANNEL=REVIEW_PREVIEW
and builds the current frontend with the canonical production build wrapper.

KingRecentContent combines both human histories into one seeded fair sequence.
Match semantic uniqueness never relaxes. Family/difficulty buckets rotate;
strong phrase/concept and weak lexeme suppression relax toward older compatible
history. Difficulty never exceeds the chosen maximum. LRU max 4096 users, six-hour
TTL; per-user caps: 192 semantic and 96 each phrase/concept/lexeme IDs. Assigned
match IDs are reserved; histories are private, process-local and not durable.

Review: docs/king-of-english/corpus/review/runtime-review.html. Owner fields blank.
Readiness, exact commands, measurements and scope: continuation/FINAL_REPORT.md
and verification-gate.json. quality.py --release requires data and retained runtime
gates; it never deploys, publishes or activates production content.
