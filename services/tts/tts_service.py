# src/tts_service.py
"""Multi-provider TTS service — dispatches to local Kokoro, OpenAI-compatible API, or browser."""

import io
import os
import wave
import logging
import hashlib
import httpx
from pathlib import Path
from typing import Optional, Dict, Any

from src.constants import TTS_CACHE_DIR

logger = logging.getLogger(__name__)

# Built-in "kokoro" provider → the OpenAI-compatible Kokoro-FastAPI sidecar
# (docker/gpu.tts.yml), reachable over the compose network as http://tts:8880.
# This is the FUNCTIONAL local path in Docker: the in-container "local" provider
# is dead on Python 3.14 (kokoro==0.9.4 needs >=3.10,<3.13), so the sidecar is
# how Odysseus gets natural, multilingual (incl. Spanish) local TTS with no
# manual ModelEndpoint to hand-create. Override for non-Docker/custom deploys.
KOKORO_SIDECAR_URL = os.getenv("ODYSSEUS_TTS_SIDECAR_URL", "http://tts:8880/v1")


def _safe_speed(value, default: float = 1.0) -> float:
    """Parse the stored tts_speed defensively. The settings layer tolerates
    corrupt/agent-written config, so a non-numeric or empty value (e.g. an agent
    setting "speech speed" = "fast", or a hand-edited settings.json) must not
    crash synthesis or the stats endpoint with a ValueError."""
    try:
        speed = float(value)
    except (TypeError, ValueError):
        return default
    return speed if speed > 0 else default


class TTSService:
    """Multi-provider TTS service.

    Reads provider config from data/settings.json on each call.
    Providers:
      "disabled"        — no TTS
      "browser"         — client-side Web Speech API (no server synthesis)
      "kokoro"          — OpenAI-compatible Kokoro-FastAPI sidecar (default;
                          natural Spanish/multilingual, no ModelEndpoint needed)
      "local"           — in-process Kokoro-82M on GPU (native install only;
                          dead in the py3.14 Docker image → use "kokoro")
      "endpoint:<id>"   — OpenAI-compatible /audio/speech via ModelEndpoint
    """

    def __init__(self, cache_dir: str = TTS_CACHE_DIR):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._kokoro = None  # lazy-init
        
        try:
            self.max_cache_bytes = int(os.getenv("ODYSSEUS_TTS_CACHE_MAX_BYTES", 500 * 1024 * 1024))
        except ValueError:
            self.max_cache_bytes = 500 * 1024 * 1024

    # ── Settings ──

    def _load_settings(self) -> dict:
        from src.settings import load_settings
        saved = load_settings()
        return {
            "tts_enabled": saved.get("tts_enabled", True),
            "tts_provider": saved.get("tts_provider", "kokoro"),
            "tts_model": saved.get("tts_model", "kokoro"),
            "tts_voice": saved.get("tts_voice", "ef_dora"),
            "tts_speed": saved.get("tts_speed", "1"),
        }

    @property
    def available(self) -> bool:
        settings = self._load_settings()
        if settings.get("tts_enabled") is False:
            return False
        provider = settings["tts_provider"]
        if provider == "disabled":
            return False
        if provider == "browser":
            return True  # handled client-side
        if provider == "kokoro":
            return True  # sidecar assumed reachable; errors surface at synthesis
        if provider == "local":
            kokoro = self._get_kokoro()
            return kokoro is not None and kokoro.available
        if isinstance(provider, str) and provider.startswith("endpoint:"):
            return True  # assume reachable; errors surface at synthesis time
        return False

    # ── Cache ──

    def _cache_key(self, text: str, provider: str, model: str, voice: str, speed: float = 1.0) -> str:
        raw = f"{provider}|{model}|{voice}|{speed}|{text}"
        return hashlib.sha256(raw.encode()).hexdigest()

    def _get_cached(self, key: str) -> Optional[bytes]:
        for ext in (".mp3", ".wav"):
            path = self.cache_dir / f"{key}{ext}"
            if path.exists():
                return path.read_bytes()
        return None

    def _put_cache(self, key: str, data: bytes):
        ext = ".mp3" if (len(data) >= 3 and (data[:3] == b'ID3' or (data[0] == 0xff and (data[1] & 0xe0) == 0xe0))) else ".wav"
        (self.cache_dir / f"{key}{ext}").write_bytes(data)

        self._enforce_cache_limit()

    def _enforce_cache_limit(self):
            """Evicts oldest files if the cache exceeds the configured byte limit."""
            if self.max_cache_bytes <= 0:
                return

            try:
                files = []
                total_size = 0

                # Safely scan files and sum sizes, ignoring files deleted mid-scan
                for f in self.cache_dir.iterdir():
                    try:
                        if f.is_file() and f.suffix.lower() in (".mp3", ".wav"):
                            files.append(f)
                            total_size += f.stat().st_size
                    except OSError:
                        continue

                if total_size > self.max_cache_bytes:
                    logger.info(
                        f"TTS cache ({total_size} bytes) exceeded limit ({self.max_cache_bytes} bytes). Evicting oldest files."
                    )

                    # Sort files by modification time (oldest first)
                    try:
                        files.sort(key=lambda f: f.stat().st_mtime)
                    except OSError as e:
                        logger.warning(f"Failed to sort cache files by mtime: {e}")

                    # Trim down to 80% of max capacity
                    target_size = self.max_cache_bytes * 0.8

                    while files and total_size > target_size:
                        f = files.pop(0)
                        try:
                            size = f.stat().st_size
                            f.unlink()
                            total_size -= size
                        except OSError as e:
                            logger.warning(f"Failed to evict cache file {f}: {e}")
                            continue

            except Exception as e:
                logger.warning(f"Error enforcing TTS cache limit: {e}", exc_info=True)

    def clear_cache(self):
        count = 0
        for f in self.cache_dir.glob("*.*"):
            f.unlink()
            count += 1
        logger.info(f"Cleared {count} cached TTS files")

    # ── Kokoro (local) ──

    def _get_kokoro(self):
        if self._kokoro is None:
            self._kokoro = _KokoroPipeline()
        return self._kokoro

    # ── OpenAI-compatible /audio/speech (kokoro sidecar + endpoint providers) ──

    def _openai_speech_post(self, base_url: str, api_key: Optional[str], text: str,
                            model: str, voice: str, speed: float = 1.0) -> Optional[bytes]:
        """POST to an OpenAI-compatible /audio/speech endpoint. Shared by the
        built-in `kokoro` sidecar provider and the `endpoint:<id>` provider so
        the request contract never diverges between them."""
        url = base_url.rstrip("/") + "/audio/speech"
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        payload = {
            "model": model,
            "input": text,
            "voice": voice,
            "response_format": "mp3",
            "speed": speed,
        }

        try:
            r = httpx.post(url, json=payload, headers=headers, timeout=60)
            r.raise_for_status()
            logger.info(f"OpenAI-TTS: {len(r.content)} bytes from {url}")
            return r.content
        except Exception as e:
            logger.error(f"OpenAI-compatible TTS synthesis failed ({url}): {e}")
            return None

    def _synthesize_sidecar(self, text: str, model: str, voice: str, speed: float = 1.0) -> Optional[bytes]:
        """Built-in `kokoro` provider → the local Kokoro-FastAPI sidecar."""
        return self._openai_speech_post(
            KOKORO_SIDECAR_URL, None, text, model or "kokoro", voice or "ef_dora", speed
        )

    def _synthesize_api(self, text: str, endpoint_id: str, model: str, voice: str, speed: float = 1.0) -> Optional[bytes]:
        from src.database import SessionLocal, ModelEndpoint

        db = SessionLocal()
        try:
            ep = db.query(ModelEndpoint).filter(ModelEndpoint.id == endpoint_id).first()
            if not ep:
                logger.error(f"TTS endpoint {endpoint_id} not found")
                return None
            base_url = ep.base_url
            api_key = ep.api_key
        finally:
            db.close()

        return self._openai_speech_post(base_url, api_key, text, model, voice, speed)

    # ── Public interface ──

    def synthesize(self, text: str, use_cache: bool = True) -> Optional[bytes]:
        settings = self._load_settings()
        if settings.get("tts_enabled") is False:
            return None
        provider = settings["tts_provider"]
        model = settings["tts_model"]
        voice = settings["tts_voice"]
        speed = _safe_speed(settings.get("tts_speed", "1"))

        if provider in ("disabled", "browser"):
            return None

        if len(text) > 5000:
            text = text[:5000]

        if use_cache:
            key = self._cache_key(text, provider, model, voice, speed)
            cached = self._get_cached(key)
            if cached:
                logger.info(f"TTS cache hit ({len(text)} chars)")
                return cached

        audio_data = None

        if provider == "kokoro":
            audio_data = self._synthesize_sidecar(text, model, voice, speed)
        elif provider == "local":
            kokoro = self._get_kokoro()
            if kokoro and kokoro.available:
                audio_data = kokoro.synthesize_raw(text, voice)
            else:
                logger.warning("Kokoro TTS not available")
                return None
        elif provider.startswith("endpoint:"):
            endpoint_id = provider.split(":", 1)[1]
            audio_data = self._synthesize_api(text, endpoint_id, model, voice, speed)
        else:
            logger.error(f"Unknown TTS provider: {provider}")
            return None

        if audio_data and use_cache:
            key = self._cache_key(text, provider, model, voice, speed)
            self._put_cache(key, audio_data)

        return audio_data

    def synthesize_to_base64(self, text: str) -> Optional[str]:
        import base64
        audio = self.synthesize(text)
        if audio:
            return base64.b64encode(audio).decode("utf-8")
        return None

    def set_voice(self, voice: str):
        """Legacy no-op — voice is now managed via admin settings."""

    def get_stats(self) -> Dict[str, Any]:
        settings = self._load_settings()
        provider = settings["tts_provider"]
        tts_enabled = settings.get("tts_enabled", True)

        cache_files = list(self.cache_dir.glob("*.wav")) + list(self.cache_dir.glob("*.mp3"))
        cache_size = sum(f.stat().st_size for f in cache_files)

        is_available = self.available and tts_enabled
        stats = {
            "available": is_available,
            "ready": is_available,
            "provider": provider,
            "model": settings["tts_model"],
            "voice": settings["tts_voice"],
            "speed": _safe_speed(settings.get("tts_speed", "1")),
            "cache_entries": len(cache_files),
            "cache_size_mb": round(cache_size / (1024 * 1024), 2),
        }

        if provider == "kokoro":
            stats["model"] = "Kokoro-FastAPI (local sidecar)"
            stats["sidecar_url"] = KOKORO_SIDECAR_URL
        elif provider == "local":
            kokoro = self._get_kokoro()
            stats["model"] = "Kokoro-82M (GPU)" if (kokoro and kokoro.available) else "Kokoro (not loaded)"
        elif provider == "browser":
            stats["model"] = "Browser (Web Speech API)"
        elif provider.startswith("endpoint:"):
            stats["endpoint_id"] = provider.split(":", 1)[1]

        return stats


# Kokoro voice-name prefix → G2P language code. The FIRST letter of a Kokoro
# voice id selects the phonemizer/prosody language; the SECOND is gender.
# Running Spanish text ("ef_dora") through the English G2P ("a") is exactly what
# made local TTS sound robotic/mispronounced — the pipeline MUST match the voice.
# Ref: hexgrad/Kokoro-82M voice list.
_KOKORO_LANG_BY_PREFIX = {
    "a": "a",  # American English
    "b": "b",  # British English
    "e": "e",  # Spanish (es)   → ef_dora, em_alex, em_santa
    "f": "f",  # French (fr-fr)
    "h": "h",  # Hindi
    "i": "i",  # Italian
    "j": "j",  # Japanese
    "p": "p",  # Brazilian Portuguese
    "z": "z",  # Mandarin Chinese
}


def _lang_code_for_voice(voice: str) -> str:
    """Pick the Kokoro G2P language from the voice id's first letter."""
    if voice and voice[0] in _KOKORO_LANG_BY_PREFIX:
        return _KOKORO_LANG_BY_PREFIX[voice[0]]
    return "a"  # safe default: American English


class _KokoroPipeline:
    """Encapsulates the Kokoro-82M local pipeline (GPU when available, CPU fallback).

    Kokoro binds ONE G2P language per KPipeline instance, so we keep a lazily
    built pipeline PER language code and route each request by its voice prefix.
    This is what makes Spanish ("e") actually sound Spanish instead of English
    phonemes forced onto Spanish words.
    """

    def __init__(self):
        self.available = False
        self.device = None
        self._use_cuda = False
        self._pipelines: Dict[str, Any] = {}  # lang_code -> KPipeline
        self._init()

    def _init(self):
        try:
            import torch
            from kokoro import KPipeline  # noqa: F401  (import-availability probe)

            self._use_cuda = torch.cuda.is_available()
            if self._use_cuda:
                self.device = torch.device("cuda:0")
                logger.info("Kokoro-82M TTS: CUDA available (GPU)")
            else:
                self.device = torch.device("cpu")
                logger.info("Kokoro-82M TTS: no CUDA, running on CPU")
            # Warm the default English pipeline so `available` reflects real state.
            self._get_pipeline("a")
            self.available = True
            logger.info("Kokoro-82M TTS pipeline ready")
        except ImportError as e:
            logger.warning(f"Kokoro TTS not available: {e}")
            logger.warning("Install with: pip install kokoro soundfile (Python 3.11-3.12)")
        except Exception as e:
            logger.error(f"Kokoro init failed: {e}", exc_info=True)

    def _get_pipeline(self, lang_code: str):
        """Lazily build (and cache) a KPipeline for a G2P language code."""
        pipe = self._pipelines.get(lang_code)
        if pipe is not None:
            return pipe
        import torch
        from kokoro import KPipeline

        if self._use_cuda:
            with torch.cuda.device(0):
                pipe = KPipeline(lang_code=lang_code)
                if hasattr(pipe, "model") and pipe.model is not None:
                    pipe.model = pipe.model.to(self.device)
        else:
            pipe = KPipeline(lang_code=lang_code)
        self._pipelines[lang_code] = pipe
        logger.info(f"Kokoro pipeline built for lang_code='{lang_code}'")
        return pipe

    def synthesize_raw(self, text: str, voice: str = "af_heart") -> Optional[bytes]:
        if not self.available:
            return None
        try:
            import numpy as np
            import torch

            lang_code = _lang_code_for_voice(voice)
            pipeline = self._get_pipeline(lang_code)

            def _run():
                chunks = []
                for _, _, audio in pipeline(text, voice=voice):
                    chunks.append(audio)
                return chunks

            if self._use_cuda:
                with torch.cuda.device(self.device):
                    chunks = _run()
            else:
                chunks = _run()

            if not chunks:
                return None

            full = np.concatenate(chunks)
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(24000)
                wf.writeframes((full * 32767).astype(np.int16).tobytes())
            return buf.getvalue()
        except Exception as e:
            logger.error(f"Kokoro synthesis failed: {e}", exc_info=True)
            return None


# Module-level singleton
_tts_service = None

def get_tts_service() -> TTSService:
    global _tts_service
    if _tts_service is None:
        _tts_service = TTSService()
    return _tts_service
