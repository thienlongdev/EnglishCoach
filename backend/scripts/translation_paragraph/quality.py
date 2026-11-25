"""Text Quality, Integrity, and Machine-Translation Filtering.

Detects and filters:
- Residual HTML / script tags / wiki markup
- Mojibake, broken Unicode, control characters
- Unedited raw MT output matching engine text
- Navigation / footer / license / copyright boilerplate
- URL-dominated or reference-only fragments
- Wrong language or severe truncation
"""

import re
from typing import Tuple, List, Optional
from .contracts import QualityDecision, PassageCandidate


# Common boilerplate / noise patterns
BOILERPLATE_PATTERNS = [
    r'external links',
    r'các liên kết bên ngoài',
    r'tham khảo',
    r'references',
    r'see also',
    r'xem thêm',
    r'all rights reserved',
    r'bản quyền thuộc về',
    r'cookie policy',
    r'chính sách quyền riêng tư',
    r'privacy policy',
    r'retrieved from',
    r'lấy từ nguồn',
    r'category:',
    r'thể loại:'
]

# Vietnamese diacritics set
VI_DIACRITICS = set("àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ"
                    "ÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ")


class QualityFilter:
    """Enforces strict fail-closed text quality and MT artifact gates."""

    @staticmethod
    def evaluate_quality(
        candidate: PassageCandidate,
        alignment_score: float,
        mt_text_clean: Optional[str] = None
    ) -> QualityDecision:
        en = candidate.en_text.strip()
        vi = candidate.vi_text.strip()
        rejections = []

        # 1. Non-empty check
        if not en or not vi:
            return QualityDecision(
                is_accepted=False,
                text_quality_score=0.0,
                mt_artifact_risk=1.0,
                alignment_score=alignment_score,
                rejection_reasons=["EMPTY_TEXT: One or both passages are blank"]
            )

        # 2. Length limits (passage workload)
        words_en = en.split()
        words_vi = vi.split()

        if len(words_en) < 15:
            rejections.append(f"TOO_SHORT: EN text has only {len(words_en)} words (min 15)")
        if len(words_en) > 300:
            rejections.append(f"TOO_LONG: EN text has {len(words_en)} words (max 300 for single paragraph)")

        # 3. Residual HTML/script or wiki code
        if re.search(r'<[a-zA-Z\/][^>]*>', en) or re.search(r'<[a-zA-Z\/][^>]*>', vi):
            rejections.append("HTML_LEAKAGE: Unparsed HTML tags detected in text")
        if "{{" in en or "}}" in en or "{{" in vi or "}}" in vi:
            rejections.append("WIKI_TEMPLATE_LEAK: Unparsed wiki template braces detected")
        if "[[" in en or "]]" in en or "[[" in vi or "]]" in vi:
            rejections.append("WIKI_LINK_LEAK: Unparsed wiki link brackets detected")

        # 4. Unicode / Mojibake detection
        if "\ufffd" in en or "\ufffd" in vi:
            rejections.append("BROKEN_UNICODE: Unicode replacement character (\\ufffd) present")
        # Check control characters (except standard newlines/tabs)
        if any(ord(c) < 32 and c not in "\n\r\t" for c in en + vi):
            rejections.append("CONTROL_CHARS: Non-printable control characters present")

        # 5. Language check: Vietnamese must contain genuine Vietnamese diacritics
        vi_diacritics_count = sum(1 for c in vi if c in VI_DIACRITICS)
        if len(words_vi) > 20 and vi_diacritics_count < 3:
            rejections.append("WRONG_LANGUAGE_VI: Vietnamese text lacks essential Vietnamese diacritics")

        # 6. URL and citation dominance
        url_count_en = len(re.findall(r'https?://[^\s]+', en))
        url_count_vi = len(re.findall(r'https?://[^\s]+', vi))
        if url_count_en > 1 or url_count_vi > 1:
            rejections.append("URL_DOMINATED: Passage contains bare web URLs")

        # 7. Boilerplate / navigation fragments
        for pattern in BOILERPLATE_PATTERNS:
            if re.search(rf'^{pattern}\b', en, re.IGNORECASE) or re.search(rf'^{pattern}\b', vi, re.IGNORECASE):
                rejections.append(f"BOILERPLATE_DETECTED: Matched pattern '{pattern}'")
                break

        # 8. Machine translation (MT) artifact check
        mt_risk = 0.0
        near_mt_flag = False
        if mt_text_clean:
            # If target text is identical to unedited raw MT output
            norm_tgt = " ".join(vi.lower().split())
            norm_mt = " ".join(mt_text_clean.lower().split())
            if norm_tgt == norm_mt and len(words_vi) >= 10:
                mt_risk = 1.0
                rejections.append("UNEDITED_MT_OUTPUT: Target text is 100% identical to raw unreviewed MT output")
            else:
                # Calculate lexical overlap with raw MT
                words_mt = set(norm_mt.split())
                words_tgt = set(norm_tgt.split())
                if words_mt and words_tgt:
                    overlap = len(words_tgt.intersection(words_mt)) / max(len(words_tgt), len(words_mt))
                    mt_risk = min(1.0, overlap)
                    if overlap >= 0.85:
                        near_mt_flag = True

        # 9. List-only / Table artifact check
        # Check if text is just a comma-separated list of items or numbers
        if en.count(",") > len(words_en) * 0.4 and len(words_en) > 10:
            rejections.append("LIST_LIKE_FRAGMENT: High comma-to-word ratio indicates list fragment")

        # Overall text quality score calculation
        quality_score = 1.0 - (len(rejections) * 0.25)
        quality_score = max(0.0, min(1.0, quality_score))

        is_accepted = (len(rejections) == 0 and alignment_score >= 0.55)

        return QualityDecision(
            is_accepted=is_accepted,
            text_quality_score=quality_score,
            mt_artifact_risk=mt_risk,
            alignment_score=alignment_score,
            near_mt_flag=near_mt_flag,
            rejection_reasons=rejections
        )
