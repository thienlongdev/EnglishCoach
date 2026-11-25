#!/usr/bin/env python3
"""Exams Recovery Phase 3 extractor entry point (see scripts/exam_extractor/cli.py for usage).

Local only: reads the immutable raw corpus imports/source-files/** and the Phase 1 manifest, writes canonical
ExamContentPackage JSON + reports to imports/exams/staging/. No database, no network, no production import.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from exam_extractor.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
