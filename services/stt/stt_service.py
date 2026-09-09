# services/stt/stt_service.py
"""Multi-provider Speech-to-Text service — dispatches to local Whisper, OpenAI-compatible API, or browser."""

import io
import logging
import os
import re
import unicodedata
import httpx
import tempfile
from pathlib import Path
from typing import Optional, Dict, Any

# Model / language / glossary defaults are DEFINED in src/constants.py and only
# re-exported here, so the names this module and its tests already use keep
# working. They are not redeclared: this module's copy is not the one the
# decoder ends up seeing (DEFAULT_SETTINGS wins, see the note over there), so a
# second literal here can only rot into a fix that never ships — which is
# precisely what happened to the initial_prompt.
from src.constants import (
    DEFAULT_STT_MODEL,
    DEFAULT_STT_LANGUAGE,
    DEFAULT_STT_INITIAL_PROMPT,
)
from services.stt.transcript_cleaner import (
    DEFAULT_CLEAN_ENABLED,
    DEFAULT_CLEAN_LLM_ENABLED,
    DEFAULT_CLEAN_LLM_MODEL,
    DEFAULT_CLEAN_LLM_TIMEOUT_MS,
    clean_transcript,
    record_edit_pair,
)

logger = logging.getLogger(__name__)

# ── Local Whisper (faster-whisper) tuning ──
#
# Recipe from the 2026-09-06 diagnosis (see data/stt-instrucciones.md): dictation
# is short Spanish clips with English tech jargon mixed in, and language
# autodetection on ~3s clips picks "en" about as often as a coin flip, which
# turns the whole clip into phonetic English ("to the boss"). So: language is
# always pinned, never autodetected.
#
# faster-whisper truncates initial_prompt at ~224 tokens silently; cap the
# configurable value well under any pathological input.
MAX_INITIAL_PROMPT_CHARS = 1000

# ── VAD (Silero) — LA palanca, con un orden de magnitud de diferencia ──
#
# Barański et al., ICASSP 2025 (arXiv 2501.11378), Tabla VII: sobre 301,317
# archivos de no-habla con large-v3, encender SileroVAD lleva el WER de 104.8% a
# 8.0% y la tasa de alucinación de 21.3% a 0.2%. Ninguna otra intervención se le
# acerca (hallucination_silence_threshold=20 → 39.8%; WebRTC VAD → 68.3%;
# beam_size=1 → 107.2%, PEOR que no hacer nada). [MEDIDO]
#
# Los defaults de faster-whisper están calibrados para audio largo tipo podcast,
# no para dictado push-to-talk de 2–30 s:
#   · min_silence_duration_ms: fw default 2000. Dos segundos de silencio no
#     ocurren dentro de un dictado corto, así que el VAD nunca cerraría un chunk
#     y la cola con ruido bajo llega entera al decoder → 300.
#   · min_speech_duration_ms: fw default 0, o sea que un clic, una respiración o
#     un golpe de mesa de 40 ms CUENTA como voz, pasa al decoder, y el decoder
#     rellena ese "habla" con lo más probable de su corpus: la despedida de
#     YouTube. Es exactamente la vía por la que entra el "¡Gracias!" → 150.
#   · speech_pad_ms: aquí nos SEPARAMOS de la recomendación publicada (200) y
#     conservamos 400 a propósito. El 200 del estudio es [INFERIDO] —el paper
#     mide VAD sí/no, no barre parámetros—, mientras que nuestro 400 salió de un
#     fallo REAL observado el 2026-09-06: con el pad corto se comía el arranque
#     de la frase, que es justo donde Whisper pierde el hilo y empieza a
#     inventar. Evidencia local medida > recomendación inferida.
#
# El 250 de min_speech_duration_ms NO es un número inventado: es el que usa una
# app de dictado en producción con Silero v5.1.2. Su juego completo es
# threshold=0.50 · min_speech=250 · min_silence=100 · speech_pad=30. Adoptamos el
# min_speech tal cual (no teníamos contra-evidencia local y ataca justo el blip
# que se vuelve "¡Gracias!"), pero NO el par min_silence=100 / speech_pad=30:
# ésos son un conjunto coherente entre sí —cortar agresivo con padding mínimo— y
# mezclarlos con nuestro pad de 400 daría una combinación que nadie ha probado.
# Cambiarlos exige medirlos dictando; queda anotado como el A/B siguiente.
DEFAULT_VAD_MIN_SILENCE_MS = 300
DEFAULT_VAD_SPEECH_PAD_MS = 400
DEFAULT_VAD_MIN_SPEECH_MS = 250

# ── Umbrales del decoder: se dejan en su DEFAULT, y eso es una decisión ──
#
# Se dejan clavados aquí (no se heredan en silencio) para que un cambio de
# default upstream no nos mueva el piso sin que nadie se entere — pero los
# valores son EXACTAMENTE los de faster-whisper, y NO se tunean. La razón:
#
# Radford et al. §4.5 reporta haberlos ajustado él mismo a 0.6 / −1.0 / 2.4
# [OFICIAL]. Y —esto es lo decisivo para el "¡Gracias!"— son estructuralmente
# INCAPACES de atraparlo: la compuerta de no-habla exige que P(<|nospeech|>)
# supere 0.6 **Y** que el decoding haya fallado por log_prob_threshold. Una
# alucinación corta y CONFIADA como "Gracias." tiene log-prob alta y ratio de
# compresión bajo, así que pasa las tres compuertas. Caso reportado con
# no_speech_prob de 0.877 y 0.977 devolviendo igual subtítulos inventados:
# https://github.com/SYSTRAN/faster-whisper/issues/621
#
# → Tunearlos es el camino equivocado para este fallo. La solución es el VAD de
#   arriba (pre-decoder) + la bag-of-hallucinations de filter_degenerate_text
#   (post-decoder). Juntos: 0.0% de alucinación y mejor WER que cualquiera solo
#   (Tabla VII: VAD 8.0% / post-filtro 17.1% / los dos 6.5%). [MEDIDO]
#
# La escalera de temperatura sí se mantiene: sin más de una temperatura los
# umbrales no tienen a qué reintentar y quedan inertes. El primer paso sigue
# siendo greedy (0.0), así que un clip limpio decodifica determinista.
DEFAULT_NO_SPEECH_THRESHOLD = 0.6
DEFAULT_LOG_PROB_THRESHOLD = -1.0
DEFAULT_COMPRESSION_RATIO_THRESHOLD = 2.4
DEFAULT_TEMPERATURE_LADDER = (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)

# hallucination_silence_threshold se queda en None A PROPÓSITO: en faster-whisper
# exige word_timestamps=True (es código muerto sin él — transcribe.py:1277/1293) y
# salta silencios MÁS LARGOS que el umbral. Barański lo mide con umbral 20 s:
# alucinación 21.3% → 14.7%, muy por debajo del VAD. En clips de dictado de 2–30 s
# un umbral así casi nunca dispara, y word_timestamps cuesta latencia en un camino
# interactivo. [MEDIDO + INFERIDO]
DEFAULT_HALLUCINATION_SILENCE_THRESHOLD = None

# Whisper model sizes accepted for the per-request model override. WhisperModel
# treats any unknown string as a HuggingFace repo id and will happily download
# it, so an unvalidated override would be a remote-fetch primitive on a route
# that only needs to pick between local models. The configured global model is
# always allowed on top of this list (an operator may legitimately point
# stt_model at a custom CT2 repo; a *request* may not).
ALLOWED_LOCAL_MODELS = frozenset({
    "tiny", "tiny.en",
    "base", "base.en",
    "small", "small.en",
    "medium", "medium.en",
    "large-v1", "large-v2", "large-v3", "large",
    "large-v3-turbo", "turbo",
    "distil-large-v2", "distil-large-v3", "distil-small.en", "distil-medium.en",
})

# Whisper language codes are ISO 639-1/639-3 style, lowercase, no region suffix
# ("es", not "es-MX" — faster-whisper raises on the latter).
_LANGUAGE_RE = re.compile(r"^[a-z]{2,3}$")


def _as_bool(value: Any, default: bool) -> bool:
    """Coerce a settings/form value to bool without surprises.

    Settings arrive from JSON (real bools) but request overrides arrive from
    multipart form fields (strings), so "false"/"0"/"off" must not read as True.
    """
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off"):
        return False
    return default


def _as_int(value: Any, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(int(value), hi))
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float, lo: float, hi: float) -> float:
    try:
        return max(lo, min(float(value), hi))
    except (TypeError, ValueError):
        return default


_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?…])\s+|\n+")
_WORD_RE = re.compile(r"[\wáéíóúüñ]+", re.IGNORECASE)


def _normalize(text: str) -> str:
    return " ".join(_WORD_RE.findall(text.lower()))


def _fold(text: str) -> str:
    """Como `_normalize` pero SIN acentos, para comparar contra listas escritas en ASCII.

    `_normalize` conserva la tilde a propósito (el resto del filtro compara frases entre sí, donde la tilde
    es señal legítima). Aquí sí molesta: una lista de cierres tendría que escribirse dos veces, con y sin
    acento, y cualquiera que la extienda olvidaría una de las dos.
    """
    normalizado = unicodedata.normalize("NFD", _normalize(text))
    return "".join(c for c in normalizado if unicodedata.category(c) != "Mn")


# Cierres de audio que Whisper añade SOLO por haber aprendido de subtítulos: el clip termina, el decoder
# sigue un token más y estampa la despedida del corpus. Se observó en vivo el 2026-09-08 con el trabalenguas
# de QA, que salió completo y correcto y luego traía un "¡Gracias!" pegado que nadie dijo.
#
# Van por LISTA y no por las dos firmas del filtro de abajo porque no tienen ninguna: aparecen UNA vez (no
# son un loop) y son demasiado cortas para el test de solape con el prompt (que exige ≥4 palabras).
#
# Se comparan con los acentos PLEGADOS (ver `_fold`): `_normalize` pasa a minúsculas pero conserva la tilde,
# así que "suscríbete" nunca habría casado con una lista escrita sin ella — el primer intento de esto se
# comía el "¡Gracias!" y dejaba pasar el "¡Suscríbete al canal!" justo por eso.
_CLOSING_HALLUCINATIONS = frozenset({
    "gracias",
    "muchas gracias",
    "gracias por ver el video",
    "gracias por ver",
    "gracias por su atencion",
    "suscribete al canal",
    "suscribete",
    "no olvides suscribirte",
    "activa la campanita",
    "hasta la proxima",
    "nos vemos en el proximo video",
    "nos vemos",
    "nos vemos pronto",
    "adios",
    "subtitulos realizados por la comunidad de amara org",
    "subtitulado por la comunidad de amara org",
    "mas informacion en www carrefour es",
    "gracias por ver este video",
    "gracias por acompanarnos",
    "un saludo",
})


def filter_degenerate_text(text: str, initial_prompt: str = "") -> str:
    """Drop Whisper's silence hallucinations before they reach the composer.

    Two signatures, both observed live on 2026-09-07 with a mic left open:

    * **Prompt echo** — with nothing to transcribe the decoder completes its own
      initial_prompt ("Términos frecuentes en español de México.", over and over).
    * **Stock-phrase loops** — the YouTube-subtitle artifacts Whisper learned
      ("¡Gracias por ver el video!", "¡Suscríbete al canal!"), repeated dozens of
      times.

    Both are recognizable without the audio: a sentence whose words are almost
    all drawn from the prompt, or a sentence repeated verbatim inside a single
    ~3.5s clip (which cannot physically hold the same sentence twice). When most
    of the clip is that kind of junk the whole thing is treated as no-speech and
    dropped, which sweeps up the one-offs riding along with the loop. A real
    dictation clip has neither signature, so nothing is removed from it.
    """
    if not text or not text.strip():
        return ""

    sentences = [s.strip() for s in _SENTENCE_SPLIT_RE.split(text) if s.strip()]
    if not sentences:
        return ""

    prompt_words = set(_normalize(initial_prompt).split())
    counts: Dict[str, int] = {}
    for sentence in sentences:
        key = _normalize(sentence)
        counts[key] = counts.get(key, 0) + 1

    kept = []
    dropped = 0
    for sentence in sentences:
        key = _normalize(sentence)
        words = key.split()

        # The same sentence twice in one short clip is a decoder loop, not
        # speech — a distinct sentence repeated for emphasis ("No, no. No
        # entendí.") does not collide, because the sentences differ.
        if counts.get(key, 0) >= 2:
            dropped += 1
            continue

        # Prompt echo: ≥4 words and almost all of them come from the prompt.
        if prompt_words and len(words) >= 4:
            overlap = sum(1 for w in words if w in prompt_words) / len(words)
            if overlap >= 0.8:
                dropped += 1
                continue

        kept.append(sentence)

    # Cierre de subtítulo pegado al final. Se aplica con dos candados a propósito:
    #   · solo la ÚLTIMA frase — un "gracias" en medio de un dictado es habla real;
    #   · solo si queda algo MÁS — así un clip cuyo único contenido es "Gracias" (alguien que de verdad
    #     quiso dictar eso) se conserva entero. El precio, explícito: si terminas un dictado real diciendo
    #     "gracias" y nada más después, se pierde esa palabra. Se acepta porque el artefacto aparece en
    #     CADA clip y la despedida deliberada es rara; si estorba, esta lista es el único sitio que tocar.
    # NO se suma a `dropped`: ese contador alimenta la regla de "si el clip era casi todo basura, lo que
    # queda también lo es", pensada para los LOOPS del decoder. Una frase real más una despedida de
    # subtítulo no es un clip basura — sumarlo ahí hacía que "Revisa el commit. ¡Gracias!" devolviera
    # cadena VACÍA y se perdiera el dictado entero, que es peor que el artefacto que se quería quitar.
    while len(kept) >= 2 and _fold(kept[-1]) in _CLOSING_HALLUCINATIONS:
        kept.pop()

    if not kept:
        return ""

    # If the clip was mostly junk, the leftovers are junk too (the one-off
    # "Gracias por su atención." riding along with the loop).
    if dropped and dropped >= len(sentences) / 2:
        return ""

    return " ".join(kept)


def sanitize_overrides(raw: Optional[Dict[str, Any]], *, allowed_model: str = "") -> Dict[str, Any]:
    """Validate a per-request override bundle, dropping anything unusable.

    Anything invalid is dropped (not raised on): an override is a convenience,
    and a bad one must never fail a transcription that the global config could
    have served. Returns only the keys that survived validation, so callers can
    distinguish "not requested" from "requested and empty".
    """
    if not raw:
        return {}
    clean: Dict[str, Any] = {}

    language = raw.get("language")
    if language:
        language = str(language).strip().lower()
        if _LANGUAGE_RE.match(language):
            clean["language"] = language
        else:
            logger.warning(f"STT override: ignoring invalid language {language!r}")

    model = raw.get("model")
    if model:
        model = str(model).strip()
        if model in ALLOWED_LOCAL_MODELS or (allowed_model and model == allowed_model):
            clean["model"] = model
        else:
            logger.warning(f"STT override: ignoring non-allowlisted model {model!r}")

    initial_prompt = raw.get("initial_prompt")
    if initial_prompt is not None:
        # An explicitly empty prompt is meaningful ("no glossary for this clip").
        clean["initial_prompt"] = str(initial_prompt)[:MAX_INITIAL_PROMPT_CHARS]

    vad_filter = raw.get("vad_filter")
    if vad_filter is not None and vad_filter != "":
        clean["vad_filter"] = _as_bool(vad_filter, True)

    return clean


def build_local_transcribe_kwargs(
    settings: Dict[str, Any],
    overrides: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build the kwargs handed to faster-whisper's ``model.transcribe``.

    Pure function on purpose: it is the whole contract between our settings and
    the library, and it can be asserted on without faster-whisper installed.
    Precedence is request override → saved setting → module default; an
    override never mutates or persists the global config.
    """
    overrides = overrides or {}

    language = overrides.get("language") or settings.get("stt_language") or DEFAULT_STT_LANGUAGE

    if "initial_prompt" in overrides:
        initial_prompt = overrides["initial_prompt"]
    else:
        initial_prompt = settings.get("stt_initial_prompt")
        if initial_prompt is None:
            initial_prompt = DEFAULT_STT_INITIAL_PROMPT

    vad_filter = _as_bool(
        overrides.get("vad_filter", settings.get("stt_vad_filter")),
        True,
    )

    kwargs: Dict[str, Any] = {
        # language is ALWAYS pinned — never autodetection: on short clips
        # (<2-3s) Whisper detects English and returns garbage ("to the boss").
        "language": language,
        "task": "transcribe",                 # never "translate"
        "condition_on_previous_text": False,  # no dragging hallucinations/loops
        # Greedy first pass, then the fallback ladder — see the anti-hallucination
        # note above: without more than one temperature the thresholds below can
        # never fire.
        "temperature": list(DEFAULT_TEMPERATURE_LADDER),
        "no_speech_threshold": _as_float(
            settings.get("stt_no_speech_threshold"), DEFAULT_NO_SPEECH_THRESHOLD, 0.0, 1.0
        ),
        "log_prob_threshold": DEFAULT_LOG_PROB_THRESHOLD,
        "compression_ratio_threshold": DEFAULT_COMPRESSION_RATIO_THRESHOLD,
        "vad_filter": vad_filter,
    }

    if initial_prompt:
        kwargs["initial_prompt"] = initial_prompt

    if vad_filter:
        vad_parameters: Dict[str, Any] = {
            "min_silence_duration_ms": _as_int(
                settings.get("stt_vad_min_silence_ms"), DEFAULT_VAD_MIN_SILENCE_MS, 0, 10000
            ),
            "speech_pad_ms": _as_int(
                settings.get("stt_vad_speech_pad_ms"), DEFAULT_VAD_SPEECH_PAD_MS, 0, 5000
            ),
            # Descarta clics, respiraciones y golpes sueltos ANTES del decoder:
            # con el default 0 de faster-whisper, un blip de 40 ms cuenta como
            # voz y el decoder lo rellena con la despedida de subtítulos. Ver la
            # nota de VAD arriba.
            "min_speech_duration_ms": _as_int(
                settings.get("stt_vad_min_speech_ms"), DEFAULT_VAD_MIN_SPEECH_MS, 0, 5000
            ),
        }
        # Silero's speech probability threshold. Left unset by default so the
        # library default (0.5) applies; lower it if a quiet phone mic gets its
        # speech filtered out entirely (see the 0-chars note in get_stats docs).
        threshold = settings.get("stt_vad_threshold")
        if threshold not in (None, ""):
            try:
                vad_parameters["threshold"] = max(0.0, min(float(threshold), 1.0))
            except (TypeError, ValueError):
                logger.warning(f"STT: ignoring invalid stt_vad_threshold {threshold!r}")
        kwargs["vad_parameters"] = vad_parameters

    return kwargs


class STTService:
    """Multi-provider STT service.

    Reads provider config from data/settings.json on each call.
    Providers:
      "disabled"        — no STT
      "browser"         — client-side Web Speech API (no server transcription)
      "local"           — faster-whisper on CPU/GPU
      "endpoint:<id>"   — OpenAI-compatible /audio/transcriptions via ModelEndpoint
    """

    def __init__(self):
        # Loaded models, keyed by model size. The configured model is loaded
        # once and stays resident; a per-request model override loads a second
        # one lazily (and keeps it — reloading a large model per request would
        # cost seconds). Each large-v3-class model is ~1.5GB in int8, so an
        # override is a deliberate act, not something the UI does per clip.
        self._whisper_models: Dict[str, Any] = {}

    # ── Settings ──

    def _load_settings(self) -> dict:
        from src.settings import load_settings
        saved = load_settings()
        return {
            "stt_enabled": saved.get("stt_enabled", False),
            "stt_provider": saved.get("stt_provider", "disabled"),
            "stt_model": saved.get("stt_model", DEFAULT_STT_MODEL),
            "stt_language": saved.get("stt_language", DEFAULT_STT_LANGUAGE),
            "stt_initial_prompt": saved.get("stt_initial_prompt", DEFAULT_STT_INITIAL_PROMPT),
            "stt_vad_filter": saved.get("stt_vad_filter", True),
            "stt_vad_min_silence_ms": saved.get("stt_vad_min_silence_ms", DEFAULT_VAD_MIN_SILENCE_MS),
            "stt_vad_speech_pad_ms": saved.get("stt_vad_speech_pad_ms", DEFAULT_VAD_SPEECH_PAD_MS),
            "stt_vad_threshold": saved.get("stt_vad_threshold", ""),
            "stt_no_speech_threshold": saved.get("stt_no_speech_threshold", DEFAULT_NO_SPEECH_THRESHOLD),
            "stt_vad_min_speech_ms": saved.get("stt_vad_min_speech_ms", DEFAULT_VAD_MIN_SPEECH_MS),
            "stt_clean_enabled": saved.get("stt_clean_enabled", DEFAULT_CLEAN_ENABLED),
            "stt_clean_llm_enabled": saved.get("stt_clean_llm_enabled", DEFAULT_CLEAN_LLM_ENABLED),
            "stt_clean_llm_model": saved.get("stt_clean_llm_model", DEFAULT_CLEAN_LLM_MODEL),
            "stt_clean_llm_timeout_ms": saved.get(
                "stt_clean_llm_timeout_ms", DEFAULT_CLEAN_LLM_TIMEOUT_MS
            ),
        }

    @property
    def available(self) -> bool:
        settings = self._load_settings()
        if settings.get("stt_enabled") is False:
            return False
        provider = settings["stt_provider"]
        if provider == "disabled":
            return False
        if provider == "browser":
            return True  # handled client-side
        if provider == "local":
            return self._get_whisper() is not None
        if provider.startswith("endpoint:"):
            return True  # assume reachable
        return False

    # ── Local Whisper ──

    def _get_whisper(self, model_size: Optional[str] = None):
        """Return the loaded WhisperModel for ``model_size`` (default: configured).

        Called with no arguments on the hot path, which keeps it patchable as a
        zero-arg callable in existing tests; a per-request model override passes
        the size explicitly.
        """
        if not model_size:
            model_size = self._load_settings().get("stt_model") or DEFAULT_STT_MODEL
        cached = self._whisper_models.get(model_size)
        if cached is not None:
            return cached

        try:
            from faster_whisper import WhisperModel
        except ImportError:
            logger.warning("faster-whisper not installed. Install with: pip install faster-whisper")
            return None
        try:
            # faster-whisper runs on CTranslate2, not torch. torch is only
            # used (optionally) to detect a CUDA device for acceleration —
            # if it's missing or unusable we just run on CPU. Keeping this
            # probe separate (and tolerant of any failure, e.g. a broken
            # CUDA/torch install that raises OSError on import) means a
            # torch-less or torch-broken machine still does CPU
            # transcription instead of failing with a misleading
            # "faster-whisper not installed" error.
            try:
                import torch
                use_cuda = torch.cuda.is_available()
            except Exception:
                use_cuda = False
            device = "cuda" if use_cuda else "cpu"
            compute_type = "float16" if device == "cuda" else "int8"
            # CTranslate2's own intra-op thread pool (NOT the same knob as
            # torch/OMP — CTranslate2 ignores OMP_NUM_THREADS for its own
            # ops). 0 = CTranslate2 auto-picks (usually all cores), which
            # can starve the FastAPI event loop / other CPU work in this
            # same process (Kokoro's in-process pipeline, DB, etc). Pin it
            # explicitly so a transcribe() call stays fast without
            # hogging every core. Override with ODYSSEUS_STT_CPU_THREADS.
            cpu_threads = int(os.getenv("ODYSSEUS_STT_CPU_THREADS", "16"))
            model = WhisperModel(
                model_size,
                device=device,
                compute_type=compute_type,
                cpu_threads=cpu_threads if device == "cpu" else 0,
                num_workers=1,
            )
            logger.info(
                f"faster-whisper model '{model_size}' loaded on {device} "
                f"(cpu_threads={cpu_threads if device == 'cpu' else 'n/a'})"
            )
        except Exception as e:
            logger.error(f"Failed to load whisper model '{model_size}': {e}")
            return None
        self._whisper_models[model_size] = model
        return model

    def preload(self) -> bool:
        """Eagerly load (and keep resident) the local Whisper model.

        Called once from app startup so the model is already warm in RAM
        before the first real /api/stt/transcribe request — without this,
        the model loads lazily on that first request, adding several
        seconds of cold-start latency to whatever the user was doing at
        that moment. A no-op (returns False) unless STT is enabled AND the
        provider is "local" — the API/browser providers have nothing to
        preload. Safe to call from a background thread (blocking I/O +
        CPU work, same as the lazy path it replaces); once loaded, the
        model stays resident in this singleton instance (module-level
        `_stt_service`) for the life of the process — no repeated loads.
        """
        settings = self._load_settings()
        if settings.get("stt_enabled") is False:
            return False
        if settings.get("stt_provider") != "local":
            return False
        return self._get_whisper() is not None

    def _transcribe_local(
        self,
        audio_bytes: bytes,
        language: str = "",
        settings: Optional[Dict[str, Any]] = None,
        overrides: Optional[Dict[str, Any]] = None,
    ) -> Optional[str]:
        """Transcribe with the local faster-whisper model.

        ``settings`` is the already-loaded settings dict (the caller has it);
        ``overrides`` is the sanitized per-request bundle. Both are optional so
        the legacy two-argument call still works unchanged.
        """
        overrides = overrides or {}
        if settings is None:
            settings = self._load_settings()
        if language:
            # Legacy positional arg: the caller already resolved the language.
            settings = {**settings, "stt_language": language}

        model_override = overrides.get("model")
        # Called with no args unless a model override is in play, so a zero-arg
        # patched _get_whisper (existing tests) keeps working.
        model = self._get_whisper(model_override) if model_override else self._get_whisper()
        if not model:
            return None
        tmp_path = None
        try:
            # Write to temp file (faster-whisper needs a file path or file-like)
            with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
                tmp.write(audio_bytes)
                tmp_path = tmp.name

            # Recipe validated in the 2026-09-06 diagnosis: the three knobs that
            # actually move the needle against "to the boss" are the pinned
            # language, VAD with a generous speech_pad, and
            # condition_on_previous_text=False. See build_local_transcribe_kwargs.
            kwargs = build_local_transcribe_kwargs(settings, overrides)

            segments, info = model.transcribe(tmp_path, **kwargs)
            raw_text = " ".join(seg.text.strip() for seg in segments)
            text = filter_degenerate_text(raw_text, kwargs.get("initial_prompt", ""))

            # Post-proceso, en este orden a propósito: la alucinación NUNCA debe
            # llegar al limpiador. El VAD la para antes del decoder y la
            # bag-of-hallucinations de arriba barre lo que se le escapó; sólo
            # entonces se limpian muletillas y "..." de pausa. El limpiador
            # DEGRADA a lo que recibió si algo falla — nunca rompe el dictado.
            cleaned = clean_transcript(text, settings)
            if cleaned != text:
                logger.info(f"STT cleaner: {len(text)} -> {len(cleaned)} chars")
                record_edit_pair(text, cleaned)
            text = cleaned

            # duration_after_vad tells apart the two very different reasons a
            # clip comes back empty: VAD ate all of it (silence — expected for
            # the continuous 3.5s segments the composer mic records while the
            # user isn't talking) vs the model genuinely produced nothing.
            duration = getattr(info, "duration", None)
            after_vad = getattr(info, "duration_after_vad", None)
            detail = f"lang={info.language}, prob={info.language_probability:.2f}"
            if duration is not None:
                detail += f", dur={duration:.2f}s"
            if after_vad is not None and after_vad != duration:
                detail += f", after_vad={after_vad:.2f}s"
            if text != raw_text:
                logger.info(
                    f"Local STT: dropped hallucinated output ({len(raw_text)} chars) — {raw_text[:120]!r}"
                )
            if not text and kwargs.get("vad_filter") and after_vad is not None and after_vad <= 0.0:
                logger.info(f"Local STT: no speech (VAD removed all audio), {detail}")
            else:
                logger.info(f"Local STT: {len(text)} chars, {detail}")
            self._save_debug_audio(audio_bytes, text, duration, after_vad)
            return text
        except Exception as e:
            logger.error(f"Local STT transcription failed: {e}", exc_info=True)
            return None
        finally:
            if tmp_path:
                Path(tmp_path).unlink(missing_ok=True)

    def _save_debug_audio(self, audio_bytes: bytes, text: str, duration, after_vad) -> None:
        """Dump the received clip so it can actually be listened to.

        Off unless ODYSSEUS_STT_DEBUG_DIR is set. This exists because the one
        question no parameter can answer from a log line is "did the audio ever
        contain the words?" — e.g. a dictation that comes back missing its first
        two seconds is either a capture problem (the browser never recorded
        them) or a decode problem, and only the clip itself tells them apart.
        Writes the raw upload (a .webm as the browser encoded it) plus a .txt
        with what came out.
        """
        debug_dir = os.getenv("ODYSSEUS_STT_DEBUG_DIR", "").strip()
        if not debug_dir:
            return
        try:
            import time
            target = Path(debug_dir)
            target.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S") + f"-{int(time.time() * 1000) % 1000:03d}"
            (target / f"{stamp}.webm").write_bytes(audio_bytes)
            (target / f"{stamp}.txt").write_text(
                f"bytes={len(audio_bytes)}\nduration={duration}\nduration_after_vad={after_vad}\n"
                f"text={text!r}\n",
                encoding="utf-8",
            )
        except Exception as e:  # never break a transcription over debug output
            logger.warning(f"STT debug dump failed: {e}")

    # ── API endpoint ──

    def _transcribe_api(self, audio_bytes: bytes, endpoint_id: str, model: str, language: str = "") -> Optional[str]:
        from src.database import SessionLocal, ModelEndpoint

        db = SessionLocal()
        try:
            ep = db.query(ModelEndpoint).filter(ModelEndpoint.id == endpoint_id).first()
            if not ep:
                logger.error(f"STT endpoint {endpoint_id} not found")
                return None
            base_url = ep.base_url.rstrip("/")
            api_key = ep.api_key
        finally:
            db.close()

        url = base_url + "/audio/transcriptions"
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        files = {"file": ("audio.webm", io.BytesIO(audio_bytes), "audio/webm")}
        data = {"model": model or "whisper-1"}
        if language:
            data["language"] = language

        try:
            r = httpx.post(url, headers=headers, files=files, data=data, timeout=60)
            r.raise_for_status()
            result = r.json()
            text = result.get("text", "")
            logger.info(f"API STT: {len(text)} chars from {base_url}")
            return text
        except Exception as e:
            logger.error(f"API STT transcription failed: {e}")
            return None

    # ── Public interface ──

    def transcribe(self, audio_bytes: bytes, options: Optional[Dict[str, Any]] = None) -> Optional[str]:
        """Transcribe one clip.

        ``options`` is an optional per-request override bundle (language, model,
        initial_prompt, vad_filter) — e.g. "this clip is in English" without
        touching the global config. Invalid or unknown entries are dropped, so a
        malformed override degrades to the saved settings instead of failing.
        """
        settings = self._load_settings()
        if settings.get("stt_enabled") is False:
            return None
        provider = settings["stt_provider"]
        model = settings["stt_model"]
        language = settings.get("stt_language", "")

        if provider in ("disabled", "browser"):
            return None

        overrides = sanitize_overrides(options, allowed_model=model)

        if provider == "local":
            return self._transcribe_local(audio_bytes, settings=settings, overrides=overrides)
        elif provider.startswith("endpoint:"):
            endpoint_id = provider.split(":", 1)[1]
            return self._transcribe_api(
                audio_bytes,
                endpoint_id,
                overrides.get("model") or model,
                overrides.get("language") or language,
            )
        else:
            logger.error(f"Unknown STT provider: {provider}")
            return None

    def get_stats(self) -> Dict[str, Any]:
        settings = self._load_settings()
        provider = settings["stt_provider"]
        stt_enabled = settings.get("stt_enabled", False)
        # If toggle is off, report as disabled
        effective_provider = provider if stt_enabled else "disabled"

        stats = {
            "available": self.available and stt_enabled,
            "provider": effective_provider,
            "model": settings["stt_model"],
            "language": settings.get("stt_language", ""),
        }

        if provider == "local":
            whisper = self._get_whisper()
            stats["model_loaded"] = whisper is not None
            # Surfaced so the STT config can be checked from outside the box
            # (this endpoint is what proved `language: ""` was the "to the boss"
            # bug in the first place).
            stats["vad_filter"] = _as_bool(settings.get("stt_vad_filter"), True)
            stats["initial_prompt"] = settings.get("stt_initial_prompt") or ""
        elif provider == "browser":
            stats["model"] = "Browser (Web Speech API)"
        elif provider.startswith("endpoint:"):
            stats["endpoint_id"] = provider.split(":", 1)[1]

        return stats


# Module-level singleton
_stt_service = None

def get_stt_service() -> STTService:
    global _stt_service
    if _stt_service is None:
        _stt_service = STTService()
    return _stt_service
