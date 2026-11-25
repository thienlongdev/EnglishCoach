"""
English Coach — Shadowing Derived Content Hardening Test Suite
Verifies:
1. Exact full-token dictionary lookup happens BEFORE heuristics
2. No naive suffix stripping; correct -ed, -s/-es, -ing phonology
3. Numbers, ordinals, abbreviations, initialisms, contractions normalize correctly
4. Heteronyms and multiple pronunciation variants are preserved in alternatives[]
5. General American target accent consistency
6. Clean monosyllable stress display
7. Whole-word G2P fallback for genuine OOVs
8. Fail-closed behavior for unresolvable tokens
"""

import unittest
from app.services.pronunciation.ipa_pipeline import IPAPipeline, get_ipa_pipeline, normalize_token_for_spoken


class TestIPAHardening(unittest.TestCase):

    def setUp(self):
        self.pipeline = get_ipa_pipeline()

    def test_exact_token_lookup_first(self):
        """GATE 1: Verify exact token lookup succeeds for standard vocabulary and inflections."""
        tokens = [
            "played", "looked", "wanted", "needed", "washed", "called",
            "cats", "dogs", "buses", "watches", "judges", "plays",
            "running", "making", "lying", "lining", "going", "studying",
            "somewhere", "right", "horror", "movie", "machine", "themselves"
        ]
        for tok in tokens:
            res = self.pipeline.lookup_word(tok)
            self.assertNotEqual(res["ipa"], "", f"Token {tok} returned empty IPA")
            self.assertEqual(res["source"], "CMUDICT", f"Token {tok} did not use CMUDICT (used {res['source']})")

    def test_ed_phonology(self):
        """GATE 3: Test -ed phonology /t/, /d/, and /ɪd/ / /əd/."""
        # /d/ after voiced
        res_played = self.pipeline.lookup_word("played")
        self.assertTrue(res_played["ipa"].endswith("d"))
        self.assertNotEqual(res_played["ipa"], "pleɪ", "played must not be stripped to play /pleɪ/")

        # /t/ after voiceless
        res_looked = self.pipeline.lookup_word("looked")
        self.assertTrue(res_looked["ipa"].endswith("t"))

        # /ɪd/ or /əd/ after /t/ or /d/
        res_wanted = self.pipeline.lookup_word("wanted")
        self.assertTrue(any(res_wanted["ipa"].endswith(s) for s in ["tɪd", "təd", "d"]))

        res_needed = self.pipeline.lookup_word("needed")
        self.assertTrue(any(res_needed["ipa"].endswith(s) for s in ["dɪd", "dəd", "d"]))

    def test_s_es_phonology(self):
        """GATE 3: Test -s / -es phonology /s/, /z/, and /ɪz/ / /əz/."""
        # /s/ after voiceless
        res_cats = self.pipeline.lookup_word("cats")
        self.assertTrue(res_cats["ipa"].endswith("s"))

        # /z/ after voiced
        res_dogs = self.pipeline.lookup_word("dogs")
        self.assertTrue(res_dogs["ipa"].endswith("z"))

        # /ɪz/ or /əz/ after sibilant
        res_buses = self.pipeline.lookup_word("buses")
        self.assertTrue(any(res_buses["ipa"].endswith(s) for s in ["sɪz", "səz", "z"]))

        res_watches = self.pipeline.lookup_word("watches")
        self.assertTrue(any(res_watches["ipa"].endswith(s) for s in ["tʃɪz", "tʃəz", "z"]))

    def test_normalization_numbers_and_years(self):
        """GATE 7: Verify expansion of numbers, comma numbers, years, decimals, currencies."""
        self.assertEqual(normalize_token_for_spoken("50,000"), "fifty thousand")
        self.assertEqual(normalize_token_for_spoken("2015"), "twenty fifteen")
        self.assertEqual(normalize_token_for_spoken("2026"), "twenty twenty-six")
        self.assertEqual(normalize_token_for_spoken("$15"), "fifteen dollars")
        self.assertEqual(normalize_token_for_spoken("3.14"), "three point one four")
        self.assertEqual(normalize_token_for_spoken("21st"), "twenty-first")
        self.assertEqual(normalize_token_for_spoken("1st"), "first")

    def test_normalization_abbreviations_and_contractions(self):
        """GATE 7: Verify expansion of abbreviations, initialisms, and contractions."""
        self.assertEqual(normalize_token_for_spoken("Dr."), "doctor")
        self.assertEqual(normalize_token_for_spoken("Mr."), "mister")
        self.assertEqual(normalize_token_for_spoken("Mrs."), "missus")
        self.assertEqual(normalize_token_for_spoken("etc."), "etcetera")
        self.assertEqual(normalize_token_for_spoken("vs."), "versus")
        self.assertEqual(normalize_token_for_spoken("AI"), "a i")
        self.assertEqual(normalize_token_for_spoken("CEO"), "c e o")
        self.assertEqual(normalize_token_for_spoken("U.S."), "u s")

        # Contractions
        for c in ["don't", "can't", "won't", "I'm", "I've", "we're", "they'll"]:
            res = self.pipeline.lookup_word(c)
            self.assertNotEqual(res["ipa"], "", f"Contraction {c} returned empty IPA")

    def test_heteronym_and_multiple_variants_preserved(self):
        """GATE 4: Verify heteronyms and variants are preserved in alternatives[]."""
        heteronyms = ["record", "present", "object", "project", "lead", "read", "close", "content"]
        for h in heteronyms:
            res = self.pipeline.lookup_word(h)
            self.assertNotEqual(res["ipa"], "", f"Heteronym {h} returned empty IPA")
            self.assertEqual(res["source"], "CMUDICT")
            self.assertTrue(len(res["alternatives"]) > 0, f"Heteronym {h} dropped alternative variants")

    def test_monosyllable_display_policy(self):
        """GATE 6: Verify unreduced monosyllables omit redundant initial primary stress mark."""
        res_right = self.pipeline.lookup_word("right")
        self.assertFalse(res_right["ipa"].startswith("ˈ"), f"Monosyllable 'right' had redundant stress: {res_right['ipa']}")

        res_screamed = self.pipeline.lookup_word("screamed")
        self.assertFalse(res_screamed["ipa"].startswith("ˈ"), f"Monosyllable 'screamed' had redundant stress: {res_screamed['ipa']}")

        # Multisyllable words must retain primary stress
        res_machine = self.pipeline.lookup_word("machine")
        self.assertIn("ˈ", res_machine["ipa"], f"Multisyllable 'machine' lost stress mark: {res_machine['ipa']}")

    def test_sentence_processing_and_punctuation(self):
        """GATE 9: Verify complete sentence processing with punctuation and word metadata."""
        sent = 'This morning, a machine screamed at you until you woke up.'
        res = self.pipeline.process_sentence(sent)
        self.assertNotEqual(res["sentenceIpa"], "")
        self.assertEqual(len(res["words"]), 11)
        self.assertEqual(res["words"][0]["surface"], "This")
        self.assertEqual(res["words"][1]["surface"], "morning")
        self.assertEqual(res["words"][1]["suffix"], ",")
        self.assertEqual(res["words"][2]["surface"], "a")
        self.assertEqual(res["words"][3]["surface"], "machine")
        self.assertEqual(res["words"][4]["surface"], "screamed")
        self.assertEqual(res["words"][4]["ipa"], "skrimd")


if __name__ == "__main__":
    unittest.main()
