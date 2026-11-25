"""Trainer 1 practice windows proven by contents PDF4 and printed page folios.

Guided training tests 1/2 require their own layout recovery. The explanatory
answer-key columns also require recovery; this adapter never guesses key rows.
"""
from .base import AnnotatedRow, QUESTIONS
from .cambridge_ielts import CambridgeIeltsAdapter


class IeltsTrainerPracticeAdapter(CambridgeIeltsAdapter):
    name = "ielts-trainer-practice"
    collections = ("ielts-trainer",)
    SOURCE_HASH = "a80567fe26de7fe195dcef1ff1e478325aebd4f2d2077789d4cbca00f81820db"
    # Printed contents boundaries; this exact PDF has one preceding cover page.
    WINDOWS = {
        3: ((97, 102, "LISTENING"), (103, 113, "READING"),
            (114, 114, "WRITING"), (115, 115, "SPEAKING")),
        4: ((116, 121, "LISTENING"), (122, 132, "READING"),
            (133, 133, "WRITING"), (134, 134, "SPEAKING")),
        5: ((135, 139, "LISTENING"), (140, 150, "READING"),
            (151, 152, "WRITING"), (153, 153, "SPEAKING")),
        6: ((154, 158, "LISTENING"), (159, 169, "READING"),
            (170, 171, "WRITING"), (172, 172, "SPEAKING")),
    }

    def supports(self, test):
        return (test.family == "IELTS" and test.book == "ielts-trainer-1"
                and test.test_number in self.WINDOWS)

    def question_documents(self, test, manifest):
        return [d["path"] for d in test.book_raw.get("source_documents", [])
                if d.get("sha256") == self.SOURCE_HASH and d.get("readable", True)]

    def annotate(self, pages, page_w, page_h):
        out = []
        for page, rows in pages:
            printed = page - 1
            context = next(((n, skill) for n, windows in self.WINDOWS.items()
                            for first, last, skill in windows if first <= printed <= last), None)
            if context is None:
                continue
            n, skill = context
            for row in rows:
                if not self.is_noise(row, page_w, page_h):
                    out.append(AnnotatedRow(row, QUESTIONS, n, skill))
        return out
