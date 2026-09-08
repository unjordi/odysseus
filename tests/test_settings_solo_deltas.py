"""`save_settings` persiste solo los DELTAS contra DEFAULT_SETTINGS.

Por qué existe este archivo: los callers hacen `current = load_settings()` (el dict COMPLETO, con cada
default materializado), tocan dos llaves y guardan. Antes eso escribía las 70+ llaves y el archivo
dejaba de ser "lo que el usuario eligió" para volverse un SNAPSHOT de los defaults del día. Y como
`load_settings` hace `{**DEFAULT_SETTINGS, **saved}`, el snapshot GANA para siempre: cuando el default
del código cambia, el valor viejo sigue mandando y nada lo señala.

Costó real (2026-09-07): el archivo en vivo pinaba `stt_model="large-v3"` con el código ya en
`large-v3-turbo`, y `tts_provider="disabled"` con el default ya en el sidecar kokoro. Nadie los eligió.
"""

import json

import pytest

from src import settings as S


@pytest.fixture
def store(tmp_path, monkeypatch):
    ruta = tmp_path / "settings.json"
    monkeypatch.setattr(S, "SETTINGS_FILE", str(ruta))
    S._invalidate_caches()
    yield ruta
    S._invalidate_caches()


def test_guardar_el_dict_completo_solo_persiste_lo_que_difiere(store):
    completo = S.load_settings()
    completo["default_model"] = "axon"
    S.save_settings(completo)

    en_disco = json.loads(store.read_text())
    assert en_disco.get("default_model") == "axon"
    # El grueso NO se escribe: son defaults que load_settings repone idénticos.
    assert len(en_disco) < 5, f"se materializaron defaults: {sorted(en_disco)}"
    assert "stt_model" not in en_disco
    assert "tts_provider" not in en_disco


def test_el_round_trip_es_identico(store):
    completo = S.load_settings()
    completo["default_model"] = "axon"
    completo["search_result_count"] = 11
    S.save_settings(completo)
    S._invalidate_caches()
    assert S.load_settings() == completo


def test_un_default_que_cambia_en_el_codigo_YA_no_queda_fosilizado(store, monkeypatch):
    # Se guarda con el default de hoy…
    S.save_settings(S.load_settings())
    S._invalidate_caches()
    # …y mañana el código cambia ese default.
    monkeypatch.setitem(S.DEFAULT_SETTINGS, "stt_model", "un-modelo-nuevo")
    S._invalidate_caches()
    # Antes: el archivo traía el viejo y ganaba. Ahora manda el código, que es lo correcto.
    assert S.load_settings()["stt_model"] == "un-modelo-nuevo"


def test_una_eleccion_real_SI_sobrevive_a_que_cambie_el_default(store, monkeypatch):
    # El contrapeso del test anterior: lo que el usuario eligió a propósito no se pierde.
    completo = S.load_settings()
    completo["stt_model"] = "large-v3"
    S.save_settings(completo)
    S._invalidate_caches()
    monkeypatch.setitem(S.DEFAULT_SETTINGS, "stt_model", "un-modelo-nuevo")
    S._invalidate_caches()
    assert S.load_settings()["stt_model"] == "large-v3"


def test_is_setting_overridden_se_vuelve_honesta(store):
    completo = S.load_settings()
    completo["default_model"] = "axon"
    S.save_settings(completo)
    # Presente ⟺ distinto del default. Es lo que el propio docstring advertía que la
    # materialización rompía.
    assert S.is_setting_overridden("default_model") is True
    assert S.is_setting_overridden("stt_model") is False


def test_las_lapidas_retiradas_se_conservan_tal_cual(store):
    # RETIRED_SETTING_KEYS existe para que un archivo viejo cargue sin pérdida: no se filtra.
    completo = S.load_settings()
    for k in S.RETIRED_SETTING_KEYS:
        completo[k] = ["algo-que-alguien-guardo"]
    S.save_settings(completo)
    en_disco = json.loads(store.read_text())
    for k in S.RETIRED_SETTING_KEYS:
        assert en_disco.get(k) == ["algo-que-alguien-guardo"]
