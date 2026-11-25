"""Printed Speaking turns must survive extraction; generated topics cannot replace them."""
import unittest

from exam_extractor.ielts import speaking_turn_prompts


class SpeakingSourceTurnsTests(unittest.TestCase):
    def test_all_six_discussion_questions_preserved(self):
        lines = ["Discussion topics:", "Synthetic topic"] + [f"What is synthetic question {n}?" for n in range(1, 7)]
        self.assertEqual(speaking_turn_prompts(3, lines), lines[2:])

    def test_conditional_discussion_and_imperative_starts_preserved(self):
        lines = ["If you visit a synthetic place, what do you do?", "In your opinion, will that change?",
                 "In what ways is it different?", "To what extent is it important?", "Tell me about a synthetic place."]
        self.assertEqual(speaking_turn_prompts(1, lines), lines)

    def test_wrapped_question_and_followup_preserved(self):
        self.assertEqual(speaking_turn_prompts(1, ["What is your synthetic", "answer?", "[Why/Why not?]", "Do you agree?"]),
                         ["What is your synthetic answer? [Why/Why not?]", "Do you agree?"])

    def test_incomplete_question_is_not_dropped(self):
        self.assertEqual(speaking_turn_prompts(3, ["What is complete?", "How is incomplete"]), [])
        self.assertEqual(speaking_turn_prompts(3, ["What is incomplete", "How is another question?"]), [])

    def test_entire_cue_card_preserved(self):
        lines = ["Describe a synthetic place.", "You should say:", "where it is", "what it is like", "and explain why it matters."]
        self.assertEqual(speaking_turn_prompts(2, lines), [" ".join(lines)])
        self.assertEqual(speaking_turn_prompts(2, ["Describe an incomplete cue card."]), [])
        self.assertEqual(speaking_turn_prompts(2, lines + ["You will have 1 to 2 minutes."]), [])
