"""ExtractedTest -> canonical ExamContentPackage JSON (Java record shape, schema 1.0).

No parallel schema: every key below is a component of the Java records in
backend/src/main/java/com/englishcoach/exams/content/ExamContentPackage.java and
backend/src/main/java/com/englishcoach/exams/model/ExamContentRecords.java (Jackson rejects unknown properties).

Rights are recorded TRUTHFULLY and in TWO separate places (Phase 3.6H):
  * the PUBLISHER licence record (sources / licenses): third-party publisher material whose licence is not
    established -> provenanceCategory UNKNOWN, legalStatus PENDING, no rights granted. Never upgraded to LICENSED:
    LICENSED means a verified third-party licence, which the repository does not evidence.
  * the PROJECT usage authorization (manifest.metadata.projectUsageAuthorization): the EnglishCoach owner authorised
    use of the repository's own source corpus for this project (2026-10-03). It is not a publisher licence and
    implies no publisher endorsement; it clears the rights blocker for LOCAL staging / import preparation only
    (Java ExamProjectUsageAuthorization). The production importer is unchanged and still refuses these packages.
Display name vs provenance (Phase 3.6I): manifest.metadata.sourceIdentity is the immutable source identity;
manifest.metadata.displayName holds the learner-facing title policy (the owner may rename later; provenance never
changes).
"""
from __future__ import annotations

import re
import uuid
import json
from typing import Optional

from .canonical_json import package_content_hash, sha256_obj
from .corpus import MANIFEST_REF, raw_rel
from .diagnostics import EXTRACTOR_NAME, EXTRACTOR_VERSION, page_span
from .media import AssetStore, audio_validation_state
from .model import (LABEL_ASSIGNMENT, SPEAKING_RESPONSE, WRITING_RESPONSE, ExtractedTest, Item, Part,
                    QuestionGroup, Section)

NS = uuid.UUID("6f0c7b1e-3a52-5d0e-9c1f-ec0e3a7f2026")   # extractor namespace (stable ids across runs)
SPEC_BASELINE = "EC-EXAM-SPEC-2026-09-10"
VALID_FROM = "2026-10-03T00:00:00Z"

NORM_TEXT = {"version": "EC-NORM-V1", "caseInsensitive": True, "trimOuterWhitespace": True,
             "collapseInternalWhitespace": True, "punctuationInsensitive": False}
NORM_CHOICE = {"version": "EC-NORM-V1", "caseInsensitive": True, "trimOuterWhitespace": True,
               "collapseInternalWhitespace": True, "punctuationInsensitive": True}
DURATIONS = {"IELTS": {"LISTENING": 1800, "READING": 3600, "WRITING": 3600, "SPEAKING": 840},
             "TOEIC": {"LISTENING": 2700, "READING": 4500}}
CONSTRUCT = {"LISTENING": "listening_comprehension", "READING": "reading_comprehension",
             "WRITING": "written_production", "SPEAKING": "spoken_production"}


def uid(*parts) -> str:
    return str(uuid.uuid5(NS, "/".join(str(p) for p in parts)))


def form_key(t: ExtractedTest) -> str:
    key = f"RAW_{t.book}_T{t.test_number}".upper().replace("-", "_")
    key = re.sub(r"[^A-Z0-9_]", "_", key)
    return key[:48]


def _ec_rights() -> tuple:
    src = {"id": uid("source", "EC_INTERNAL_ORIGINAL"), "code": "EC_INTERNAL_ORIGINAL",
           "name": "English Coach original content", "owner": "English Coach", "publisher": "English Coach",
           "sourceType": "INTERNAL_ORIGINAL",
           "referenceMeta": {"declaration": "Rubrics and scoring metadata authored by English Coach; no external text"},
           "retiredAt": None, "createdAt": None}
    lic = {"id": uid("license", "EC_INTERNAL_ORIGINAL"), "sourceId": src["id"],
           "licenseCode": "EC-ORIGINAL-DRAFT-PENDING-LEGAL", "provenanceCategory": "ORIGINAL",
           "commercialRights": True, "redistributionRights": True, "derivativeRights": True,
           "permittedPurposes": {"EXAM": True, "SIMULATION": True, "PRACTICE": True, "CONTENT": True},
           "permittedTerritories": {"GLOBAL": True}, "validFrom": VALID_FROM, "validUntil": None,
           "attribution": "English Coach original draft; legal review pending", "evidenceAssetId": None,
           "legalStatus": "PENDING", "createdAt": None}
    prov = {"id": uid("provenance", "EC_INTERNAL_ORIGINAL"), "sourceId": src["id"], "licenseId": lic["id"],
            "creator": "English Coach", "acquisitionMethod": "ORIGINAL_AUTHORING",
            "originalReference": "EC-RUBRIC-AND-SCORING-METADATA", "derivativeParentId": None,
            "aiGenerationMeta": None, "createdAt": None}
    return src, lic, prov


OWNER_DECISION_DATE = "2026-10-03"


def project_usage_authorization() -> dict:
    """The owner's PROJECT-level authorization (not a publisher licence, no endorsement)."""
    from .corpus import REPO_ROOT
    decision = REPO_ROOT / "backend/src/main/resources/exams/corpus-production-authorization.json"
    if decision.is_file():
        grant = json.loads(decision.read_text(encoding="utf-8"))
        return {key: grant[key] for key in ("status", "scope", "authorizedBy", "decisionDate", "decisionRef",
                "appliesTo", "permits", "productionImport", "publisherLicence", "publisherEndorsement")}
    return {"status": "OWNER_AUTHORIZED", "scope": "ENGLISHCOACH_PROJECT_USE", "authorizedBy": "PROJECT_OWNER",
            "decisionDate": OWNER_DECISION_DATE, "decisionRef": "EXAMS_RECOVERY_PHASE_3_6_OWNER_SOURCE_USAGE",
            "appliesTo": "REPOSITORY_SOURCE_CORPUS",
            "permits": ["EXTRACTION", "CANONICAL_PACKAGE_PREPARATION", "STAGING_VALIDATION",
                        "LOCAL_STAGING_IMPORT_PREPARATION"],
            "productionImport": "NOT_AUTHORIZED_IN_THIS_PHASE",
            "publisherLicence": "NOT_ESTABLISHED", "publisherEndorsement": False}


def _publisher_rights(t: ExtractedTest, publisher: str) -> tuple:
    code = f"RAW_{t.collection}_{t.book}".upper().replace("-", "_")[:64]
    primary = t.documents[0] if t.documents else None
    src = {"id": uid("source", code), "code": code, "name": t.book_title[:255], "owner": publisher[:255],
           "publisher": publisher[:255], "sourceType": "THIRD_PARTY_PUBLICATION",
           "referenceMeta": {"rawCorpusRoot": "imports/source-files/", "rawManifestRef": MANIFEST_REF,
                             "rightsStatus": "PUBLISHER_LICENCE_NOT_ESTABLISHED",
                             "projectUsageAuthorization": "OWNER_AUTHORIZED",
                             "primaryDocument": primary.path if primary else None},
           "retiredAt": None, "createdAt": None}
    # publisher licence: unchanged truth (never LICENSED / APPROVED without a verified third-party licence)
    lic = {"id": uid("license", code), "sourceId": src["id"], "licenseCode": f"UNKNOWN-{code}"[:64],
           "provenanceCategory": "UNKNOWN", "commercialRights": False, "redistributionRights": False,
           "derivativeRights": False, "permittedPurposes": {"LOCAL_PRIVATE_REVIEW": True},
           "permittedTerritories": {}, "validFrom": None, "validUntil": None,
           "attribution": (f"{t.book_title} — {publisher}. Publisher licence not established; used under the "
                           f"EnglishCoach project owner's authorization ({OWNER_DECISION_DATE}), which is not a "
                           f"publisher licence or endorsement.")[:500],
           "evidenceAssetId": None, "legalStatus": "PENDING", "createdAt": None}
    prov = {"id": uid("provenance", code, t.test_number), "sourceId": src["id"], "licenseId": lic["id"],
            "creator": EXTRACTOR_NAME, "acquisitionMethod": "RAW_CORPUS_EXTRACTION",
            "originalReference": f"{t.book_title} / Test {t.test_number}"[:255], "derivativeParentId": None,
            "aiGenerationMeta": None, "createdAt": None}
    return src, lic, prov


def _rubric(family: str, skill: str, prov_id: str) -> dict:
    if skill == "WRITING":
        criteria = ({"taskAchievement": {"weight": 1}, "coherenceAndCohesion": {"weight": 1},
                     "lexicalResource": {"weight": 1}, "grammaticalRangeAndAccuracy": {"weight": 1}}
                    if family == "IELTS" else {"taskCompletion": {"weight": 1}, "language": {"weight": 1}})
    else:
        criteria = {"fluencyAndCoherence": {"weight": 1}, "lexicalResource": {"weight": 1},
                    "grammaticalRangeAndAccuracy": {"weight": 1}, "pronunciation": {"weight": 1}}
    scale = ({"min": 0, "max": 9, "steps": [x / 2 for x in range(0, 19)]} if family == "IELTS"
             else {"min": 0, "max": 200})
    code = f"EC_RAW_{family}_{skill}_RUBRIC"
    body = {"criteria": criteria, "ordinalScale": scale}
    return {"id": uid("rubric", code), "logicalCode": code, "version": 1, "family": family, "skill": skill,
            "taskFamily": f"{family}_{skill}", "criteria": criteria, "ordinalScale": scale, "provenanceId": prov_id,
            "contentHash": sha256_obj(body), "approvedAt": None, "createdAt": None}


def _metrics(family: str, scope: str, skills: list) -> list:
    if family == "TOEIC":
        return [s for s in ("LISTENING", "READING") if s in skills] + (["LR_TOTAL"] if {"LISTENING", "READING"} <= set(skills) else [])
    return ["LISTENING", "READING", "WRITING", "SPEAKING", "FULL_OVERALL"] if scope == "FULL" else skills


class PackageBuilder:
    def __init__(self, store: AssetStore):
        self.store = store

    def build(self, t: ExtractedTest, publisher: str, scope: str = "FULL", extraction_summary: Optional[dict] = None,
              corroborated_audio: bool = False) -> dict:
        fk = form_key(t)
        ec_src, ec_lic, ec_prov = _ec_rights()
        pub_src, pub_lic, pub_prov = _publisher_rights(t, publisher)
        prov_id = pub_prov["id"]
        family = t.family
        skills = [s.skill for s in t.sections]
        spec_code = f"EC_RAW_{family}_{t.variant}_{scope}_SPEC"[:64]
        # Different printed TOEIC formats are distinct immutable specifications.
        # Keep the current-format identity stable; older formats must not reuse
        # its logical code/version with a different id and blueprint.
        if t.format_version and t.format_version != "TOEIC_LR_2016":
            spec_code = f"EC_RAW_{family}_{t.variant}_{scope}_{t.format_version}_SPEC"[:64]
        blueprint = {"source": "RAW_CORPUS_EXTRACTION", "family": family, "variant": t.variant, "scope": scope}
        if t.format_version:
            blueprint["formatVersion"] = t.format_version
        spec = {"id": uid("spec", spec_code, t.format_version or "-"), "logicalCode": spec_code, "version": 1,
                "family": family, "variant": t.variant, "deliveryMode": "COMPUTER_SIMULATION", "blueprint": blueprint,
                "timingPolicy": {k.lower() + "Seconds": v for k, v in DURATIONS.get(family, {}).items()},
                "navigationPolicy": {"sectionNavigation": "fixed_sequence"},
                "playbackPolicy": {"mode": "ONCE"} if scope in ("FULL", "LISTENING") else {"mode": "NONE"},
                "sourceReferences": {"baseline": SPEC_BASELINE}, "contentHash": sha256_obj(blueprint),
                "approvedAt": None, "createdAt": None}
        scheme_code = f"EC_RAW_{family}_{t.variant}_{scope}_SCORING"[:64]
        mapping = {"metrics": _metrics(family, scope, ["LISTENING", "READING", "WRITING", "SPEAKING"] if family == "IELTS" else ["LISTENING", "READING"]),
                   "status": "DRAFT_NOT_CALIBRATED",
                   "scoreLabel": "English Coach estimated band" if family == "IELTS" else "English Coach estimated scaled score"}
        aggregation = {"officialEquating": False, "version": "EC-AGGREGATION-DRAFT-V1",
                       "creditUnitsPerItem": 1}
        if family == "IELTS":
            aggregation.update({"task1Weight": 1, "task2Weight": 2, "overall": "mean_of_four_quarter_rounding"})
        scheme = {"id": uid("scheme", scheme_code), "logicalCode": scheme_code, "version": 1, "family": family,
                  "variant": t.variant, "scope": scope, "normalizationVersion": "EC-NORM-V1", "rubricReferences": {},
                  "calibrationId": None, "mappingTable": mapping, "aggregationRules": aggregation,
                  "contentHash": sha256_obj({"m": mapping, "a": aggregation}), "approvedAt": None, "createdAt": None}
        node = {"id": uid("catalog", t.collection, t.book), "family": family, "variant": t.variant,
                "sourceId": pub_src["id"], "parentId": None, "kind": "VOLUME", "title": t.book_title[:255],
                "year": None, "ordinal": 0, "retiredAt": None, "createdAt": None}
        form_id = uid("form", fk)
        rubrics = {}
        pkg = {"sections": [], "parts": [], "groups": [], "formGroups": [], "stimuli": [], "groupStimuli": [],
               "items": [], "answerSpecs": [], "assets": [], "stimulusAssets": []}
        asset_ids = {}

        def asset_for_audio(b) -> str:
            if b.sha256 in asset_ids:
                return asset_ids[b.sha256]
            key = self.store.register_audio(b)
            aid = uid("asset", b.sha256)
            pkg["assets"].append({"id": aid, "provenanceId": prov_id, "objectKey": key, "versionId": "1",
                                  "sha256Hash": b.sha256, "mimeType": b.mime, "byteSize": b.byte_size,
                                  "durationMs": b.duration_ms, "dimensions": None,
                                  "validationState": audio_validation_state(b, corroborated_audio), "createdAt": None})
            asset_ids[b.sha256] = aid
            return aid

        def asset_for_figure(f) -> str:
            if f.sha256 in asset_ids:
                return asset_ids[f.sha256]
            aid = uid("asset", f.sha256)
            pkg["assets"].append({"id": aid, "provenanceId": prov_id, "objectKey": f"extracted/images/{f.sha256}.png",
                                  "versionId": "1", "sha256Hash": f.sha256, "mimeType": "image/png",
                                  "byteSize": f.byte_size, "durationMs": None, "dimensions": f.dimensions,
                                  # page-region rendering is heuristic: a human must confirm the crop
                                  "validationState": "PENDING", "createdAt": None})
            asset_ids[f.sha256] = aid
            return aid

        def add_stimulus(key: str, kind: str, title: Optional[str], payload: dict) -> str:
            sid = uid("stimulus", fk, key)
            lkey = f"{fk}_{key}"[:64]
            pkg["stimuli"].append({"id": sid, "logicalStimulusKey": lkey, "version": 1, "kind": kind,
                                   "title": (title or None) and title[:255], "bodyPayload": payload,
                                   "provenanceId": prov_id, "contentHash": sha256_obj(payload), "createdAt": None})
            return sid

        def link(group_id: str, stim_id: str, role: str, ordinal: int):
            pkg["groupStimuli"].append({"id": uid("groupStimulus", group_id, stim_id, role), "groupId": group_id,
                                        "stimulusId": stim_id, "role": role, "ordinal": ordinal})

        for s_ord, sec in enumerate(t.sections, 1):
            sid = uid("section", fk, sec.skill)
            pkg["sections"].append({"id": sid, "formId": form_id, "skill": sec.skill, "ordinal": s_ord,
                                    "specSectionKey": sec.skill, "scoringSchemeId": scheme["id"],
                                    "durationSeconds": sec.duration_seconds or DURATIONS[family][sec.skill],
                                    "timingPolicy": {"source": "BLUEPRINT_DEFAULT"}, "isRunnable": True,
                                    "healthStatus": None})
            if sec.skill in ("LISTENING", "READING"):
                self._objective(pkg, t, fk, sec, sid, prov_id, add_stimulus, link, asset_for_audio, asset_for_figure)
            elif sec.skill == "WRITING":
                rub = rubrics.setdefault("WRITING", _rubric(family, "WRITING", ec_prov["id"]))
                self._writing(pkg, t, fk, sec, sid, prov_id, rub["id"], add_stimulus, link, asset_for_figure)
            elif sec.skill == "SPEAKING":
                rub = rubrics.setdefault("SPEAKING", _rubric(family, "SPEAKING", ec_prov["id"]))
                self._speaking(pkg, t, fk, sec, sid, prov_id, rub["id"], add_stimulus, link)

        content_fp = sha256_obj({k: pkg[k] for k in ("sections", "parts", "groups", "items", "answerSpecs", "stimuli")})
        form = {"id": form_id, "logicalKey": fk, "version": 1,
                "title": f"{t.book_title} — Test {t.test_number} (source extraction, draft)"[:255],
                "family": family, "variant": t.variant, "scope": scope, "catalogNodeId": node["id"],
                "specificationId": spec["id"], "scoringSchemeId": scheme["id"], "lifecycleState": "DRAFT",
                "provenanceId": prov_id, "authorId": None, "contentHash": content_fp, "publishedAt": None,
                "retiredAt": None, "createdAt": None, "primaryHealthStatus": None}
        primary = t.documents[0] if t.documents else None
        q_pages = sorted({p for s in t.sections for p in s.pages})
        audio_refs = []
        for b in t.audio:
            sec_label = f"PART_{b.section or b.part}" if (b.section or b.part) else b.scope
            # a derived segment is referenced through its RAW parent recording (path + hash); offsets below
            raw_sha = b.derived["parentSha256"] if b.derived else b.sha256
            audio_refs.append({"path": b.path.split("::")[0] if b.derived else b.path, "sha256": raw_sha,
                               "section": sec_label, "confidence": b.confidence})
        provenance = {"collection": t.collection, "book": t.book, "test": f"TEST_{t.test_number}",
                      "rawSourceFile": {"path": primary.path if primary else "imports/source-files/", "sha256": primary.sha256 if primary else None},
                      "pageRange": page_span(q_pages), "audio": audio_refs,
                      "rawManifestRef": f"{MANIFEST_REF}#{t.test_id}", "extractorName": EXTRACTOR_NAME,
                      "extractorVersion": EXTRACTOR_VERSION, "reviewStatus": "UNREVIEWED"}
        metadata = {"sourceProvenance": provenance,
                    "sourceDocuments": [{"path": d.path, "sha256": d.sha256, "role": d.role, "textLayer": d.text_layer}
                                        for d in t.documents],
                    "extraction": extraction_summary or {},
                    "reviewOnlyReferences": {
                        "transcripts": t.transcript_refs,
                        "answerKeys": t.answer_key_refs,
                        "note": "References only. Transcript text is not embedded: the learner manifest projection "
                                "has no stimulus/asset role allow-list yet (EXAM-AUD-032)."},
                    "audioSegments": [dict(b.derived, part=b.part, segmentSha256=b.sha256) for b in t.audio if b.derived],
                    "ocr": {"metrics": t.ocr_metrics,
                            "pages": {k: sorted(v) for k, v in t.ocr_pages.items()}} if t.ocr_metrics or t.ocr_pages else {},
                    "rightsReviewStatus": "PUBLISHER_LICENCE_NOT_ESTABLISHED_PROJECT_USE_OWNER_AUTHORIZED",
                    "projectUsageAuthorization": project_usage_authorization(),
                    # immutable source identity (Phase 3.6I) -- never rewritten by a display rename
                    "sourceIdentity": {"publisher": publisher[:255], "collection": t.collection, "book": t.book,
                                       "bookTitle": t.book_title[:255], "test": t.test_number,
                                       "rawSourceSha256": primary.sha256 if primary else None},
                    # learner-facing name policy: the owner may assign a title later; provenance does not change
                    "displayName": {"current": form["title"], "ownerSelected": None, "status": "PROVISIONAL_SOURCE_TITLE",
                                    "policy": "DISPLAY_NAME_MAY_CHANGE_SOURCE_PROVENANCE_MUST_NOT",
                                    "renameTargets": ["form.title", "catalogNodes[].title"]},
                    "audioQAStatus": "AUTOMATED_TECHNICAL_QA_ONLY_HUMAN_QA_REQUIRED",
                    "visualQAStatus": "PAGE_REGION_RENDERING_HUMAN_QA_REQUIRED",
                    "humanReviewComplete": False}
        package = {
            "manifest": {"schemaVersion": "1.0", "packageId": f"RAW-{fk}", "packageVersion": 1, "contentHash": None,
                         "creator": EXTRACTOR_NAME, "specificationBaselineId": SPEC_BASELINE,
                         "authoringStatus": "DRAFT", "createdAt": None, "metadata": metadata},
            "sources": [pub_src, ec_src], "licenses": [pub_lic, ec_lic], "provenances": [pub_prov, ec_prov],
            "catalogNodes": [node], "specifications": [spec], "rubrics": list(rubrics.values()), "calibrations": [],
            "scoringSchemes": [scheme], "form": form, "formComponents": [],
            **pkg,
        }
        # Current-fingerprint authorized decisions plus technical validity; owner
        # technical authorization never claims per-crop human review.
        from .media_qa import apply_crop_decisions
        root = getattr(self.store, "root", None)          # no staging area => no decision ledger => nothing applied
        validated = apply_crop_decisions(package, t.test_id, root) if root is not None else 0
        if validated:
            all_valid = all(a.get("validationState") == "VALIDATED" for a in package["assets"]
                            if str(a.get("mimeType", "")).startswith("image/"))
            if metadata.get("technicalMediaApprovals"):
                metadata["visualQAStatus"] = ("OWNER_APPROVED_TECHNICAL_MEDIA" if all_valid
                                               else "PARTIAL_OWNER_TECHNICAL_MEDIA")
            else:
                metadata["visualQAStatus"] = "HUMAN_APPROVED_CROPS" if all_valid else "PARTIALLY_HUMAN_APPROVED"
        package["manifest"]["contentHash"] = package_content_hash(package)
        return package

    # ── objective sections ────────────────────────────────────────────────────────────────

    def _objective(self, pkg, t, fk, sec: Section, section_id, prov_id, add_stimulus, link, asset_for_audio,
                   asset_for_figure):
        prefix = "L" if sec.skill == "LISTENING" else "R"
        for p_ord, part in enumerate(sec.parts, 1):
            part_id = uid("part", fk, part.code)
            pkg["parts"].append({"id": part_id, "sectionId": section_id, "partCode": part.code, "ordinal": p_ord,
                                 "instructions": part.instructions, "timingPolicy": {"partNumber": part.number}})
            part_stims = []
            if part.audio:
                payload = {"playback": "ONCE", "sourceRole": "PART_RECORDING",
                           "questionRange": f"{part.items[0].number}-{part.items[-1].number}" if part.items else None,
                           "transcriptAvailable": bool(t.transcript_refs), "transcriptEmbedded": False,
                           "mappingConfidence": part.audio[0].confidence}
                st = add_stimulus(f"{part.code}_AUDIO", "AUDIO", f"{part.code.replace('_', ' ').title()} recording", payload)
                for k, b in enumerate(part.audio, 1):
                    aid = asset_for_audio(b)
                    pkg["stimulusAssets"].append({"id": uid("stimulusAsset", st, aid, k), "stimulusId": st,
                                                  "assetId": aid, "role": "AUDIO_PROMPT", "ordinal": k})
                part_stims.append((st, "AUDIO_PROMPT"))
            if part.passage is not None:
                ps = part.passage
                payload = {"title": ps.title, "text": ps.text(), "paragraphs": ps.paragraphs, "notes": ps.notes,
                           "sourcePages": page_span(ps.pages)}
                if ps.documents:
                    payload["documents"] = ps.documents
                kind = "MULTI_DOC" if len(ps.documents) >= 2 else "TEXT"
                st = add_stimulus(f"{part.code}_PASSAGE", kind, ps.title or part.code, payload)
                part_stims.append((st, "PASSAGE"))
            for g_ord, g in enumerate(part.groups, 1):
                gid = uid("group", fk, part.code, g.first)
                gkey = f"{fk}_{part.code}_Q{g.first}"[:64]
                gbody = {"kind": g.kind, "first": g.first, "last": g.last, "items": [i.prompt for i in g.items]}
                pkg["groups"].append({"id": gid, "logicalGroupKey": gkey, "version": 1, "questionType": g.kind,
                                      "construct": CONSTRUCT[sec.skill], "skill": sec.skill, "topic": None,
                                      "difficultyEstimate": None, "provenanceId": prov_id,
                                      "contentHash": sha256_obj(gbody), "createdAt": None})
                pkg["formGroups"].append({"id": uid("formGroup", part_id, gid), "partId": part_id, "groupId": gid,
                                          "ordinal": g_ord, "displayNumbering": f"{g.first}-{g.last}" if g.last != g.first else str(g.first)})
                for k, (st, role) in enumerate(part_stims, 1):
                    link(gid, st, role, k)
                gp = getattr(g, "passage", None)
                if gp is not None:
                    # TOEIC Part 6/7 set passage (one set = one group = its own documents)
                    payload = {"title": gp.title, "text": gp.text(), "paragraphs": gp.paragraphs,
                               "sourcePages": page_span(gp.pages)}
                    if gp.documents:
                        payload["documents"] = gp.documents
                        payload["documentBoundaries"] = gp.document_boundaries
                    kind = "MULTI_DOC" if len(gp.documents) >= 2 else "TEXT"
                    sst = add_stimulus(f"{part.code}_Q{g.first}_PASSAGE", kind, None, payload)
                    link(gid, sst, "PASSAGE", len(part_stims) + 1)
                    for di, figure in enumerate(gp.figures, 1):
                        aid = asset_for_figure(figure)
                        pkg["stimulusAssets"].append({"id": uid("stimulusAsset", sst, aid), "stimulusId": sst,
                                                      "assetId": aid, "role": "VISIBLE_MEDIA", "ordinal": di})
                if g.figure is not None:
                    kind = "MAP" if re.search(r"\b(map|plan)\b", " ".join(g.instructions), re.I) else "IMAGE"
                    vst = add_stimulus(f"{part.code}_Q{g.first}_VISUAL", kind, None,
                                       {"visualRole": "QUESTION_GROUP_VISUAL", "sourcePage": g.figure.page,
                                        "rendering": g.figure.method, "altText": f"Visual for questions {g.first}-{g.last}"})
                    aid = asset_for_figure(g.figure)
                    pkg["stimulusAssets"].append({"id": uid("stimulusAsset", vst, aid), "stimulusId": vst,
                                                  "assetId": aid, "role": "VISIBLE_MEDIA", "ordinal": 1})
                    link(gid, vst, "PRIMARY_VISUAL", 90)
                for it in g.items:
                    self._item(pkg, fk, prefix, gid, g, it, prov_id)

    def _item(self, pkg, fk, prefix, gid, g: QuestionGroup, it: Item, prov_id):
        iid = uid("item", fk, prefix, it.number)
        group_ctx = {"kind": g.kind, "questions": f"{g.first}-{g.last}", "instructions": g.instructions}
        if g.word_limit_text:
            group_ctx["wordLimitRule"] = g.word_limit_text
        if g.stem:
            group_ctx["stem"] = g.stem
        if g.layout_linearized:
            group_ctx["layout"] = "LINEARIZED_TABLE"
        opt = {"options": [o.to_dict() for o in it.options], "questionNumber": it.number, "group": group_ctx}
        if it.selection:
            opt["selection"] = it.selection
        if getattr(it, "visual", None):
            opt["visual"] = it.visual
        prompt = it.prompt
        pkg["items"].append({"id": iid, "groupId": gid, "logicalItemKey": f"{fk}_{prefix}{it.number:03d}"[:64],
                             "version": 1, "prompt": prompt, "interactionType": it.interaction,
                             "optionDefinitions": opt, "construct": g.kind.lower()[:128], "provenanceId": prov_id,
                             "contentHash": sha256_obj({"p": prompt, "o": opt}), "createdAt": None,
                             "ordinal": it.number})
        if it.key is None:
            return  # never an empty key: the validator reports ANSWER_KEY_MISSING
        accepted = {"values": list(it.key.values), "keySource": {"page": it.key.page, "confidence": it.key.confidence}}
        if getattr(it.key, "method", None):
            accepted["keySource"]["method"] = it.key.method
        if it.key.either_order:
            accepted["unorderedSet"] = {"questions": it.key.either_order, "values": list(it.key.values),
                                        "creditPerQuestion": 1}
        if getattr(it.key, "rejected", None):
            accepted["rejectedAnswers"] = list(it.key.rejected)     # printed '(do not accept ...)' (Phase 4.1C)
        text_kind = it.interaction in ("TEXT_GAP", "SHORT_ANSWER")
        policy = NORM_TEXT if text_kind else NORM_CHOICE
        if "CAPITALS_REQUIRED" in (getattr(it.key, "flags", None) or []):
            # printed '(must have capitals)': the scorer compares case-sensitively for THIS item only
            accepted["keySource"]["notes"] = ["CAPITALS_REQUIRED"]
            policy = {**policy, "caseInsensitive": False, "caseSensitive": True}
        pkg["answerSpecs"].append({"id": uid("answer", iid), "itemId": iid, "acceptedAnswers": accepted,
                                   "normalizationPolicy": policy, "cardinality": 1,
                                   "wordLimit": it.word_limit if text_kind else None, "creditUnits": 1.0,
                                   "explanation": None, "rubricId": None, "createdAt": None})

    # ── productive sections ───────────────────────────────────────────────────────────────

    def _writing(self, pkg, t, fk, sec, section_id, prov_id, rubric_id, add_stimulus, link, asset_for_figure):
        for p_ord, task in enumerate(sec.writing_tasks, 1):
            code = f"WRITING_TASK_{task.number}"
            part_id = uid("part", fk, code)
            pkg["parts"].append({"id": part_id, "sectionId": section_id, "partCode": code, "ordinal": p_ord,
                                 "instructions": None, "timingPolicy": {"recommendedMinutes": task.recommended_minutes}})
            gid = uid("group", fk, code)
            pkg["groups"].append({"id": gid, "logicalGroupKey": f"{fk}_{code}"[:64], "version": 1,
                                  "questionType": code, "construct": CONSTRUCT["WRITING"], "skill": "WRITING",
                                  "topic": None, "difficultyEstimate": None, "provenanceId": prov_id,
                                  "contentHash": sha256_obj({"p": task.prompt}), "createdAt": None})
            pkg["formGroups"].append({"id": uid("formGroup", part_id, gid), "partId": part_id, "groupId": gid,
                                      "ordinal": 1, "displayNumbering": f"Task {task.number}"})
            if task.figure is not None:
                st = add_stimulus(f"{code}_VISUAL", task.visual_kind or "CHART", None,
                                  {"visualRole": "WRITING_TASK_1_GRAPHIC", "sourcePage": task.figure.page,
                                   "rendering": task.figure.method, "altText": f"Task {task.number} visual"})
                aid = asset_for_figure(task.figure)
                pkg["stimulusAssets"].append({"id": uid("stimulusAsset", st, aid), "stimulusId": st, "assetId": aid,
                                              "role": "VISIBLE_MEDIA", "ordinal": 1})
                link(gid, st, "PRIMARY_VISUAL", 1)
            st = add_stimulus(f"{code}_PROMPT", "TEXT", None, {"promptContext": task.prompt})
            link(gid, st, "PRIMARY_PROMPT", 2)
            iid = uid("item", fk, "W", task.number)
            opt = {"responseMode": "free_text", "minimumWords": task.minimum_words,
                   "recommendedMinutes": task.recommended_minutes}
            pkg["items"].append({"id": iid, "groupId": gid, "logicalItemKey": f"{fk}_W{task.number}"[:64], "version": 1,
                                 "prompt": task.prompt, "interactionType": WRITING_RESPONSE, "optionDefinitions": opt,
                                 "construct": "writing_task", "provenanceId": prov_id,
                                 "contentHash": sha256_obj({"p": task.prompt, "o": opt}), "createdAt": None,
                                 "ordinal": task.number})
            pkg["answerSpecs"].append({"id": uid("answer", iid), "itemId": iid,
                                       "acceptedAnswers": {"policy": "productive_response", "minimumWords": task.minimum_words},
                                       "normalizationPolicy": {"version": "EC-WRITING-TEXT-V1", "preserveParagraphs": True},
                                       "cardinality": 1, "wordLimit": None, "creditUnits": 1.0,
                                       "explanation": "Productive task: evaluate with the pinned rubric only.",
                                       "rubricId": rubric_id, "createdAt": None})

    def _speaking(self, pkg, t, fk, sec, section_id, prov_id, rubric_id, add_stimulus, link):
        for p_ord, sp in enumerate(sec.speaking_parts, 1):
            code = f"SPEAKING_PART_{sp.number}"
            part_id = uid("part", fk, code)
            pkg["parts"].append({"id": part_id, "sectionId": section_id, "partCode": code, "ordinal": p_ord,
                                 "instructions": None, "timingPolicy": {}})
            gid = uid("group", fk, code)
            pkg["groups"].append({"id": gid, "logicalGroupKey": f"{fk}_{code}"[:64], "version": 1, "questionType": code,
                                  "construct": CONSTRUCT["SPEAKING"], "skill": "SPEAKING", "topic": None,
                                  "difficultyEstimate": None, "provenanceId": prov_id,
                                  "contentHash": sha256_obj({"p": sp.prompts}), "createdAt": None})
            pkg["formGroups"].append({"id": uid("formGroup", part_id, gid), "partId": part_id, "groupId": gid,
                                      "ordinal": 1, "displayNumbering": f"Part {sp.number}"})
            st = add_stimulus(f"{code}_PROMPTS", "TEXT", None,
                              {"prompts": sp.prompts, "sourceRole": "SOURCE_SPEAKING_PROMPTS",
                               "runtimeUse": "PINNED_SOURCE_ITEMS"})
            link(gid, st, "PRIMARY", 1)
            for turn, prompt in enumerate(sp.turn_prompts, 1):
                iid = uid("item", fk, "S", sp.number, turn)
                opt = {"responseMode": "learner_audio", "simulation": True, "speakingPromptBasis": "PINNED_CORPUS_SOURCE"}
                pkg["items"].append({"id": iid, "groupId": gid, "logicalItemKey": f"{fk}_S{sp.number}_T{turn}"[:64], "version": 1,
                                 "prompt": prompt, "interactionType": SPEAKING_RESPONSE, "optionDefinitions": opt,
                                 "construct": "speaking_task", "provenanceId": prov_id,
                                 "contentHash": sha256_obj({"p": prompt, "o": opt}), "createdAt": None,
                                 "ordinal": turn})
                pkg["answerSpecs"].append({"id": uid("answer", iid), "itemId": iid,
                                       "acceptedAnswers": {"policy": "productive_response", "evidenceRequired": ["learner_recording"]},
                                       "normalizationPolicy": {"version": "EC-SPEECH-TEXT-V1", "preserveAudio": True},
                                       "cardinality": 1, "wordLimit": None, "creditUnits": 1.0,
                                       "explanation": "Productive task: evaluate with the pinned rubric only.",
                                       "rubricId": rubric_id, "createdAt": None})
