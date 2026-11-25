#!/usr/bin/env python3
"""
Python ASR Worker & YouTube Subtitle Extractor
Extracts word-level timestamps from YouTube audio using Whisper or YouTube Transcript API.
"""

import sys
import os
import json
import re
import argparse
from typing import Dict, List, Any, Optional

def extract_video_id(url: str) -> str:
    url = url.strip()
    if re.match(r"^[a-zA-Z0-9_-]{11}$", url):
        return url
    patterns = [
        r"(?:v=|\/)([0-9A-Za-z_-]{11}).*",
        r"(?:youtu\.be\/|embed\/|\/v\/|live\/|shorts\/)([0-9A-Za-z_-]{11})"
    ]
    for p in patterns:
        match = re.search(p, url)
        if match:
            return match.group(1)
    return url

def fetch_with_youtube_transcript_api(video_id: str) -> Optional[List[Dict[str, Any]]]:
    try:
        import youtube_transcript_api
        from youtube_transcript_api import YouTubeTranscriptApi
        
        raw_entries = None
        # Try instance fetch or class fetch (supports both v1.x and v0.x)
        try:
            raw_entries = YouTubeTranscriptApi().fetch(video_id)
        except Exception:
            try:
                raw_entries = YouTubeTranscriptApi.fetch(video_id)
            except Exception:
                try:
                    if hasattr(YouTubeTranscriptApi, 'get_transcript'):
                        raw_entries = YouTubeTranscriptApi.get_transcript(video_id)
                except Exception:
                    pass

        if raw_entries:
            segments = []
            for entry in raw_entries:
                # Support both FetchedTranscriptSnippet object and dict
                if hasattr(entry, 'text'):
                    text = getattr(entry, 'text', '')
                    start_sec = float(getattr(entry, 'start', 0.0))
                    dur_sec = float(getattr(entry, 'duration', 2.0))
                elif isinstance(entry, dict):
                    text = entry.get('text', '')
                    start_sec = float(entry.get('start', 0.0))
                    dur_sec = float(entry.get('duration', 2.0))
                else:
                    continue

                text = text.strip().replace('\n', ' ')
                if not text:
                    continue

                end_sec = start_sec + dur_sec
                words_list = text.split()
                w_dur = dur_sec / max(1, len(words_list))
                words = []
                for idx, w in enumerate(words_list):
                    words.append({
                        "word": w,
                        "start": round(start_sec + idx * w_dur, 2),
                        "end": round(start_sec + (idx + 1) * w_dur, 2)
                    })

                segments.append({
                    "startTimeMs": int(start_sec * 1000),
                    "endTimeMs": int(end_sec * 1000),
                    "speakerName": "Speaker",
                    "text": text,
                    "difficultyScore": 1.0,
                    "words": words
                })
            return segments
    except Exception as e:
        sys.stderr.write(f"youtube-transcript-api error: {e}\n")
    return None

def fetch_with_whisper_and_ytdlp(url: str, video_id: str) -> Optional[Dict[str, Any]]:
    try:
        import yt_dlp
        import whisper
        import tempfile

        with tempfile.TemporaryDirectory() as tmpdir:
            audio_path = os.path.join(tmpdir, f"{video_id}.mp3")
            ydl_opts = {
                'format': 'bestaudio/best',
                'outtmpl': os.path.join(tmpdir, f"{video_id}.%(ext)s"),
                'postprocessors': [{
                    'key': 'FFmpegExtractAudio',
                    'preferredcodec': 'mp3',
                    'preferredquality': '192',
                }],
                'quiet': True,
                'no_warnings': True,
            }

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
                title = info.get('title', f"YouTube Audio: {video_id}")
                duration = int(info.get('duration', 180))

            # Run whisper with word-level timestamps
            model = whisper.load_model("base")
            result = model.transcribe(audio_path, word_timestamps=True)

            segments = []
            for seg in result.get("segments", []):
                seg_words = []
                for w in seg.get("words", []):
                    seg_words.append({
                        "word": w.get("word", "").strip(),
                        "start": round(w.get("start", 0.0), 2),
                        "end": round(w.get("end", 0.0), 2)
                    })
                
                # If whisper word timestamps are empty for segment, split text
                if not seg_words and seg.get("text"):
                    words_split = seg.get("text", "").strip().split()
                    s_sec = seg.get("start", 0.0)
                    e_sec = seg.get("end", s_sec + 2.0)
                    w_d = (e_sec - s_sec) / max(1, len(words_split))
                    for i, w in enumerate(words_split):
                        seg_words.append({
                            "word": w,
                            "start": round(s_sec + i * w_d, 2),
                            "end": round(s_sec + (i + 1) * w_d, 2)
                        })

                segments.append({
                    "startTimeMs": int(seg.get("start", 0.0) * 1000),
                    "endTimeMs": int(seg.get("end", 0.0) * 1000),
                    "speakerName": "Speaker",
                    "text": seg.get("text", "").strip(),
                    "difficultyScore": 1.0,
                    "words": seg_words
                })

            return {
                "title": title,
                "durationSeconds": duration,
                "segments": segments
            }
    except Exception as e:
        sys.stderr.write(f"Whisper/yt-dlp error: {e}\n")
    return None

def fetch_title_and_duration_ytdlp(url: str, video_id: str) -> Dict[str, Any]:
    try:
        import yt_dlp
        ydl_opts = {'quiet': True, 'no_warnings': True}
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            return {
                "title": info.get('title', f"YouTube Audio: {video_id}"),
                "durationSeconds": int(info.get('duration', 180))
            }
    except Exception:
        return {
            "title": f"YouTube Audio: {video_id}",
            "durationSeconds": 180
        }

def process_youtube(url_or_id: str) -> Dict[str, Any]:
    video_id = extract_video_id(url_or_id)
    if not video_id:
        raise ValueError("Invalid YouTube URL or ID provided.")

    full_url = f"https://www.youtube.com/watch?v={video_id}"

    # 1. Try Whisper with yt-dlp first for deep word-level forced alignment
    whisper_res = fetch_with_whisper_and_ytdlp(full_url, video_id)
    if whisper_res and whisper_res.get("segments") and len(whisper_res["segments"]) > 0:
        return whisper_res

    # 2. Fallback to youtube-transcript-api
    yt_meta = fetch_title_and_duration_ytdlp(full_url, video_id)
    sub_segments = fetch_with_youtube_transcript_api(video_id)
    if sub_segments and len(sub_segments) > 0:
        return {
            "title": yt_meta.get("title", f"YouTube Audio: {video_id}"),
            "durationSeconds": yt_meta.get("durationSeconds", 180),
            "segments": sub_segments
        }

    # NO FAKE DATA: If extraction fails, raise an exception
    raise RuntimeError(f"Unable to extract ASR transcript or captions for YouTube video: {video_id}")

def main():
    parser = argparse.ArgumentParser(description="YouTube ASR and Subtitle Extractor")
    parser.add_argument("url", nargs="?", default="", help="YouTube URL or Video ID")
    parser.add_argument("--url", dest="url_opt", help="YouTube URL or Video ID")
    args = parser.parse_args()

    target_url = args.url_opt or args.url
    if not target_url:
        sys.stderr.write("Error: No YouTube URL or ID provided.\n")
        sys.exit(1)

    try:
        result = process_youtube(target_url)
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except Exception as e:
        sys.stderr.write(f"ASR Worker Failed: {e}\n")
        sys.exit(1)

if __name__ == "__main__":
    main()
