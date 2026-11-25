"""
ECSM-v1 / EC-PRISM Phase P6: Controlled Acoustic Backbone Adapter.
Provides unified extraction, layer selection, and segmentation-free pooling
across Wav2Vec2 (MODEL_E), HuBERT, and WavLM backbones.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import hashlib
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple, Union

import numpy as np
try:
    import soundfile as sf
except ImportError:
    sf = None
import torch
import torch.nn as nn
import torch.nn.functional as F
from transformers import (
    AutoConfig,
    AutoFeatureExtractor,
    AutoModel,
    HubertModel,
    Wav2Vec2ForCTC,
    Wav2Vec2Processor,
    WavLMModel,
)
from safetensors.torch import load_file

from app.services.pronunciation.acoustic_peft import inject_wav2vec2_lora


class BackboneCandidate(str, Enum):
    B0_MODEL_E = "B0_MODEL_E"
    B1_HUBERT_BASE = "B1_HUBERT_BASE"
    B1_HUBERT_LARGE = "B1_HUBERT_LARGE"
    B2_WAVLM_BASE_PLUS = "B2_WAVLM_BASE_PLUS"
    B2_WAVLM_LARGE = "B2_WAVLM_LARGE"


@dataclass(frozen=True)
class BackboneConfig:
    candidate_id: BackboneCandidate
    model_id: str
    revision: str
    num_layers: int
    hidden_dim: int
    candidate_layers: List[int]
    default_layer: int
    license_name: str
    commercial_status: str
    provider: str
    stride_samples: int = 320
    sample_rate: int = 16000

    def to_dict(self) -> Dict[str, Any]:
        return {
            "candidateId": self.candidate_id.value,
            "modelId": self.model_id,
            "revision": self.revision,
            "numLayers": self.num_layers,
            "hiddenDim": self.hidden_dim,
            "candidateLayers": self.candidate_layers,
            "defaultLayer": self.default_layer,
            "licenseName": self.license_name,
            "commercialStatus": self.commercial_status,
            "provider": self.provider,
            "strideSamples": self.stride_samples,
            "sampleRate": self.sample_rate,
            "framesPerSec": float(self.sample_rate / self.stride_samples),
        }


BACKBONE_REGISTRY: Mapping[BackboneCandidate, BackboneConfig] = {
    BackboneCandidate.B0_MODEL_E: BackboneConfig(
        candidate_id=BackboneCandidate.B0_MODEL_E,
        model_id="facebook/wav2vec2-lv-60-espeak-cv-ft",
        revision="ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4",
        num_layers=24,
        hidden_dim=1024,
        candidate_layers=[24, 18],
        default_layer=24,
        license_name="CC BY-NC 4.0 (Base) / Custom PEFT (Adapter)",
        commercial_status="RESEARCH_BENCHMARK_REFERENCE",
        provider="Meta AI / EnglishCoach",
    ),
    BackboneCandidate.B1_HUBERT_BASE: BackboneConfig(
        candidate_id=BackboneCandidate.B1_HUBERT_BASE,
        model_id="facebook/hubert-base-ls960",
        revision="dba3bb02fda4248b6e082697eee756de8fe8aa8a",
        num_layers=12,
        hidden_dim=768,
        candidate_layers=[12, 9],
        default_layer=12,
        license_name="MIT License",
        commercial_status="PRODUCTION_ELIGIBLE",
        provider="Meta AI",
    ),
    BackboneCandidate.B1_HUBERT_LARGE: BackboneConfig(
        candidate_id=BackboneCandidate.B1_HUBERT_LARGE,
        model_id="facebook/hubert-large-ls960-ft",
        revision="ece5fabbf034c1073acae96d5401b25be96709d8",
        num_layers=24,
        hidden_dim=1024,
        candidate_layers=[24, 18],
        default_layer=24,
        license_name="MIT License",
        commercial_status="PRODUCTION_ELIGIBLE",
        provider="Meta AI",
    ),
    BackboneCandidate.B2_WAVLM_BASE_PLUS: BackboneConfig(
        candidate_id=BackboneCandidate.B2_WAVLM_BASE_PLUS,
        model_id="microsoft/wavlm-base-plus",
        revision="4c66d4806a428f2e922ccfa1a962776e232d487b",
        num_layers=12,
        hidden_dim=768,
        candidate_layers=[12, 9],
        default_layer=12,
        license_name="MIT License",
        commercial_status="PRODUCTION_ELIGIBLE",
        provider="Microsoft Research",
    ),
    BackboneCandidate.B2_WAVLM_LARGE: BackboneConfig(
        candidate_id=BackboneCandidate.B2_WAVLM_LARGE,
        model_id="microsoft/wavlm-large",
        revision="c1423ed94bb01d80a3f5ce5bc39f6026a0f4828c",
        num_layers=24,
        hidden_dim=1024,
        candidate_layers=[24, 18],
        default_layer=24,
        license_name="MIT License",
        commercial_status="PRODUCTION_ELIGIBLE",
        provider="Microsoft Research",
    ),
}


class AcousticBackboneAdapter:
    """
    Unified acoustic backbone wrapper for Phase P6 bake-off.
    Loads and runs frozen foundation models with exact layer selection and soft temporal pooling.
    """

    def __init__(
        self,
        config: BackboneConfig,
        device: torch.device,
        data_dir: Optional[Path] = None,
    ):
        self.config = config
        self.device = device
        self.data_dir = data_dir
        self.model: Optional[nn.Module] = None
        self._load_model()

    def _load_model(self) -> None:
        if self.config.candidate_id == BackboneCandidate.B0_MODEL_E:
            self.model = Wav2Vec2ForCTC.from_pretrained(
                self.config.model_id,
                revision=self.config.revision,
            )
            # Inject and load trained LoRA adapter
            inject_wav2vec2_lora(self.model, target_layers=[20, 21, 22, 23], rank=4, alpha=4.0)
            if self.data_dir is not None:
                adapter_path = self.data_dir / "outputs/shd-2b.5/round1/checkpoint_MODEL_E_SEED1/best_adapter.safetensors"
                if adapter_path.exists():
                    weights = load_file(str(adapter_path), device="cpu")
                    self.model.load_state_dict(weights, strict=False)
        elif "hubert" in self.config.model_id.lower():
            self.model = HubertModel.from_pretrained(
                self.config.model_id,
                revision=self.config.revision,
            )
        elif "wavlm" in self.config.model_id.lower():
            self.model = WavLMModel.from_pretrained(
                self.config.model_id,
                revision=self.config.revision,
            )
        else:
            self.model = AutoModel.from_pretrained(
                self.config.model_id,
                revision=self.config.revision,
            )

        # Freeze all weights strictly
        for param in self.model.parameters():
            param.requires_grad_(False)
        self.model.eval().to(self.device)

    def extract_hidden_states(
        self,
        audio_waveform: Union[np.ndarray, torch.Tensor],
        selected_layer: Optional[int] = None,
    ) -> np.ndarray:
        """
        Extracts transformer frame representations [T, D] for a given audio sequence.
        selected_layer is 1-indexed (e.g. 12 for 12th layer, 24 for 24th layer).
        """
        layer_idx = selected_layer if selected_layer is not None else self.config.default_layer
        
        if isinstance(audio_waveform, np.ndarray):
            tensor = torch.from_numpy(audio_waveform.astype(np.float32)).unsqueeze(0).to(self.device)
        else:
            tensor = audio_waveform.unsqueeze(0).to(self.device) if audio_waveform.ndim == 1 else audio_waveform.to(self.device)

        with torch.inference_mode():
            outputs = self.model(tensor, output_hidden_states=True)
            # hidden_states is tuple of (embedding_output, layer_1, ..., layer_N)
            # layer_idx = N corresponds to index N in hidden_states
            num_hs = len(outputs.hidden_states)
            target_idx = max(0, min(layer_idx, num_hs - 1))
            layer_hidden = outputs.hidden_states[target_idx][0].detach().cpu().numpy().astype(np.float32, copy=False)

        return layer_hidden

    def extract_soft_evidence(
        self,
        hidden_states: np.ndarray,
        center_frame: float,
        duration_frames: float,
        temporal_sigma: float = 3.0,
        margin_frames: int = 4,
    ) -> np.ndarray:
        """
        Computes Gaussian-weighted soft marginalization over frame representations.
        Identical to R2 pooling definition.
        """
        num_frames, dim = hidden_states.shape
        s = max(0, int(center_frame - duration_frames / 2.0 - margin_frames))
        e = min(num_frames, int(center_frame + duration_frames / 2.0 + margin_frames + 1))

        if e <= s:
            s = max(0, min(int(center_frame), num_frames - 1))
            e = min(num_frames, s + 1)

        t_indices = np.arange(s, e, dtype=np.float32)
        sigma = max(1.0, temporal_sigma)
        weights = np.exp(-((t_indices - center_frame) ** 2) / (2.0 * sigma ** 2))
        weights /= (np.sum(weights) + 1e-9)

        sub_hidden = hidden_states[s:e]
        soft_hidden = np.sum(sub_hidden * weights[:, None], axis=0).astype(np.float32)
        return soft_hidden

    def get_parameter_count(self) -> int:
        return sum(p.numel() for p in self.model.parameters()) if self.model else 0
