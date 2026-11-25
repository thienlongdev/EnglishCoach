# DEPRECATED / NON-PRODUCTION LEGACY CPU SCAFFOLD:
# Production GPU deployments do NOT build this Dockerfile. They run the canonical GPU image
# (`englishcoach-ai-whisperx:echo-voice-repair-20261125`) via `deploy/ai/Dockerfile.gpu-echo`
# and `deploy/ai/docker-compose.gpu.yml`. See `ai-service/requirements.gpu-echo.lock.txt` for
# the exact pinned commercial-clean production GPU package stack.
# GPLv3+ `espeak-ng` and `phonemizer` have been removed (zero runtime dependency).
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN apt-get update && apt-get install -y libgl1 libglib2.0-0 ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir -r requirements.txt && pip install --no-cache-dir --no-deps whisperx==3.8.6
# Listening YouTube import: WhisperX's local transcription engine (faster-whisper on CTranslate2,
# CUDA 12 cuBLAS beside torch's CUDA 13) + the alignment model and sentence tokenizer baked in. No paid ASR.
RUN pip install --no-cache-dir --no-deps faster-whisper==1.2.1 ctranslate2==4.8.4 av==18.1.0 onnxruntime==1.31.1 nvidia-cublas-cu12==12.9.2.10
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.11/site-packages/nvidia/cublas/lib
RUN python -c "import torchaudio; torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H.get_model()" && python -c "import nltk; nltk.download('punkt_tab', quiet=True)"
COPY . .
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
