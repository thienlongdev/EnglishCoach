"""Image preprocessing pipelines for region OCR (Exams Recovery Phase 3.5D).

Pipelines are NAMED and VERSIONED: the id + version is part of every OCR cache key, so a changed transformation can
never reuse stale OCR. Nothing here is applied blindly to all sources — the benchmark (`ocr_bench.py`) measures each
pipeline on representative pages and the collection layout profile names the one to use.

  P0  grayscale only (reference)
  P1  grayscale + percentile contrast stretch (light-grey answer-key print, yellowed scans)
  P2  P1 + Otsu binarisation (strong background noise)
  P3  P1 + deskew (projection-profile angle search, |angle| <= 3 deg; rotation is reported, never silent)
  P4  inverted + stretch (white text on dark header bars)
  P5  background normalisation (closing) + stretch (light glyphs on shaded table cells)
  P6  P5 + Otsu binarisation (second, independent read of table cells)

Images are numpy arrays (H x W, uint8 grayscale, or H x W x C). The raw PDF is never touched: callers render a
page region to pixels first.
"""
from __future__ import annotations

from typing import Optional

import numpy as np

try:
    import cv2  # type: ignore
except Exception:  # pragma: no cover
    cv2 = None

PREPROCESS_VERSION = "1"
PIPELINES = ("P0", "P1", "P2", "P3", "P4", "P5", "P6")


def to_gray(img: np.ndarray) -> np.ndarray:
    if img.ndim == 2:
        return img
    if img.shape[2] == 4:
        img = img[:, :, :3]
    if cv2 is not None:
        return cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    return (img[:, :, 0] * 0.299 + img[:, :, 1] * 0.587 + img[:, :, 2] * 0.114).astype(np.uint8)


def stretch(gray: np.ndarray, lo: float = 1.0, hi: float = 99.0) -> np.ndarray:
    """Percentile contrast stretch: light-grey glyphs become black without moving glyph geometry."""
    a, b = np.percentile(gray, [lo, hi])
    if b - a < 8:
        return gray.copy()
    out = (gray.astype(np.float32) - a) * (255.0 / (b - a))
    return np.clip(out, 0, 255).astype(np.uint8)


def binarize(gray: np.ndarray) -> np.ndarray:
    """Otsu threshold -> 0 (ink) / 255 (paper)."""
    if cv2 is not None:
        _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        return bw
    t = _otsu(gray)
    return np.where(gray > t, 255, 0).astype(np.uint8)


def _otsu(gray: np.ndarray) -> int:
    hist = np.bincount(gray.ravel(), minlength=256).astype(np.float64)
    total = gray.size
    sum_all = np.dot(np.arange(256), hist)
    w0 = sum0 = 0.0
    best, thr = -1.0, 127
    for t in range(256):
        w0 += hist[t]
        if w0 == 0 or w0 == total:
            continue
        sum0 += t * hist[t]
        m0, m1 = sum0 / w0, (sum_all - sum0) / (total - w0)
        var = w0 * (total - w0) * (m0 - m1) ** 2
        if var > best:
            best, thr = var, t
    return thr


def ink_mask(gray: np.ndarray) -> np.ndarray:
    """Boolean ink mask (True = dark) after contrast stretch + Otsu."""
    return binarize(stretch(gray)) < 128


def deskew_angle(gray: np.ndarray, max_deg: float = 3.0, step: float = 0.2) -> float:
    """Angle (degrees) maximising the variance of the horizontal ink projection (text lines become sharp)."""
    if cv2 is None:
        return 0.0
    mask = ink_mask(gray).astype(np.uint8) * 255
    h, w = mask.shape
    small = cv2.resize(mask, (max(1, w // 2), max(1, h // 2)), interpolation=cv2.INTER_AREA)
    sh, sw = small.shape
    centre = (sw / 2, sh / 2)
    best, best_a = -1.0, 0.0
    a = -max_deg
    while a <= max_deg + 1e-9:
        m = cv2.getRotationMatrix2D(centre, a, 1.0)
        rot = cv2.warpAffine(small, m, (sw, sh), flags=cv2.INTER_NEAREST, borderValue=0)
        score = float(np.var(rot.sum(axis=1)))
        if score > best:
            best, best_a = score, a
        a += step
    return round(best_a, 2)


def rotate(gray: np.ndarray, angle: float) -> np.ndarray:
    if cv2 is None or abs(angle) < 0.05:
        return gray
    h, w = gray.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    return cv2.warpAffine(gray, m, (w, h), flags=cv2.INTER_LINEAR, borderValue=255)


def apply(pipeline: str, img: np.ndarray) -> tuple:
    """-> (processed grayscale image, meta). meta['angle'] is the deskew rotation applied (P3 only)."""
    gray = to_gray(img)
    meta: dict = {"pipeline": pipeline, "version": PREPROCESS_VERSION}
    if pipeline == "P0":
        return gray, meta
    if pipeline == "P1":
        return stretch(gray), meta
    if pipeline == "P2":
        return binarize(stretch(gray)), meta
    if pipeline == "P3":
        g = stretch(gray)
        ang = deskew_angle(g)
        meta["angle"] = ang
        return rotate(g, ang), meta
    if pipeline == "P4":
        return stretch(255 - gray), meta
    if pipeline == "P5":
        return stretch(normalize_background(gray)), meta
    if pipeline == "P6":
        return binarize(stretch(normalize_background(gray))), meta
    raise ValueError(f"unknown preprocessing pipeline {pipeline}")


def normalize_background(gray: np.ndarray, k: Optional[int] = None) -> np.ndarray:
    """Divide out the local background (paper + cell shading) estimated by a morphological closing:
    light glyphs on grey cells become as dark as glyphs on white."""
    if cv2 is None:
        return gray
    k = k or max(15, (min(gray.shape) // 25) | 1)
    bg = cv2.morphologyEx(gray, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    out = gray.astype(np.float32) / np.maximum(bg.astype(np.float32), 1.0) * 255.0
    return np.clip(out, 0, 255).astype(np.uint8)


def pipeline_id(pipeline: Optional[str]) -> str:
    return f"{pipeline or 'P0'}v{PREPROCESS_VERSION}"
