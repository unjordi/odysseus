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


# ── A-4: las palabras AMBIGUAS no se borran sin contexto ────────────────────────
# El conjunto plano `_REMOVABLE` autorizaba a borrar `o`, `va`, `como`, `verdad`…
# donde eran CONTENIDO, y los dos candados salían verdes porque la palabra estaba
# en la lista. Ahora una ambigua sólo cuenta como relleno si venía DELIMITADA por
# una pausa — el mismo criterio que el carril determinista ya usaba para `este`.

def _acepta(src: str, cand: str) -> bool:
    from services.stt.transcript_cleaner import (
        is_deletion_only, _removals_are_all_fillers,
    )
    return is_deletion_only(src, cand) and _removals_are_all_fillers(src, cand)


def test_no_se_borra_una_ambigua_que_es_contenido():
    assert not _acepta("borra el archivo viejo o el nuevo", "borra el archivo viejo el nuevo")
    assert not _acepta("si el build va bien", "si el build bien")
    assert not _acepta("es como el otro", "es el otro")
    assert not _acepta("dime la verdad completa", "dime la completa")
    assert not _acepta("dame el uno o el dos", "dame el uno el dos")


def test_si_se_borra_una_ambigua_delimitada_por_pausa():
    assert _acepta("bueno, entonces lo hacemos", "entonces lo hacemos")
    assert _acepta("este, revisa el worktree", "revisa el worktree")


def test_la_muletilla_multipalabra_sigue_siendo_borrable():
    """La pausa cierra la RACHA, no cada palabra: en `o sea,` el `o` no lleva
    coma detrás, pero la racha de ambiguas termina delimitada."""
    assert _acepta("o sea, lo que quiero decir", "lo que quiero decir")


def test_lo_inequivoco_no_necesita_contexto():
    assert _acepta("eh necesito el commit", "necesito el commit")


def test_siguen_frenados_el_verbo_comido_y_pasa_el_tartamudeo():
    assert not _acepta("necesito revisar el worktree", "revisar el worktree")
    assert _acepta("el el commit", "el commit")


# ── M-6: el breaker vuelve a media asta al vencer el cooldown ───────────────────
# El contador no se reiniciaba, así que el PRIMER fallo tras el cooldown re-pausaba
# (el límite dejaba de significar lo que dice) y el log informaba rachas inventadas.

def test_el_breaker_exige_otra_racha_completa_tras_el_cooldown():
    from services.stt import transcript_cleaner as tc
    tc.reset_llm_circuit()
    tc._note_llm_failure("probe")
    tc._note_llm_failure("probe")          # alcanza el límite ⇒ pausa
    assert not tc._llm_available()
    import time as _t
    tc._llm_disabled_until = _t.monotonic() - 1   # el cooldown VENCIÓ (en el pasado, no "nunca hubo")
    assert tc._llm_available()
    assert tc._llm_consecutive_failures == 0
    tc._note_llm_failure("probe")          # UN solo fallo NO debe re-pausar
    assert tc._llm_available()
    tc._note_llm_failure("probe")          # el segundo sí
    assert not tc._llm_available()
    tc.reset_llm_circuit()


# ── F-3: la ambigua DELIMITADA en final de cláusula también era contenido ───────
# El candado miraba solo la pausa de ATRÁS. En español dictado TODA palabra final
# de cláusula la lleva, así que seis borrados reales pasaban con los dos candados
# en verde. Ahora se exige pausa por AMBOS lados (una muletilla suelta va ENTRE
# pausas; una palabra de contenido tiene texto pegado por delante).

def test_la_ambigua_al_final_de_la_clausula_no_se_borra():
    assert not _acepta("el resultado es bueno.", "el resultado es.")
    assert not _acepta("dime la verdad.", "dime la.")
    assert not _acepta("el script va, y luego falla.", "el script y luego falla.")
    assert not _acepta("no sé si va.", "no sé si.")
    assert not _acepta("déjalo como.", "déjalo.")
    assert not _acepta("prefiero este o.", "prefiero este.")


def test_la_muletilla_entre_pausas_sigue_borrandose():
    assert _acepta("y, bueno, seguimos", "y, seguimos")
    assert _acepta("va, entonces lo dejamos", "entonces lo dejamos")
    assert _acepta("bueno, ya está", "ya está")   # el inicio del texto cuenta como pausa


# ── BAJO de la auditoría: el breaker contaba lo BIEN-ENVUELTO, no lo útil ───────
# Bastaba con que la respuesta trajera los delimitadores para reiniciar el
# contador, así que un modelo que contesta bien formado pero cuya salida se
# rechaza SIEMPRE mantenía el breaker abierto: se pagaba la latencia de cada
# llamada sin obtener nunca una limpieza.

def _responde(monkeypatch, contenido):
    """Sustituye el POST a ollama por una respuesta fija, sin tocar la red."""
    import json as _json
    from services.stt import transcript_cleaner as tc

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return _json.dumps({"message": {"content": contenido}}).encode("utf-8")

    monkeypatch.setattr(tc.urllib.request, "urlopen", lambda *a, **k: _Resp())


def test_una_respuesta_rechazada_cuenta_como_fallo_del_breaker(monkeypatch):
    from services.stt import transcript_cleaner as tc
    tc.reset_llm_circuit()
    # bien formada (trae los delimitadores) pero REFORMULA: se rechaza
    _responde(monkeypatch, "<limpio>otra cosa totalmente distinta</limpio>")
    for _ in range(tc._LLM_FAILURE_LIMIT):
        salida, motivo = tc.clean_with_llm("necesito el commit", model="x")
        assert salida is None and motivo.startswith("rechazada")
    assert not tc._llm_available(), "N rechazos seguidos deben PAUSAR el LLM"
    tc.reset_llm_circuit()


def test_una_respuesta_ACEPTADA_sigue_reiniciando_el_contador(monkeypatch):
    from services.stt import transcript_cleaner as tc
    tc.reset_llm_circuit()
    tc._note_llm_failure("probe")
    _responde(monkeypatch, "<limpio>necesito el commit</limpio>")
    salida, motivo = tc.clean_with_llm("eh necesito el commit", model="x")
    assert motivo == "ok" and salida == "necesito el commit"
    assert tc._llm_consecutive_failures == 0
    tc.reset_llm_circuit()


def test_los_puntos_suspensivos_cuentan_como_pausa():
    """El `\x00` del conjunto de pausas era código muerto (lo fabrica y lo borra
    el carril determinista); el carácter real de suspensivos sí llega y sí es
    una pausa."""
    assert _acepta("y… bueno… seguimos", "y… seguimos")
