"""
HTTP Client for isolated MDD Service (:8010).
Supports MDD-LLM primary detection and CROTTC-IF selective diagnosis.
Preserves same-audio checksum integrity across cascade steps.
"""

from __future__ import annotations
import hashlib
import json
import logging
import os
from typing import Dict, Any, Optional, List

import httpx

logger = logging.getLogger("ai-service.mdd_client")

class MddServiceClient:
    def __init__(self, base_url: Optional[str] = None, timeout_sec: float = 30.0):
        self.base_url = (base_url or os.getenv("MDD_SERVICE_URL", "http://mdd-service:8010")).rstrip("/")
        self.timeout_sec = timeout_sec

    @staticmethod
    def _auth_headers() -> Dict[str, str]:
        """Attach X-EC-Service-Key when MDD_SERVICE_KEY is configured (EC-SEC-2026-008)."""
        key = (os.getenv("MDD_SERVICE_KEY") or "").strip()
        return {"X-EC-Service-Key": key} if key else {}

    def check_health(self) -> Dict[str, Any]:
        url = f"{self.base_url}/health"
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(url, headers=self._auth_headers())
            resp.raise_for_status()
            return resp.json()

    def check_ready(self) -> Dict[str, Any]:
        url = f"{self.base_url}/ready"
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(url, headers=self._auth_headers())
            resp.raise_for_status()
            return resp.json()

    def get_model_info(self) -> Dict[str, Any]:
        url = f"{self.base_url}/model-info"
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(url, headers=self._auth_headers())
            resp.raise_for_status()
            return resp.json()

    def detect_audio(
        self,
        audio_bytes: bytes,
        filename: str = "audio.wav",
        attempt_id: Optional[str] = None,
        case_id: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Calls MDD-LLM Primary Detector on input audio.
        """
        url = f"{self.base_url}/v1/mdd/detect"
        files = {
            "file": (filename, audio_bytes, "audio/wav" if filename.endswith(".wav") else "audio/webm")
        }
        data = {}
        if attempt_id:
            data["attempt_id"] = attempt_id
        if case_id:
            data["case_id"] = case_id
        if request_id:
            data["request_id"] = request_id

        with httpx.Client(timeout=self.timeout_sec) as client:
            resp = client.post(url, files=files, data=data, headers=self._auth_headers())
            if resp.status_code != 200:
                logger.error(f"MDD-LLM detect error {resp.status_code}: {resp.text}")
                raise RuntimeError(f"MDD-LLM detect error {resp.status_code}: {resp.text}")
            return resp.json()

    def diagnose_audio(
        self,
        audio_bytes: bytes,
        filename: str = "audio.wav",
        attempt_id: Optional[str] = None,
        case_id: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Calls CROTTC-IF Diagnosis Specialist on input audio.
        """
        url = f"{self.base_url}/v1/mdd/diagnose"
        files = {
            "file": (filename, audio_bytes, "audio/wav" if filename.endswith(".wav") else "audio/webm")
        }
        data = {}
        if attempt_id:
            data["attempt_id"] = attempt_id
        if case_id:
            data["case_id"] = case_id
        if request_id:
            data["request_id"] = request_id

        with httpx.Client(timeout=self.timeout_sec) as client:
            resp = client.post(url, files=files, data=data, headers=self._auth_headers())
            if resp.status_code != 200:
                logger.error(f"CROTTC-IF diagnose error {resp.status_code}: {resp.text}")
                raise RuntimeError(f"CROTTC-IF diagnose error {resp.status_code}: {resp.text}")
            return resp.json()

    def analyze_audio(
        self,
        audio_bytes: bytes,
        filename: str = "audio.wav",
        expected_text: Optional[str] = None,
        attempt_id: Optional[str] = None,
        case_id: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Backwards compatible analyze endpoint.
        """
        url = f"{self.base_url}/v1/mdd/analyze"
        files = {
            "file": (filename, audio_bytes, "audio/wav" if filename.endswith(".wav") else "audio/webm")
        }
        data = {}
        if expected_text:
            data["expected_text"] = expected_text
        if attempt_id:
            data["attempt_id"] = attempt_id
        if case_id:
            data["case_id"] = case_id
        if request_id:
            data["request_id"] = request_id

        with httpx.Client(timeout=self.timeout_sec) as client:
            resp = client.post(url, files=files, data=data, headers=self._auth_headers())
            if resp.status_code != 200:
                logger.error(f"mdd-service analyze error {resp.status_code}: {resp.text}")
                raise RuntimeError(f"mdd-service error {resp.status_code}: {resp.text}")
            return resp.json()
