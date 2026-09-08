# src/constants.py
"""Application-wide constants and configuration values."""
import os

from src.runtime_paths import get_app_root, get_default_data_dir

APP_VERSION = "1.0.3"

# Base paths
BASE_DIR = os.path.join(get_app_root(), "")
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.getenv("ODYSSEUS_DATA_DIR", get_default_data_dir())

# UI localization (i18n)
# Translation catalogs are served as static assets from LOCALES_DIR
# (static/locales/<lang>.json). SUPPORTED_UI_LANGUAGES is the single source of
# truth for which language codes the UI accepts; add a code here and drop a
# matching <lang>.json to ship another language.
LOCALES_DIR = os.path.join(STATIC_DIR, "locales")
SUPPORTED_UI_LANGUAGES = ("en", "es")
DEFAULT_UI_LANGUAGE = "en"
UI_LANGUAGE_COOKIE = "odysseus_lang"

# ── Local speech-to-text defaults ──
#
# These live HERE, in the leaf module, because three places need the same value
# and they drifted apart the moment they each kept their own copy:
# ``DEFAULT_SETTINGS`` (src/settings.py), the STT service's module constants,
# and the reset that runs when a voice endpoint is deleted (routes/model_routes).
# Whoever wins is decided by ``load_settings()``, which merges
# ``{**DEFAULT_SETTINGS, **saved}`` — so the copy in ``DEFAULT_SETTINGS`` is the
# one the decoder actually sees, and a "fix" applied to either of the other two
# is dead code. One definition, imported by all three, makes that impossible.
#
# large-v3-turbo, not large-v3: 4 decoder layers instead of 32, so it decodes
# several times faster with a quality loss that only shows on long audio and
# low-resource languages — dictation is neither. `base` is where most of the
# mangled tech jargon came from; if turbo is ever too slow on a given box the
# step down is `medium`, never back to `base`.
DEFAULT_STT_MODEL = "large-v3-turbo"
# NEVER "" (autodetection): on ~3s clips Whisper picks the language about as
# often as a coin flip and transcribes Spanish as phonetic English.
DEFAULT_STT_LANGUAGE = "es"
# A BARE TERM LIST, never a sentence — this is the whole fix for the prompt
# echo. faster-whisper feeds ``initial_prompt`` to the decoder as a text
# *prefix*, not as an instruction, so with nothing to transcribe the model
# simply continues it. Measured on the running box (large-v3, near-silent clip,
# 2026-09-07):
#
#   prose prompt ("Transcripción de dictado técnico en español de México.
#   Términos frecuentes: …")  ->  "Términos frecuentes en español de México.
#                                  Términos frecuentes en español de México."
#   this bare list             ->  no echo
#   no prompt at all           ->  no echo
#
# That echo is what leaked into a real dictation as "El piso está enladrillado.
# Términos frecuentes en ladrillera." — the prefix continued and fused with the
# audio. A comma-separated glossary still biases the vocabulary (which is the
# only reason to send a prompt at all) but offers no sentence to complete, so
# it keeps the benefit without the failure mode. Keep it a list: any prose
# added here brings the echo back.
DEFAULT_STT_INITIAL_PROMPT = (
    "Whisper, cuantización, MCP, endpoint, VRAM, faster-whisper, ctranslate2, "
    "push-to-talk, latencia, commit, deploy, backend, axon, Odysseus."
)

# Data file paths
# Single source of truth: every persisted file/dir lives under DATA_DIR, which
# is the ONLY place ODYSSEUS_DATA_DIR is read. Import these constants instead of
# re-deriving paths from __file__ or a relative "data" literal.
SESSIONS_FILE = os.path.join(DATA_DIR, "sessions.json")
MEMORY_FILE = os.path.join(DATA_DIR, "memory.json")
PERSONAL_DIR = os.path.join(DATA_DIR, "personal_docs")
RUNBOOK_DIR = os.path.join(PERSONAL_DIR, "runbook")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
FEATURES_FILE = os.path.join(DATA_DIR, "features.json")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
AUTH_FILE = os.path.join(DATA_DIR, "auth.json")
USER_PREFS_FILE = os.path.join(DATA_DIR, "user_prefs.json")
PRESETS_FILE = os.path.join(DATA_DIR, "presets.json")
INTEGRATIONS_FILE = os.path.join(DATA_DIR, "integrations.json")
CONTACTS_FILE = os.path.join(DATA_DIR, "contacts.json")
APP_KEY_FILE = os.path.join(DATA_DIR, ".app_key")
EMBEDDING_ENDPOINT_FILE = os.path.join(DATA_DIR, "embedding_endpoint.json")
COOKBOOK_STATE_FILE = os.path.join(DATA_DIR, "cookbook_state.json")
BG_JOBS_FILE = os.path.join(DATA_DIR, "bg_jobs.json")
VAULT_FILE = os.path.join(DATA_DIR, "vault.json")
TIDY_CALENDAR_STATE_FILE = os.path.join(DATA_DIR, "tidy_calendar_state.json")
SKILLS_FILE = os.path.join(DATA_DIR, "skills.json")
APP_DB = os.path.join(DATA_DIR, "app.db")
SCHEDULED_EMAILS_DB = os.path.join(DATA_DIR, "scheduled_emails.db")
EMAIL_CACHE_DB = os.path.join(DATA_DIR, "email_cache.db")

# Data subdirectories
PERSONAL_UPLOADS_DIR = os.path.join(DATA_DIR, "personal_uploads")
EMOJI_CACHE_DIR = os.path.join(DATA_DIR, "emoji_cache")
RAG_DIR = os.path.join(DATA_DIR, "rag")
CHROMA_DIR = os.path.join(DATA_DIR, "chroma")
BG_JOBS_DIR = os.path.join(DATA_DIR, "bg_jobs")
DEEP_RESEARCH_DIR = os.path.join(DATA_DIR, "deep_research")
MCP_OAUTH_DIR = os.path.join(DATA_DIR, "mcp_oauth")
GENERATED_IMAGES_DIR = os.path.join(DATA_DIR, "generated_images")
TTS_CACHE_DIR = os.path.join(DATA_DIR, "tts_cache")
EMAIL_URGENCY_CACHE_DIR = os.path.join(DATA_DIR, "email_urgency_cache")
SKILLS_DIR = os.path.join(DATA_DIR, "skills")
GALLERY_DIR = os.path.join(DATA_DIR, "gallery")
GALLERY_UPLOADS_DIR = os.path.join(DATA_DIR, "gallery_uploads")
MEMORY_VECTORS_DIR = os.path.join(DATA_DIR, "memory_vectors")

# Paths with an intentional dedicated env override, defaulting under DATA_DIR.
MAIL_ATTACHMENTS_DIR = os.getenv("ODYSSEUS_MAIL_ATTACHMENTS_DIR", os.path.join(DATA_DIR, "mail-attachments"))
# `or` (not os.getenv's default arg) so a PRESENT-but-EMPTY value falls back to
# the default. docker-compose.yml injects `FASTEMBED_CACHE_PATH=${FASTEMBED_CACHE_PATH:-}`,
# which sets the var to "" when the host hasn't defined it. os.getenv(name, default)
# only returns the default when the var is ABSENT, so the empty string would win →
# os.makedirs("") raises [Errno 2] No such file or directory: '' → FastEmbed fails to
# init and all vector features (RAG, semantic memory, tool index) silently degrade.
FASTEMBED_CACHE_DIR = os.getenv("FASTEMBED_CACHE_PATH") or os.path.join(DATA_DIR, "fastembed_cache")

# Agent tool output limits (single source of truth — imported by tool_execution.py,
# tool_implementations.py, agent_tools.py, and any other module that needs them)
MAX_OUTPUT_CHARS = 10_000       # cap for bash/python/web_search/web_fetch output
MAX_READ_CHARS = 20_000         # cap for read_file / document preview
MAX_DIFF_LINES = 400            # cap for edit_file unified-diff display

# web_fetch response-size policy (#3812). MAX_OUTPUT_CHARS above only trims
# what the agent SEES; these caps bound what the server downloads, parses,
# and writes to the content cache. The soft cap is the default download
# budget; the agent can raise it per call (full/max_bytes) but never past
# the hard cap, so a model can't decide to pull a multi-GB file.
WEB_FETCH_SOFT_MAX_BYTES = 2_000_000    # default download budget (2 MB)
WEB_FETCH_HARD_MAX_BYTES = 20_000_000   # absolute ceiling, even with override (20 MB)

# API Configuration
MAX_CONTEXT_MESSAGES = 90
REQUEST_TIMEOUT = 20
OPENAI_COMPAT_PATH = "/v1/chat/completions"

# Outbound UA for web_fetch / web_search scraping; common desktop UA so pages serve normal HTML.
WEB_FETCH_USER_AGENT = os.environ.get(
    "WEB_FETCH_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
)

# Environment variables with defaults
DEFAULT_HOST = os.getenv("LLM_HOST", "localhost")
LLM_HOSTS = [h.strip() for h in os.getenv("LLM_HOSTS", "").split(",") if h.strip()]
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
SEARXNG_INSTANCE = os.getenv("SEARXNG_INSTANCE", "http://localhost:8080")


# Cleanup configuration
CLEANUP_ENABLED = os.getenv("CLEANUP_ENABLED", "True").lower() == "true"
CLEANUP_INTERVAL_HOURS = int(os.getenv("CLEANUP_INTERVAL_HOURS", "24"))

# Auth policy
PASSWORD_MIN_LENGTH = 8

# Default parameters
DEFAULT_TEMPERATURE = 1.0
DEFAULT_MAX_TOKENS = 0


def internal_api_base() -> str:
    """Base URL for in-process loopback calls to Odysseus's own API.

    Agent tools and background jobs reach admin-gated routes by calling the
    running server over HTTP. Resolution order:
      1. ODYSSEUS_INTERNAL_BASE  - explicit override (e.g. behind a TLS proxy).
      2. APP_PORT                - http://127.0.0.1:$APP_PORT (docker-compose).
      3. Fallback http://127.0.0.1:7000 - legacy default.

    127.0.0.1 (not "localhost") avoids IPv6/DNS ambiguity for a strictly-local
    call. Without this, loopback tools fail with "All connection attempts
    failed" whenever the server is not on port 7000.
    """
    override = os.environ.get("ODYSSEUS_INTERNAL_BASE")
    if override:
        return override.rstrip("/")
    return f"http://127.0.0.1:{os.environ.get('APP_PORT', '7000')}"
