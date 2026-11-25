"""
Teacher Cache Manager for SHD-2B.5 Round 1.
Precomputes frozen Wav2Vec2 base teacher logits ONCE and caches on disk/CPU.
Unloads base model from GPU to ensure zero redundant forwards and minimal VRAM footprint.
"""

import hashlib
import json
import os
from pathlib import Path
import sys
import time
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

import numpy as np
try:
    import soundfile as sf
except ImportError:
    sf = None
import torch
from transformers import Wav2Vec2ForCTC

sys.path.insert(0, "/app")
from app.services.pronunciation.acoustic_peft import (
    CANONICAL_MODEL_ID,
    CANONICAL_MODEL_REVISION,
)
from scripts.acoustic_peft_controlled_study import resolve_speechocean_wav_path

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")


def compute_manifest_hash(rows: Sequence[Dict[str, Any]]) -> str:
    hasher = hashlib.sha256()
    sorted_items = sorted([(r.get("speakerId", ""), r.get("utteranceId", ""), r.get("phone", "")) for r in rows])
    hasher.update(json.dumps(sorted_items).encode("utf-8"))
    return hasher.hexdigest()


class TeacherCacheManager:
    """
    Manages deterministic precomputed teacher logits for CTC KL preservation.
    """

    def __init__(self, cache_dir: Path):
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.cache_file = self.cache_dir / "teacher_logits_fp32.pt"
        self.meta_file = self.cache_dir / "teacher_cache_meta.json"
        self.teacher_logits: Dict[str, torch.Tensor] = {}
        self.cache_hash = ""

    def is_valid(self, expected_manifest_hash: str, expected_utt_count: int) -> bool:
        if not self.cache_file.exists() or not self.meta_file.exists():
            return False
        try:
            with open(self.meta_file, "r", encoding="utf-8") as f:
                meta = json.load(f)
            if (
                meta.get("baseModelId") == CANONICAL_MODEL_ID
                and meta.get("baseRevision") == CANONICAL_MODEL_REVISION
                and meta.get("manifestHash") == expected_manifest_hash
                and meta.get("utteranceCount") == expected_utt_count
            ):
                return True
        except Exception:
            return False
        return False

    def load_cache(self) -> Dict[str, torch.Tensor]:
        print(f"Loading precomputed teacher cache from {self.cache_file}...")
        self.teacher_logits = torch.load(self.cache_file, map_location="cpu", weights_only=True)
        with open(self.meta_file, "r", encoding="utf-8") as f:
            meta = json.load(f)
        self.cache_hash = meta.get("cacheHash", "")
        print(f"Loaded teacher logits for {len(self.teacher_logits)} utterances (Cache Hash: {self.cache_hash[:12]}...).")
        return self.teacher_logits

    def build_and_save_cache(
        self,
        rows: Sequence[Dict[str, Any]],
        wave_root: Path,
    ) -> Dict[str, torch.Tensor]:
        utt_map = {}
        for r in rows:
            u_id = r["utteranceId"]
            if u_id not in utt_map:
                utt_map[u_id] = r["speakerId"]

        total_utts = len(utt_map)
        manifest_hash = compute_manifest_hash(rows)

        if self.is_valid(manifest_hash, total_utts):
            return self.load_cache()

        print("\n" + "=" * 80)
        print(f"PRECOMPUTING FROZEN TEACHER LOGITS ONCE FOR {total_utts} UTTERANCES")
        print("=" * 80)

        # Load frozen base model onto GPU
        base_model = Wav2Vec2ForCTC.from_pretrained(
            CANONICAL_MODEL_ID,
            revision=CANONICAL_MODEL_REVISION,
        ).to(device)
        base_model.eval()

        self.teacher_logits = {}
        start_time = time.time()

        for idx, (u_id, spk_id) in enumerate(sorted(utt_map.items()), start=1):
            wav_path = resolve_speechocean_wav_path(wave_root, spk_id, u_id)
            if not wav_path or not wav_path.exists():
                continue
            audio_arr, sr = sf.read(wav_path)
            x = torch.tensor(audio_arr, dtype=torch.float32, device=device).unsqueeze(0)

            with torch.no_grad():
                logits = base_model(x).logits[0].cpu() # Store on CPU float32

            self.teacher_logits[u_id] = logits

            if idx % 250 == 0 or idx == total_utts:
                elapsed = time.time() - start_time
                rate = idx / elapsed
                eta = (total_utts - idx) / rate if rate > 0 else 0
                print(
                    f"Teacher Cache | {idx}/{total_utts} ({idx/total_utts*100:.1f}%) | "
                    f"Rate: {rate:.1f} utt/s | Elapsed: {elapsed:.1f}s | ETA: {eta:.1f}s",
                    flush=True,
                )

        # Compute hash of all teacher logits
        hasher = hashlib.sha256()
        for u_id in sorted(self.teacher_logits.keys()):
            hasher.update(u_id.encode("utf-8"))
            hasher.update(self.teacher_logits[u_id].numpy().tobytes()[:1024])
        self.cache_hash = hasher.hexdigest()

        # Atomic save
        tmp_cache_file = self.cache_file.with_suffix(".tmp")
        torch.save(self.teacher_logits, tmp_cache_file)
        os.replace(tmp_cache_file, self.cache_file)

        meta = {
            "baseModelId": CANONICAL_MODEL_ID,
            "baseRevision": CANONICAL_MODEL_REVISION,
            "manifestHash": manifest_hash,
            "cacheHash": self.cache_hash,
            "utteranceCount": len(self.teacher_logits),
            "dtype": "float32",
            "deviceStorage": "cpu",
            "createdTimestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        tmp_meta_file = self.meta_file.with_suffix(".tmp")
        with open(tmp_meta_file, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
        os.replace(tmp_meta_file, self.meta_file)

        # UNLOAD BASE MODEL COMPLETELY FROM GPU
        del base_model
        torch.cuda.empty_cache()
        print(f"Teacher cache saved to {self.cache_file}. Base model unloaded from GPU. VRAM freed.\n", flush=True)

        return self.teacher_logits
