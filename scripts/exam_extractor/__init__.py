"""Exams Recovery Phase 3 — extractor rebuild from the immutable raw corpus.

Pipeline (one reusable architecture, not per-book scripts)::

    Phase 1 raw-source manifest (imports/exams/manifests/raw-source/)
      -> SourceCollectionAdapter (collection specifics: page markers, header noise, answer-key layout)
      -> PdfTextLayer / OcrAdapter (page lines with page identity, method and confidence)
      -> family extractor (IELTS / TOEIC structure: section -> part -> question group -> item)
      -> answer-key resolver (syntax by question type + alignment) and media binder (manifest audio, page figures)
      -> canonical ExamContentPackage JSON (Java record shape, Jackson-compatible content hash, sourceProvenance)
      -> staging writer (imports/exams/staging/extracted/) + extraction report
      -> Phase 2 validators (Java: ExamContentPackageValidator + ExamFormValidator) via
         backend test ExamStagingPackageValidationTest.

Rules: the raw corpus is opened read-only and never modified; a parser failure is an explicit diagnostic and the
affected unit is omitted (never a placeholder); no SQL, no database, no network.
"""
