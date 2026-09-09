"""STT (faster-whisper) transcription options: what reaches the library.

Guards the config that fixed Spanish dictation ("esto es en una prueba de
reconocimiento" -> "to the boss"): the language must never be autodetected, the
glossary/VAD knobs must reach faster-whisper, and a per-request override must
not leak into the saved settings.

There is deliberately no audio here — transcription quality can only be judged
by dictating. What is testable, and what these cover, is the parameter contract.
"""

import pytest

from services.stt.stt_service import (
    DEFAULT_STT_INITIAL_PROMPT,
    DEFAULT_STT_LANGUAGE,
    DEFAULT_STT_MODEL,
    MAX_INITIAL_PROMPT_CHARS,
    STTService,
    build_local_transcribe_kwargs,
    filter_degenerate_text,
    sanitize_overrides,
)
from src.settings import DEFAULT_SETTINGS


# ── The shipped defaults ──

def test_shipped_defaults_never_regress_to_autodetect_or_base():
    """The two settings that caused the bug, pinned as a regression guard."""
    assert DEFAULT_SETTINGS["stt_language"] == "es"
    assert DEFAULT_SETTINGS["stt_model"] == "large-v3-turbo"
    assert DEFAULT_SETTINGS["stt_vad_filter"] is True
    assert DEFAULT_SETTINGS["stt_initial_prompt"]


def test_defaults_preserve_todays_transcribe_call():
    """No settings saved at all -> the full recipe, nothing left to chance."""
    kwargs = build_local_transcribe_kwargs({})

    assert kwargs["language"] == DEFAULT_STT_LANGUAGE == "es"
    assert kwargs["task"] == "transcribe"          # never "translate"
    assert kwargs["condition_on_previous_text"] is False
    assert kwargs["vad_filter"] is True
    assert kwargs["vad_parameters"] == {
        "min_silence_duration_ms": 300,
        "speech_pad_ms": 400,
        # Descarta clics/respiraciones antes del decoder: con el default 0 de
        # faster-whisper, un blip de 40 ms se decodifica como "¡Gracias!".
        "min_speech_duration_ms": 250,
    }
    assert kwargs["initial_prompt"] == DEFAULT_STT_INITIAL_PROMPT
    # No threshold unless configured: the library default (0.5) applies.
    assert "threshold" not in kwargs["vad_parameters"]


def test_anti_hallucination_parameters_reach_faster_whisper():
    """The knobs that keep a silent clip from being decoded into
    "¡Gracias por ver el video!" — see the live capture of 2026-09-07."""
    kwargs = build_local_transcribe_kwargs({})

    # VAD is the primary defense: non-speech never reaches the decoder.
    assert kwargs["vad_filter"] is True
    # The model's own silence detector, and the confidence floor it pairs with.
    assert kwargs["no_speech_threshold"] == 0.6
    assert kwargs["log_prob_threshold"] == -1.0
    # Repetition detector — only meaningful with a temperature ladder to fall
    # back to, so both must be present together or neither does anything.
    assert kwargs["compression_ratio_threshold"] == 2.4
    assert isinstance(kwargs["temperature"], list) and len(kwargs["temperature"]) > 1
    assert kwargs["temperature"][0] == 0.0, "first pass must still be greedy"
    # And the loop must not be carried into the next window.
    assert kwargs["condition_on_previous_text"] is False


def test_default_glossary_is_a_term_list_not_a_sentence():
    """A prose prompt is what the decoder echoed back ("Términos frecuentes en
    español de México." x20) when there was no speech.

    Asserted on the SHIPPED copy (DEFAULT_SETTINGS), not only on the service
    constant: load_settings merges {**DEFAULT_SETTINGS, **saved}, so the value in
    DEFAULT_SETTINGS is the one that reaches faster-whisper. Checking only the
    service constant is what let the prose prompt keep shipping — that assertion
    was green while every dictation still got the echo.
    """
    for prompt in (DEFAULT_STT_INITIAL_PROMPT, DEFAULT_SETTINGS["stt_initial_prompt"]):
        assert "Transcripción" not in prompt
        assert "Términos frecuentes" not in prompt
        assert prompt.count(",") >= 5


def test_stt_defaults_have_exactly_one_definition():
    """The service constants and the shipped settings must BE the same object.

    Three places wanted these values (DEFAULT_SETTINGS, the STT service, the
    voice-endpoint reset in routes/model_routes) and each kept its own literal.
    They drifted: the service said `large-v3-turbo` + a bare glossary while
    DEFAULT_SETTINGS — the copy that wins — still said `base`-era prose. This
    pins them to the single definition in src.constants so the next edit cannot
    land in the copy nobody reads.
    """
    from src import constants

    assert DEFAULT_SETTINGS["stt_model"] is constants.DEFAULT_STT_MODEL
    assert DEFAULT_SETTINGS["stt_language"] is constants.DEFAULT_STT_LANGUAGE
    assert DEFAULT_SETTINGS["stt_initial_prompt"] is constants.DEFAULT_STT_INITIAL_PROMPT
    assert DEFAULT_STT_MODEL is constants.DEFAULT_STT_MODEL
    assert DEFAULT_STT_LANGUAGE is constants.DEFAULT_STT_LANGUAGE
    assert DEFAULT_STT_INITIAL_PROMPT is constants.DEFAULT_STT_INITIAL_PROMPT


def test_deleting_a_voice_endpoint_does_not_downgrade_whisper_to_base():
    """Removing a TTS/STT endpoint resets the model to the shipped default.

    It used to reset it to the literal "base" — the Whisper model the large-v3
    upgrade existed to escape — so deleting an unrelated endpoint silently
    brought the mangled tech jargon back.
    """
    from routes.model_routes import _clear_speech_settings_for_endpoint

    settings = {
        "stt_provider": "endpoint:abc123",
        "stt_model": "whatever-the-endpoint-served",
        "tts_provider": "disabled",
        "tts_model": "tts-1",
    }
    cleared = _clear_speech_settings_for_endpoint(settings, "abc123")

    assert cleared == ["Speech to Text"]
    assert settings["stt_provider"] == "disabled"
    assert settings["stt_model"] == DEFAULT_SETTINGS["stt_model"]
    assert settings["stt_model"] != "base"


def test_language_is_never_empty_even_if_setting_is_blank():
    """A settings file left over from the autodetect era must not re-enable it."""
    kwargs = build_local_transcribe_kwargs({"stt_language": ""})
    assert kwargs["language"] == "es"


# ── Settings drive the knobs ──

def test_settings_reach_faster_whisper():
    kwargs = build_local_transcribe_kwargs({
        "stt_language": "pt",
        "stt_initial_prompt": "glosario propio",
        "stt_vad_min_silence_ms": 500,
        "stt_vad_speech_pad_ms": 200,
        "stt_vad_threshold": 0.35,
    })
    assert kwargs["language"] == "pt"
    assert kwargs["initial_prompt"] == "glosario propio"
    assert kwargs["vad_parameters"] == {
        "min_silence_duration_ms": 500,
        "speech_pad_ms": 200,
        "min_speech_duration_ms": 250,   # no configurado -> default
        "threshold": 0.35,
    }


def test_vad_can_be_turned_off_and_takes_no_parameters_with_it():
    kwargs = build_local_transcribe_kwargs({"stt_vad_filter": False})
    assert kwargs["vad_filter"] is False
    assert "vad_parameters" not in kwargs


def test_empty_initial_prompt_setting_sends_no_prompt():
    """An operator clearing the glossary must clear it, not fall back to ours."""
    kwargs = build_local_transcribe_kwargs({"stt_initial_prompt": ""})
    assert "initial_prompt" not in kwargs


@pytest.mark.parametrize("bad", ["", None, "no-soy-un-numero", 99])
def test_bad_vad_threshold_falls_back_to_library_default(bad):
    kwargs = build_local_transcribe_kwargs({"stt_vad_threshold": bad})
    threshold = kwargs["vad_parameters"].get("threshold")
    assert threshold is None or 0.0 <= threshold <= 1.0


def test_nonsense_vad_durations_fall_back_to_defaults():
    kwargs = build_local_transcribe_kwargs({
        "stt_vad_min_silence_ms": "abc",
        "stt_vad_speech_pad_ms": None,
    })
    assert kwargs["vad_parameters"] == {
        "min_silence_duration_ms": 300,
        "speech_pad_ms": 400,
        "min_speech_duration_ms": 250,
    }


# ── Per-request overrides ──

def test_override_wins_over_settings_without_mutating_them():
    settings = {"stt_language": "es", "stt_initial_prompt": "glob"}
    snapshot = dict(settings)

    kwargs = build_local_transcribe_kwargs(settings, {"language": "en", "initial_prompt": "local"})

    assert kwargs["language"] == "en"
    assert kwargs["initial_prompt"] == "local"
    assert settings == snapshot, "an override must never mutate the global config"


def test_override_can_disable_vad_for_one_clip_only():
    settings = {"stt_vad_filter": True}
    assert build_local_transcribe_kwargs(settings, {"vad_filter": "false"})["vad_filter"] is False
    assert build_local_transcribe_kwargs(settings)["vad_filter"] is True


def test_sanitize_accepts_a_plain_language_code():
    assert sanitize_overrides({"language": " EN "}) == {"language": "en"}


@pytest.mark.parametrize("bad", ["es-MX", "english", "e", "../../etc", "12"])
def test_sanitize_drops_malformed_language(bad):
    assert "language" not in sanitize_overrides({"language": bad})


def test_sanitize_drops_model_outside_the_allowlist():
    """WhisperModel downloads any unknown string as a HF repo id — a request
    must not be able to make the server fetch an arbitrary repo."""
    assert "model" not in sanitize_overrides({"model": "attacker/whisper-backdoor"})
    assert sanitize_overrides({"model": "medium"}) == {"model": "medium"}


def test_sanitize_allows_the_configured_model_even_if_custom():
    raw = {"model": "my-org/faster-whisper-custom"}
    assert "model" not in sanitize_overrides(raw)
    assert sanitize_overrides(raw, allowed_model="my-org/faster-whisper-custom") == raw


def test_sanitize_truncates_an_oversized_prompt():
    clean = sanitize_overrides({"initial_prompt": "x" * (MAX_INITIAL_PROMPT_CHARS + 500)})
    assert len(clean["initial_prompt"]) == MAX_INITIAL_PROMPT_CHARS


def test_sanitize_of_nothing_is_nothing():
    assert sanitize_overrides(None) == {}
    assert sanitize_overrides({}) == {}


# ── Silence hallucinations ──
#
# Captured live on 2026-09-07: the mic was left on by accident, nobody spoke,
# and this is (an excerpt of) what landed in the composer.
REAL_HALLUCINATION = (
    "Términos frecuentes en español de México. "
    "Términos frecuentes en español de México. "
    "¡Gracias por ver el video! ¡Suscríbete al canal para no perderte los próximos videos! "
    "Términos frecuentes. Términos frecuentes. "
    "Términos frecuentes en español de México. "
    "¡Gracias por ver el video! ¡Suscríbete al canal para no perderte los próximos videos! "
    "Gracias por su atención. "
    "¡Suscríbete al canal y activa la campanita para recibir notificaciones de nuevos videos!"
)

OLD_PROSE_PROMPT = (
    "Transcripción de dictado técnico en español de México. "
    "Términos frecuentes: Whisper, cuantización, MCP, endpoint, VRAM."
)


def test_the_real_silence_hallucination_is_dropped_whole():
    """No speech in, nothing out — not "Gracias por ver el video"."""
    assert filter_degenerate_text(REAL_HALLUCINATION, OLD_PROSE_PROMPT) == ""


def test_a_lone_prompt_echo_is_dropped():
    assert filter_degenerate_text("Términos frecuentes en español de México.", OLD_PROSE_PROMPT) == ""


def test_a_repeated_stock_phrase_is_dropped_without_any_prompt():
    looped = " ".join(["¡Suscríbete al canal!"] * 6)
    assert filter_degenerate_text(looped, "") == ""


def test_real_dictation_survives_untouched():
    """The filter must be inert on speech — including a clip that happens to
    mention the glossary terms."""
    for text in (
        "Hay que hacer el deploy después del commit.",
        "El endpoint de MCP falla con VRAM insuficiente. Revisa el log de ctranslate2.",
        "Sí. Ajusta la latencia del push-to-talk.",
        "el piso está enladrillado, quién lo desenladrillará",
    ):
        assert filter_degenerate_text(text, DEFAULT_STT_INITIAL_PROMPT) == text


def test_a_repeated_word_is_not_mistaken_for_a_loop():
    """Two repetitions is emphasis; the loop threshold is three."""
    text = "No, no. No entendí."
    assert filter_degenerate_text(text, "") == text


def test_empty_stays_empty():
    assert filter_degenerate_text("", "x") == ""
    assert filter_degenerate_text("   ", "x") == ""


# ── End to end through the service (no audio, fake model) ──

class _FakeInfo:
    language = "es"
    language_probability = 1.0
    duration = 3.5
    duration_after_vad = 3.5


class _FakeSegment:
    def __init__(self, text):
        self.text = text


class _FakeModel:
    """Records the kwargs it was called with."""

    def __init__(self):
        self.calls = []

    def transcribe(self, path, **kwargs):
        self.calls.append(kwargs)
        return [_FakeSegment(" hola mundo ")], _FakeInfo()


def _service_with(monkeypatch, saved, fake_model):
    service = STTService()
    monkeypatch.setattr(service, "_load_settings", lambda: dict(saved))
    monkeypatch.setattr(service, "_get_whisper", lambda *a, **k: fake_model)
    return service


BASE_SETTINGS = {
    "stt_enabled": True,
    "stt_provider": "local",
    "stt_model": DEFAULT_STT_MODEL,
    "stt_language": "es",
    "stt_initial_prompt": DEFAULT_STT_INITIAL_PROMPT,
    "stt_vad_filter": True,
    "stt_vad_min_silence_ms": 300,
    "stt_vad_speech_pad_ms": 400,
    "stt_vad_threshold": "",
}


def test_transcribe_without_options_uses_saved_settings(monkeypatch):
    fake = _FakeModel()
    service = _service_with(monkeypatch, BASE_SETTINGS, fake)

    assert service.transcribe(b"audio") == "hola mundo"
    assert fake.calls[0]["language"] == "es"
    assert fake.calls[0]["vad_filter"] is True
    assert fake.calls[0]["initial_prompt"] == DEFAULT_STT_INITIAL_PROMPT


def test_transcribe_with_language_override_reaches_the_model(monkeypatch):
    fake = _FakeModel()
    service = _service_with(monkeypatch, BASE_SETTINGS, fake)

    service.transcribe(b"audio", {"language": "en"})

    assert fake.calls[0]["language"] == "en"
    # ... and the next request without an override is Spanish again.
    service.transcribe(b"audio")
    assert fake.calls[1]["language"] == "es"


def test_transcribe_ignores_a_bogus_override_instead_of_failing(monkeypatch):
    fake = _FakeModel()
    service = _service_with(monkeypatch, BASE_SETTINGS, fake)

    assert service.transcribe(b"audio", {"language": "klingon"}) == "hola mundo"
    assert fake.calls[0]["language"] == "es"


def test_model_override_asks_for_that_model(monkeypatch):
    fake = _FakeModel()
    service = STTService()
    monkeypatch.setattr(service, "_load_settings", lambda: dict(BASE_SETTINGS))
    asked = []

    def fake_get_whisper(model_size=None):
        asked.append(model_size)
        return fake

    monkeypatch.setattr(service, "_get_whisper", fake_get_whisper)

    service.transcribe(b"audio", {"model": "medium"})
    assert asked == ["medium"]

    service.transcribe(b"audio")
    assert asked[-1] is None, "no override -> the configured model, resolved by the loader"


def test_legacy_two_argument_call_still_works(monkeypatch):
    """_transcribe_local(audio, language) is the pre-existing signature."""
    fake = _FakeModel()
    service = _service_with(monkeypatch, BASE_SETTINGS, fake)

    assert service._transcribe_local(b"audio", "pt") == "hola mundo"
    assert fake.calls[0]["language"] == "pt"


def test_api_provider_gets_the_overridden_language(monkeypatch):
    service = STTService()
    monkeypatch.setattr(service, "_load_settings", lambda: {
        **BASE_SETTINGS, "stt_provider": "endpoint:abc", "stt_model": "whisper-1",
    })
    seen = {}

    def fake_api(audio, endpoint_id, model, language=""):
        seen.update(endpoint_id=endpoint_id, model=model, language=language)
        return "ok"

    monkeypatch.setattr(service, "_transcribe_api", fake_api)

    assert service.transcribe(b"audio", {"language": "en"}) == "ok"
    assert seen == {"endpoint_id": "abc", "model": "whisper-1", "language": "en"}


# ── Cierres de subtítulo pegados al final del clip (observado en vivo 2026-09-08) ──────────────────
# El trabalenguas de QA salió COMPLETO y bien reconocido, y traía un "¡Gracias!" que nadie dijo: el clip
# termina, el decoder sigue un token más y estampa la despedida del corpus de subtítulos con el que se
# entrenó. No tiene ninguna de las dos firmas que ya cazaba el filtro (aparece UNA vez, así que no es un
# loop; y es demasiado corta para el test de solape con el prompt, que exige ≥4 palabras).

TRABALENGUAS_QA = (
    "El piso está enladrillado. ¿Quién lo desenladrillará? El desenladrillador. "
    "Que lo desenladrillase, buen desenladrillador será."
)


def test_cierre_alucinado_se_quita_y_el_dictado_queda_intacto():
    assert filter_degenerate_text(TRABALENGUAS_QA + " ¡Gracias!", "") == TRABALENGUAS_QA


def test_cierres_encadenados_no_se_llevan_la_frase_real():
    # Dos despedidas seguidas. Antes esto devolvía "" porque los descartes alimentaban la regla de
    # "el clip era casi todo basura" — perder el dictado es peor que el artefacto que se quería quitar.
    assert filter_degenerate_text("Revisa el commit. ¡Gracias! ¡Suscríbete al canal!", "") == "Revisa el commit."


def test_cierre_con_tilde_tambien_cae():
    # `_normalize` conserva los acentos, así que la comparación PLIEGA (ver `_fold`): una lista escrita en
    # ASCII no habría casado nunca con "suscríbete".
    assert filter_degenerate_text("Manda el pull request. ¡Suscríbete al canal!", "") == "Manda el pull request."


def test_un_gracias_solo_es_habla_real_y_se_conserva():
    # El candado que hace aceptable la lista: si el clip no tiene NADA más, quien dictó quería decir eso.
    assert filter_degenerate_text("Gracias.", "") == "Gracias."


def test_gracias_en_medio_del_dictado_se_conserva():
    # Solo se mira la ÚLTIMA frase; un agradecimiento en medio es habla.
    assert filter_degenerate_text("Gracias por venir. Nos vemos mañana.", "") == "Gracias por venir. Nos vemos mañana."
