"""Dictado LIMPIO: los tres síntomas, y el candado de que sólo se BORRA.

Los tres se ven igual en pantalla pero NO se arreglan igual, y eso es lo que
estas pruebas fijan:

* **(A) "¡Gracias!" alucinado** — Whisper lo inventa cuando le llega no-habla.
  Se ataca ANTES del decoder (VAD) y con la bag-of-hallucinations. NO con los
  umbrales del decoder: son estructuralmente incapaces de atraparlo, y hay una
  prueba abajo que fija esa decisión para que nadie la "arregle" tuneándolos.
* **(B) muletillas** — el usuario SÍ las dijo, Whisper las transcribe bien. Sólo
  se pueden quitar después: post-proceso.
* **(C) "..." de pausa** — igual que B.

Y el invariante que lo cubre todo: el limpiador puede QUITAR, nunca REFORMULAR.

Texto de dictado real es-MX con jerga técnica en inglés a propósito: es
justo donde un limpiador ingenuo rompe cosas (traduce, "corrige" una ruta, o
contesta la pregunta que le dictaron).
"""

import pytest

from services.stt.stt_service import (
    DEFAULT_VAD_MIN_SPEECH_MS,
    build_local_transcribe_kwargs,
    filter_degenerate_text,
)
from services.stt.transcript_cleaner import (
    _removals_are_all_fillers,
    clean_transcript,
    is_deletion_only,
    strip_annotations,
    strip_disfluencies,
    strip_reasoning,
)


# ── (A) El "Gracias" alucinado ──

def test_gracias_alucinado_se_cae_al_final_del_dictado():
    """El síntoma exacto que reportó unjordi: el dictado sale bien y trae
    pegada una despedida que nadie dijo."""
    crudo = "Vamos a hacer el commit en la rama feat dictado limpio. ¡Gracias!"
    assert filter_degenerate_text(crudo) == "Vamos a hacer el commit en la rama feat dictado limpio."


def test_un_gracias_deliberado_y_solo_no_se_borra():
    """El candado del post-filtro: si el clip ENTERO es "Gracias", alguien lo
    quiso dictar. Borrar palabras comunes a ciegas es el falso positivo que el
    propio paper advierte."""
    assert filter_degenerate_text("Gracias.") == "Gracias."


def test_gracias_en_medio_del_dictado_es_habla_real():
    crudo = "Gracias por el fix, ahora sí pasa el merge."
    assert filter_degenerate_text(crudo) == crudo


def test_el_vad_descarta_los_blips_que_se_vuelven_alucinacion():
    """min_speech_duration_ms es la vía por la que entra el "¡Gracias!": con el
    default 0 de faster-whisper, un clic de 40 ms cuenta como voz, llega al
    decoder, y el decoder lo rellena con la despedida de su corpus."""
    kwargs = build_local_transcribe_kwargs({})
    assert kwargs["vad_filter"] is True
    assert kwargs["vad_parameters"]["min_speech_duration_ms"] == DEFAULT_VAD_MIN_SPEECH_MS == 250
    assert kwargs["vad_parameters"]["min_silence_duration_ms"] == 300


def test_los_umbrales_del_decoder_se_quedan_en_su_default_a_proposito():
    """Regresión de una DECISIÓN, no de un valor.

    Tunear estos tres es el camino equivocado para el "¡Gracias!": la compuerta
    de no-habla exige `no_speech_prob > umbral` Y fallo de log-prob a la vez, y
    una alucinación corta y confiada pasa las dos (faster-whisper#621). Si
    alguien los mueve "para arreglar la alucinación", que se caiga aquí y lea.
    """
    kwargs = build_local_transcribe_kwargs({})
    assert kwargs["no_speech_threshold"] == 0.6
    assert kwargs["log_prob_threshold"] == -1.0
    assert kwargs["compression_ratio_threshold"] == 2.4
    # Y lo que sí hace el trabajo sigue en su sitio.
    assert kwargs["condition_on_previous_text"] is False
    assert kwargs["language"] == "es"
    # word_timestamps apagado => hallucination_silence_threshold sería código
    # muerto; se deja fuera a propósito (§2.5 del estudio).
    assert "hallucination_silence_threshold" not in kwargs
    assert kwargs.get("word_timestamps") in (None, False)


def test_anotaciones_de_subtitulo_se_van_por_forma_no_por_lista():
    """Complementa la blocklist: "[Música]" no está en ninguna lista de frases,
    pero su FORMA lo delata."""
    assert strip_annotations("[Música] Necesito el rebase (inaudible)") == "Necesito el rebase"


def test_un_parentesis_largo_es_habla_real_y_se_respeta():
    texto = "Hay que migrarlo (aunque primero tenemos que revisar si el endpoint aguanta la carga)"
    assert strip_annotations(texto) == texto


# ── (B) Muletillas ──

def test_muletillas_es_mx_se_van_y_lo_tecnico_se_queda():
    crudo = "Este... eh, o sea, necesito que hagas un rebase, ummm, sobre develop, y luego el push."
    limpio = strip_disfluencies(crudo)
    assert "eh," not in limpio
    assert "ummm" not in limpio
    assert "o sea" not in limpio
    # lo que SÍ dijo, intacto
    assert "rebase" in limpio and "develop" in limpio and "push" in limpio
    # Sin re-capitalizar: borrar la palabra que abría la frase NO autoriza a
    # cambiarle la caja a la siguiente. Es borrado estricto.
    assert limpio == "necesito que hagas un rebase, sobre develop, y luego el push."


def test_este_demostrativo_no_es_muletilla():
    """"este" es ambiguo: muletilla en "Este..., eh" y demostrativo en "este
    commit". Sólo se borra cuando trae la firma de pausa."""
    texto = "Revisa este commit y este worktree"
    assert strip_disfluencies(texto) == texto


def test_esteee_alargado_siempre_es_muletilla():
    assert strip_disfluencies("Esteee necesito el merge") == "necesito el merge"


def test_la_limpieza_nunca_cambia_una_mayuscula():
    """Cambiar la caja de una letra es MODIFICAR lo dictado, no borrarlo.

    Lo cazó una prueba de regresión que ya existía en el repo ("hola mundo" se
    volvía "Hola mundo"). Queda fijado aquí para que no vuelva a colarse.
    """
    assert strip_disfluencies("hola mundo") == "hola mundo"


# ── (C) Puntos suspensivos de pausa ──

def test_los_suspensivos_de_pausa_desaparecen():
    crudo = "Necesito revisar el worktree... y después... hacer el commit."
    assert strip_disfluencies(crudo) == "Necesito revisar el worktree y después hacer el commit."


def test_un_punto_de_archivo_no_es_una_pausa():
    """El regex exige 3+ puntos justamente para no tocar `stt_service.py`."""
    texto = "Abre services/stt/stt_service.py y cambia el flag"
    assert strip_disfluencies(texto) == texto


# ── El caso ADVERSARIAL: texto ya limpio, no se toca NADA ──

ADVERSARIAL = (
    "Hay que correr git rebase --onto develop sobre el worktree de "
    "services/stt/stt_service.py antes del merge."
)


def test_adversarial_texto_limpio_con_jerga_tecnica_queda_identico():
    """El fallo más caro de un limpiador: "arreglar" lo que ya estaba bien.
    Rutas, banderas dobles y términos en inglés salen carácter por carácter."""
    assert strip_disfluencies(ADVERSARIAL) == ADVERSARIAL
    assert clean_transcript(ADVERSARIAL, {"stt_clean_llm_enabled": False}) == ADVERSARIAL


def test_adversarial_no_pierde_ningun_token_tecnico():
    for token in ("--onto", "services/stt/stt_service.py", "rebase", "merge", "worktree"):
        assert token in clean_transcript(ADVERSARIAL, {"stt_clean_llm_enabled": False})


# ── El invariante duro: QUITAR, NUNCA REFORMULAR ──

def test_el_verificador_acepta_un_borrado():
    assert is_deletion_only("Este eh necesito el commit", "Necesito el commit")


@pytest.mark.parametrize(
    "reformulado",
    [
        "I need the commit",                      # tradujo
        "Necesito realizar el commit",            # metió una palabra
        "El commit necesito",                     # reordenó
        "",                                       # se lo comió todo
    ],
)
def test_el_verificador_rechaza_cualquier_reformulacion(reformulado):
    """Esto es lo que hace que la regla dura sea una GARANTÍA y no una súplica al
    modelo: da igual lo que conteste, si no es un borrado se rechaza."""
    assert not is_deletion_only("Este eh necesito el commit", reformulado)


def test_el_verificador_rechaza_que_se_coma_una_palabra_con_contenido():
    """El agujero que la subsecuencia NO tapa, y por el que se coló un caso real.

    Borrar siempre es una subsecuencia válida, así que ese candado no distingue
    "quitó un ummm" de "se comió el verbo". Medido el 2026-09-08 con qwen3:4b, el
    caso de las pausas devolvió "Revisar el worktree y hacer el commit": perdió
    "Necesito" y "después" y pasó la subsecuencia tan campante.
    """
    crudo = "Necesito revisar el worktree y después hacer el commit"
    mutilado = "Revisar el worktree y hacer el commit"
    assert is_deletion_only(crudo, mutilado)              # la subsecuencia lo deja pasar
    assert not _removals_are_all_fillers(crudo, mutilado)  # este candado no


def test_el_verificador_acepta_que_se_quite_relleno():
    crudo = "Este eh necesito o sea el commit"
    assert _removals_are_all_fillers(crudo, "necesito el commit")


def test_el_verificador_acepta_quitar_un_tartamudeo():
    assert _removals_are_all_fillers("el el el commit", "el commit")


def test_la_limpieza_determinista_siempre_es_un_borrado():
    for crudo in [
        "Este... eh, o sea, necesito que hagas un rebase, ummm, sobre develop.",
        "Necesito revisar el worktree... y después... hacer el commit.",
        ADVERSARIAL,
    ]:
        assert is_deletion_only(crudo, strip_disfluencies(crudo))


# ── Degradación: el limpiador jamás rompe el dictado ──

def test_sin_ollama_devuelve_el_texto_que_traia():
    """El LLM apagado (default) o inalcanzable => el dictado sigue igual."""
    crudo = "Necesito el commit"
    assert clean_transcript(crudo, {"stt_clean_enabled": False}) == crudo


def test_el_llm_apagado_es_el_default():
    from services.stt.transcript_cleaner import DEFAULT_CLEAN_LLM_ENABLED
    assert DEFAULT_CLEAN_LLM_ENABLED is False


def test_una_transcripcion_vacia_no_revienta():
    assert clean_transcript("", {}) == ""
    assert clean_transcript("   ", {}) == "   "


def test_se_descarta_la_fuga_de_razonamiento_del_modelo():
    """qwen3 filtra su cadena de pensamiento aunque se pida think:false
    (medido 2026-09-08). Si se colara, el usuario vería el monólogo del modelo
    en lugar de su dictado."""
    sucio = "<think>El usuario quiere que limpie esto</think><limpio>Necesito el commit</limpio>"
    assert strip_reasoning(sucio) == "<limpio>Necesito el commit</limpio>"


def test_se_descarta_un_razonamiento_sin_cierre():
    """num_predict puede cortar antes de la etiqueta de cierre."""
    assert strip_reasoning("Hola <think>y aquí se cortó...") == "Hola"
