import logging
from abc import ABC, abstractmethod
from typing import Dict, List, Optional, Tuple, Any
import numpy as np
import torch
from transformers import AutoProcessor, AutoModelForCTC

logger = logging.getLogger("model_adapter")


class BaseAcousticModelAdapter(ABC):
    """
    Abstract adapter for acoustic phone models to plug seamlessly
    into the CTC alignment and GOP assessment architecture.
    """

    def __init__(self, model_id: str, device: str = "cuda:0"):
        self.model_id = model_id
        self.device = device
        self.processor = AutoProcessor.from_pretrained(model_id)
        self.model = AutoModelForCTC.from_pretrained(model_id).to(device)
        self.model.eval()
        self.vocab = self.processor.tokenizer.get_vocab()
        self.id2tok = {v: k for k, v in self.vocab.items()}
        self.blank_id = (
            self.processor.tokenizer.pad_token_id
            if self.processor.tokenizer.pad_token_id is not None
            else 0
        )
        self.frame_duration_ms = 20.0
        self.param_count = sum(p.numel() for p in self.model.parameters())

    @abstractmethod
    def map_reference_phone(self, phone: str) -> Optional[str]:
        """
        Map a reference phoneme (standard IPA / espeak format)
        to the model's native vocabulary token string.
        Returns None if no mapping exists.
        """
        pass

    def infer_log_probs(self, audio_tensor: torch.Tensor) -> np.ndarray:
        """
        Run GPU acoustic inference on 16kHz float32 audio waveform tensor [1, N] or [N].
        Returns log probabilities of shape [T, V].
        """
        if audio_tensor.dim() == 2:
            audio_np = audio_tensor.squeeze(0).cpu().numpy()
        else:
            audio_np = audio_tensor.cpu().numpy()

        with torch.no_grad():
            inputs = self.processor(
                audio_np,
                sampling_rate=16000,
                return_tensors="pt"
            )
            input_values = inputs.input_values.to(self.device)
            logits = self.model(input_values).logits[0]  # [T, V]
            log_probs = torch.log_softmax(logits, dim=-1).cpu().numpy()

        return log_probs

    def map_variant_phonemes(self, phonemes: List[str]) -> Optional[List[str]]:
        """
        Map an entire phoneme sequence to model-native tokens.
        Returns None if any required phoneme cannot be represented.
        """
        mapped = []
        for p in phonemes:
            tok = self.map_reference_phone(p)
            if tok is None or tok not in self.vocab:
                return None
            mapped.append(tok)
        return mapped


class EspeakWav2Vec2Adapter(BaseAcousticModelAdapter):
    """
    Adapter for models trained with the multilingual espeak-ng IPA tokenizer:
    - facebook/wav2vec2-lv-60-espeak-cv-ft (Baseline A)
    - facebook/wav2vec2-xlsr-53-espeak-cv-ft (Challenger 1)
    """

    def map_reference_phone(self, phone: str) -> Optional[str]:
        if phone in self.vocab:
            return phone
        # Fallbacks for allophonic stress markers or composite tokens
        clean_phone = phone.replace("ː", "").replace("ˈ", "").replace("ˌ", "")
        if clean_phone in self.vocab:
            return clean_phone
        return None


class TimitXlsrAdapter(BaseAcousticModelAdapter):
    """
    Adapter for models trained on TIMIT 42-phone English inventory:
    - vitouphy/wav2vec2-xls-r-300m-timit-phoneme (Challenger 2)
    """

    PHONE_MAP = {
        # Long vowels to TIMIT single-char vowels
        "iː": "i",
        "uː": "u",
        "ɔː": "ɑ",
        "ɑː": "ɑ",
        "ɔːɹ": "ɝ",
        "ɔɹ": "ɝ",
        "ɐ": "ə",
        "ʌ": "ə",
        # Affricates
        "dʒ": "ʤ",
        "tʃ": "ʧ",
        "d͡ʒ": "ʤ",
        "t͡ʃ": "ʧ",
    }

    def map_reference_phone(self, phone: str) -> Optional[str]:
        if phone in self.PHONE_MAP:
            target = self.PHONE_MAP[phone]
            if target in self.vocab:
                return target

        if phone in self.vocab:
            return phone

        # Strip length mark fallback
        clean_phone = phone.replace("ː", "")
        if clean_phone in self.vocab:
            return clean_phone

        return None


def get_acoustic_adapter(model_id: str, device: str = "cuda:0") -> BaseAcousticModelAdapter:
    """Factory creating appropriate model adapter."""
    if "timit" in model_id.lower():
        return TimitXlsrAdapter(model_id=model_id, device=device)
    else:
        return EspeakWav2Vec2Adapter(model_id=model_id, device=device)
