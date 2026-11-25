"""Collection adapter registry."""
from __future__ import annotations

from .cambridge_ielts import CambridgeIeltsAdapter
from .toeic_ets import EtsToeicReadingAdapter, EtsToeicOcrAdapter
from .ielts_trainer import IeltsTrainerPracticeAdapter
from .ielts_practice_plus import IeltsPracticePlusAdapter

ADAPTERS = [CambridgeIeltsAdapter(), IeltsTrainerPracticeAdapter(), IeltsPracticePlusAdapter(), EtsToeicReadingAdapter(), EtsToeicOcrAdapter()]


def adapter_for(test):
    for a in ADAPTERS:
        if a.supports(test):
            return a
    return None
