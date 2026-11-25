from app.services.pronunciation.lexical_stress import PhoneSpan, word_evidence, apply_lexical_stress


def test_identical_word_responds_to_the_observed_nucleus():
    phones = [PhoneSpan("P", 0, 2), PhoneSpan("EY", 2, 10), PhoneSpan("P", 12, 2), PhoneSpan("ER", 14, 10)]
    first = word_evidence("paper", phones, [7.] * 14 + [-2.] * 10, [0.9] * 14 + [0.2] * 10)
    last = word_evidence("paper", phones, [-2.] * 14 + [7.] * 10, [0.2] * 14 + [0.9] * 10)
    assert first["expectedSyllable"] == last["expectedSyllable"] == 1
    assert first["matched"] and first["observedSyllable"] == 1
    assert not last["matched"] and last["observedSyllable"] == 2
    assert word_evidence("paper", phones, [None] * 24, [0.8] * 24) is None


def test_abstention_removes_unmeasured_fields_from_both_wire_spellings():
    old = {"stressScore": 85, "stress_score": 85, "confidence": 0.92}
    result = apply_lexical_stress({"status": "ABSTAINED", "overall": dict(old), "overall_score": dict(old)},
                                  b"", "silence.wav", "audio/wav")
    assert result["lexicalStress"]["status"] == "INSUFFICIENT_EVIDENCE"
    for key in ("overall", "overall_score"):
        assert result[key]["stressScore"] is None
        assert result[key]["stress_score"] is None
        assert "confidence" not in result[key]
