#!/usr/bin/env python3
"""Generate Kokoro TTS samples (Spanish + English) for A/B QA of prosody.

This mirrors what the fixed in-process `local` provider does
(services/tts/tts_service.py): it routes each voice to the matching G2P
language so Spanish sounds Spanish, not English-phonemes-on-Spanish-words.

Two backends, pick by what installs on your Python:

  * Python 3.11-3.12 → the real `kokoro` package (what Odysseus uses):
        pip install kokoro==0.9.4 soundfile
  * Python 3.13+ (incl. 3.14) → `kokoro-onnx` (same weights, CPU/onnx, no torch):
        pip install kokoro-onnx soundfile
        # download once:
        #   kokoro-v1.0.onnx  and  voices-v1.0.bin
        #   from github.com/thewh1teagle/kokoro-onnx releases (model-files-v1.0)
        # then set KOKORO_ONNX=/path/kokoro-v1.0.onnx KOKORO_VOICES=/path/voices-v1.0.bin

Usage:
    python generate_samples.py [out_dir]     # default: ./samples
"""
import os
import sys
import wave

# Spanish voices are prefix "e"; English "a" (American) / "b" (British).
VOICES = {
    "es_female_dora": "ef_dora",
    "es_male_alex": "em_alex",
    "en_female_heart": "af_heart",
    "en_male_michael": "am_michael",
}
TEXTS = {
    "es": (
        "Hola, soy la nueva voz del asistente. Hoy es jueves y el clima está "
        "despejado. ¿Te ayudo a organizar tus pendientes? Puedo leer en voz "
        "alta, con buena entonación y ritmo natural."
    ),
    "en": (
        "Hi, this is the assistant's new voice. It reads text aloud with natural "
        "intonation and rhythm — numbers like 3.14, dates, and questions all "
        "sound right."
    ),
}
SAMPLE_RATE = 24000


def _write_wav(path, audio, rate=SAMPLE_RATE):
    import numpy as np

    a = np.asarray(audio, dtype=np.float32)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes((a * 32767).astype(np.int16).tobytes())


def gen_with_kokoro(out_dir):
    import numpy as np
    from kokoro import KPipeline

    pipes = {}
    for label, voice in VOICES.items():
        lang = voice[0]  # 'e' Spanish, 'a'/'b' English, ...
        text = TEXTS["es"] if lang == "e" else TEXTS["en"]
        pipe = pipes.get(lang) or pipes.setdefault(lang, KPipeline(lang_code=lang))
        chunks = [audio for _, _, audio in pipe(text, voice=voice)]
        _write_wav(os.path.join(out_dir, f"{label}.wav"), np.concatenate(chunks))
        print(f"  wrote {label}.wav  (voice={voice} lang={lang})")


def gen_with_onnx(out_dir):
    from kokoro_onnx import Kokoro

    model = os.environ.get("KOKORO_ONNX", "kokoro-v1.0.onnx")
    voices = os.environ.get("KOKORO_VOICES", "voices-v1.0.bin")
    kok = Kokoro(model, voices)
    lang_map = {"e": "es", "a": "en-us", "b": "en-gb"}
    for label, voice in VOICES.items():
        lang = voice[0]
        text = TEXTS["es"] if lang == "e" else TEXTS["en"]
        audio, rate = kok.create(text, voice=voice, speed=1.0, lang=lang_map.get(lang, "en-us"))
        _write_wav(os.path.join(out_dir, f"{label}.wav"), audio, rate)
        print(f"  wrote {label}.wav  (voice={voice} lang={lang})")


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "samples"
    os.makedirs(out_dir, exist_ok=True)
    try:
        import kokoro  # noqa: F401
        print("Using real `kokoro` backend (Python 3.11-3.12).")
        gen_with_kokoro(out_dir)
    except ImportError:
        print("`kokoro` unavailable → falling back to `kokoro-onnx`.")
        gen_with_onnx(out_dir)
    print(f"Done → {out_dir}/")


if __name__ == "__main__":
    main()
