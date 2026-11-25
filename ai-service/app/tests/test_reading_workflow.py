import unittest
from unittest.mock import MagicMock, patch
from app.api.routes.reading import (
    ExplainContextRequest,
    ExtractContextualVocabularyRequest,
    explain_context,
    extract_contextual_vocabulary,
)

class TestReadingWorkflow(unittest.IsolatedAsyncioTestCase):

    async def test_explain_context_with_mock_llm(self):
        mock_llm = MagicMock()
        mock_llm.invoke.return_value.content = """```json
        {
          "meaningInContext": "thể hiện sự thiếu tôn trọng đối với một điều thiêng liêng",
          "nativeExplanation": "Ở đây insulting mang nghĩa hành vi báng bổ, xúc phạm.",
          "lemma": "insult",
          "pos": "verb",
          "cefr": "B2",
          "frequency": "common",
          "collocations": [
            {"phrase": "deeply insulting", "meaning": "cực kỳ xúc phạm"}
          ],
          "synonyms": [
            {"word": "offensive", "nuance": "nhấn mạnh tính chất gây khó chịu"}
          ]
        }
        ```"""
        with patch("app.api.routes.reading.get_llm", return_value=mock_llm):
            req = ExplainContextRequest(
                text="insulting",
                sentence="His crime was insulting an important Hindu festival called Nyepi."
            )
            res = await explain_context(req)
            self.assertEqual(res.meaningInContext, "thể hiện sự thiếu tôn trọng đối với một điều thiêng liêng")
            self.assertEqual(res.lemma, "insult")
            self.assertEqual(res.pos, "verb")
            self.assertEqual(res.cefr, "B2")
            self.assertEqual(len(res.collocations), 1)
            self.assertEqual(res.collocations[0].phrase, "deeply insulting")
            self.assertEqual(len(res.synonyms), 1)
            self.assertEqual(res.synonyms[0].word, "offensive")

    async def test_explain_context_fallback_when_llm_fails(self):
        with patch("app.api.routes.reading.get_llm", return_value=None):
            req = ExplainContextRequest(
                text="insulting",
                sentence="His crime was insulting an important Hindu festival called Nyepi."
            )
            res = await explain_context(req)
            self.assertIn("insulting", res.meaningInContext)
            self.assertEqual(res.lemma, "insulting")
            self.assertEqual(res.cefr, "B2")

    async def test_extract_contextual_vocabulary_with_grounding(self):
        mock_llm = MagicMock()
        mock_llm.invoke.return_value.content = """{
          "items": [
            {
              "text": "insulting",
              "lemma": "insult",
              "pos": "verb",
              "cefr": "B2",
              "meaningInContext": "hành vi xúc phạm",
              "shortExplanation": "thiếu tôn trọng tôn giáo"
            },
            {
              "text": "sacred rules",
              "lemma": "sacred rule",
              "pos": "noun phrase",
              "cefr": "B2",
              "meaningInContext": "những quy tắc thiêng liêng",
              "shortExplanation": "quy tắc bất khả xâm phạm"
            },
            {
              "text": "hallucinated word",
              "lemma": "hallucinate",
              "pos": "noun",
              "cefr": "C2",
              "meaningInContext": "từ bịa đặt không có trong bài",
              "shortExplanation": "không xuất hiện trong văn bản"
            }
          ]
        }"""
        with patch("app.api.routes.reading.get_llm", return_value=mock_llm):
            passage = "His crime was insulting an important Hindu festival. He expressed regret for breaking the sacred rules."
            req = ExtractContextualVocabularyRequest(
                passage=passage,
                maxItems=5
            )
            res = await extract_contextual_vocabulary(req)
            extracted_texts = [item.text.lower() for item in res.items]
            # Grounded items should be present
            self.assertIn("insulting", extracted_texts)
            self.assertIn("sacred rules", extracted_texts)
            # Hallucinated item not in passage must be rejected!
            self.assertNotIn("hallucinated word", extracted_texts)

    async def test_extract_contextual_vocabulary_fallback(self):
        with patch("app.api.routes.reading.get_llm", return_value=None):
            passage = "His crime was insulting an important Hindu festival. He expressed regret for breaking the sacred rules."
            req = ExtractContextualVocabularyRequest(
                passage=passage,
                maxItems=5
            )
            res = await extract_contextual_vocabulary(req)
            self.assertGreater(len(res.items), 0)
            for item in res.items:
                self.assertIn(item.text.lower(), passage.lower())

if __name__ == "__main__":
    unittest.main()
