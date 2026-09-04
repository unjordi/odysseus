// static/js/voiceRecorder.js

/**
 * Voice recording with optional Speech-to-Text transcription.
 *
 * STT providers:
 *   "disabled"       — record audio as file attachment (original behavior)
 *   "browser"        — use Web Speech API for real-time transcription
 *   "local"          — send recording to server /api/stt/transcribe (Whisper)
 *   "endpoint:<id>"  — send recording to server /api/stt/transcribe (API)
 *
 * Two capture modes live here:
 *   - startRecording/stopRecording — legacy single-shot batch capture (used by
 *     the send-button's mic overlay): records one clip start-to-stop, then
 *     transcribes it once.
 *   - startWhisperFlow/stopWhisperFlow — continuous "whisper-flow" dictation
 *     (used by the dedicated composer mic button, #voice-input-btn): keeps
 *     listening and inserts text into the composer as it goes, so it feels
 *     live even though the server-side providers only transcribe in batch.
 *     "browser" gets true incremental results from the Web Speech API;
 *     "local"/"endpoint:<id>" fake the streaming feel by restarting a short
 *     (~3.5s) recording in a loop and transcribing each segment as it lands.
 */

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordingStartTime = null;
let recordingInterval = null;

// Browser STT state
let _recognition = null;
let _browserTranscript = '';

// Cached STT provider — refreshed on settings change
let _sttProvider = 'disabled';

/**
 * Set the cached provider and notify anyone rendering STT-dependent UI
 * (the send button's mic overlay, and the dedicated composer mic button).
 * This is the single place that mutates `_sttProvider` so both the settings
 * panel (via the exported setter) and our own fetch below stay in sync.
 */
function _setSttProvider(v) {
  _sttProvider = v || 'disabled';
  if (window._updateSendBtnIcon) window._updateSendBtnIcon();
  if (window._syncVoiceFlowAvailability) window._syncVoiceFlowAvailability();
}

/**
 * Fetch current STT provider from server settings
 */
async function refreshSttProvider() {
  try {
    const res = await fetch('/api/stt/stats', { credentials: 'same-origin' });
    if (res.ok) {
      const stats = await res.json();
      _setSttProvider(stats.provider);
    }
  } catch (e) {
    console.warn('Failed to fetch STT stats:', e);
  }
}

/**
 * Format seconds as MM:SS
 */
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secs = (seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

/**
 * Reset UI state after recording ends
 */
function _resetRecordingUI() {
  isRecording = false;
  if (recordingInterval) {
    clearInterval(recordingInterval);
    recordingInterval = null;
  }
  // Reset send button via global callback
  const sendBtn = document.querySelector('.send-btn');
  if (sendBtn) {
    sendBtn.classList.remove('recording');
    sendBtn.dataset.mode = '';
  }
  if (window._updateSendBtnIcon) {
    setTimeout(window._updateSendBtnIcon, 50);
  }
}

/**
 * Start browser speech recognition alongside recording
 */
function startBrowserSTT() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  _browserTranscript = '';
  _recognition = new SpeechRecognition();
  _recognition.continuous = true;
  _recognition.interimResults = false;
  _recognition.lang = '';

  _recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        _browserTranscript += event.results[i][0].transcript + ' ';
      }
    }
  };

  _recognition.onerror = (e) => {
    console.warn('Browser STT error:', e.error);
  };

  _recognition.start();
}

function stopBrowserSTT() {
  if (_recognition) {
    try { _recognition.stop(); } catch (e) { /* ignore */ }
    _recognition = null;
  }
  return _browserTranscript.trim();
}

/**
 * Send audio to server for transcription
 */
async function transcribeOnServer(audioBlob) {
  const formData = new FormData();
  formData.append('file', audioBlob, 'audio.webm');

  const res = await fetch('/api/stt/transcribe', {
    method: 'POST',
    credentials: 'same-origin',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail?.message || 'Transcription failed');
  }

  const data = await res.json();
  return data.text || '';
}

/**
 * Insert transcribed text into the chat input
 */
function insertTranscription(text, showToast) {
  if (!text) return;
  const input = document.getElementById('message');
  if (!input) return;

  const existing = input.value.trim();
  input.value = existing ? existing + ' ' + text : text;

  // Trigger auto-resize and icon update
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();

  if (showToast) showToast('Transcribed');
}

// ────────────────────────────────────────────────────────────────────────
// Whisper-flow: continuous dictation integrated into the composer
// ────────────────────────────────────────────────────────────────────────

const FLOW_SEGMENT_MS = 3500; // how long each server-side segment records for

let _flowActive = false;
let _flowStream = null;
let _flowSegmentRecorder = null;
let _flowSegmentTimer = null;
let _flowQueue = Promise.resolve(); // serializes segment transcriptions so text lands in order
let _flowRecognition = null;
let _flowOnInsert = null;
let _flowOnState = null;
let _flowShowError = null;
let _flowServerErrorShown = false;

function _flowSetState(state, interim) {
  if (_flowOnState) _flowOnState(state, interim || '');
}

function _flowInsert(text) {
  if (!text || !text.trim()) return;
  if (_flowOnInsert) _flowOnInsert(text.trim());
}

/**
 * True incremental path — the Web Speech API streams interim + final results
 * as the user talks, no server round-trip needed.
 */
function _startFlowBrowser() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return false;

  _flowRecognition = new SpeechRecognition();
  _flowRecognition.continuous = true;
  _flowRecognition.interimResults = true;
  _flowRecognition.lang = '';

  _flowRecognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        _flowInsert(result[0].transcript);
      } else {
        interim += result[0].transcript;
      }
    }
    _flowSetState(interim ? 'interim' : 'listening', interim);
  };

  _flowRecognition.onerror = (e) => {
    console.warn('Whisper-flow browser STT error:', e.error);
    if (e.error === 'no-speech' || e.error === 'aborted') return; // benign, keep listening
    if (_flowShowError) _flowShowError('Voice recognition error: ' + e.error);
  };

  // Chrome/webkit auto-stop recognition after a pause — restart transparently
  // while the user hasn't asked us to stop, so it feels continuous.
  _flowRecognition.onend = () => {
    if (!_flowActive) return;
    setTimeout(() => {
      if (!_flowActive || !_flowRecognition) return;
      try { _flowRecognition.start(); } catch (_) { /* already running */ }
    }, 200);
  };

  try {
    _flowRecognition.start();
  } catch (e) {
    return false;
  }
  return true;
}

function _stopFlowBrowserOnly() {
  if (_flowRecognition) {
    const rec = _flowRecognition;
    _flowRecognition = null;
    rec.onend = null;
    try { rec.stop(); } catch (_) { /* ignore */ }
  }
}

/**
 * Server-side segmented path — for "local"/"endpoint:<id>" providers that
 * only transcribe a full clip at a time. Records short (~3.5s) segments back
 * to back on the same mic stream, transcribes each as it lands, and appends
 * the text — so it reads as a live flow instead of one long wait.
 */
function _recordFlowSegment(stream) {
  if (!_flowActive) return;

  const chunks = [];
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  } catch (e) {
    if (_flowShowError) _flowShowError('Recording failed: ' + e.message);
    stopWhisperFlow();
    return;
  }
  _flowSegmentRecorder = rec;

  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  rec.onstop = () => {
    const wasActive = _flowActive; // capture before scheduling the next segment
    const blob = new Blob(chunks, { type: 'audio/webm' });

    // Skip near-empty segments (e.g. the very last one right after Stop).
    if (blob.size > 800) {
      _flowSetState('transcribing');
      _flowQueue = _flowQueue
        .then(() => transcribeOnServer(blob))
        .then((text) => {
          if (text) _flowInsert(text);
          if (_flowActive) _flowSetState('listening');
        })
        .catch((e) => {
          console.error('Whisper-flow segment transcription failed:', e);
          if (!_flowServerErrorShown) {
            _flowServerErrorShown = true;
            if (_flowShowError) _flowShowError('Transcription failed: ' + e.message);
            stopWhisperFlow();
          }
        });
    }

    if (wasActive) {
      _flowSegmentTimer = setTimeout(() => _recordFlowSegment(stream), 0);
    }
  };

  rec.start();
  _flowSegmentTimer = setTimeout(() => {
    if (rec.state === 'recording') rec.stop();
  }, FLOW_SEGMENT_MS);
}

/**
 * Start continuous "whisper-flow" dictation into the composer.
 * @param {object} opts
 * @param {(text: string) => void} opts.onInsert - called with each finalized
 *   chunk of transcript to insert into the message input.
 * @param {(state: 'listening'|'interim'|'transcribing'|'idle', interim?: string) => void} [opts.onState]
 * @param {(msg: string, duration?: number) => void} [opts.showToast]
 * @param {(msg: string) => void} [opts.showError]
 */
export function startWhisperFlow(opts) {
  const { onInsert, onState, showToast, showError } = opts || {};
  if (_flowActive || isRecording) return; // one capture session at a time

  if (!window.isSecureContext) {
    if (showError) showError('Microphone requires HTTPS. Use a reverse proxy with SSL or access via localhost.');
    return;
  }

  _flowOnInsert = onInsert;
  _flowOnState = onState;
  _flowShowError = showError;
  _flowServerErrorShown = false;
  _flowQueue = Promise.resolve();

  if (_sttProvider === 'disabled') {
    if (showError) showError('Enable Speech-to-text in Settings to dictate by voice.');
    return;
  }

  if (_sttProvider === 'browser') {
    _flowActive = true;
    const ok = _startFlowBrowser();
    if (!ok) {
      _flowActive = false;
      if (showError) showError('Voice recognition is not supported in this browser.');
      return;
    }
    _flowSetState('listening');
    if (showToast) showToast('Listening…');
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (showError) showError('Microphone not supported in this browser.');
    return;
  }

  _flowActive = true;
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => {
      if (!_flowActive) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      _flowStream = stream;
      _flowSetState('listening');
      if (showToast) showToast('Listening…');
      _recordFlowSegment(stream);
    })
    .catch((error) => {
      _flowActive = false;
      console.error('Whisper-flow microphone error:', error);
      if (showError) {
        if (error.name === 'NotAllowedError') {
          showError('Microphone access denied. Check browser permissions.');
        } else if (error.name === 'NotFoundError') {
          showError('No microphone found.');
        } else {
          showError('Microphone error: ' + error.message);
        }
      }
      _flowSetState('idle');
    });
}

/**
 * Stop whisper-flow dictation. Any in-flight segment is still transcribed
 * and inserted (so the last thing the user said isn't dropped), it just
 * won't schedule another segment afterwards.
 */
export function stopWhisperFlow() {
  if (!_flowActive) return;
  _flowActive = false;

  clearTimeout(_flowSegmentTimer);
  _flowSegmentTimer = null;

  _stopFlowBrowserOnly();

  if (_flowSegmentRecorder && _flowSegmentRecorder.state === 'recording') {
    _flowSegmentRecorder.stop();
  }
  _flowSegmentRecorder = null;

  if (_flowStream) {
    _flowStream.getTracks().forEach((t) => t.stop());
    _flowStream = null;
  }

  _flowSetState('idle');
}

export function isWhisperFlowActive() {
  return _flowActive;
}

/**
 * Start voice recording
 */
export function startRecording(onFileCreated, showToast, showError) {
  if (_flowActive) return; // whisper-flow dictation already owns the mic

  // Check for secure context (getUserMedia requires HTTPS or localhost)
  if (!window.isSecureContext) {
    if (showError) showError('Microphone requires HTTPS. Use a reverse proxy with SSL or access via localhost.');
    _resetRecordingUI();
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (showError) showError('Microphone not supported in this browser.');
    _resetRecordingUI();
    return;
  }

  audioChunks = [];

  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

      mediaRecorder.ondataavailable = event => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());

        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        const provider = _sttProvider;

        if (provider === 'browser') {
          const transcript = stopBrowserSTT();
          if (transcript) {
            insertTranscription(transcript, showToast);
          } else {
            if (showToast) showToast('No speech detected');
            const audioFile = new File([audioBlob], `voice-message-${Date.now()}.webm`, { type: 'audio/webm' });
            if (onFileCreated) onFileCreated(audioFile);
          }
        } else if (provider === 'local' || provider.startsWith('endpoint:')) {
          // Show "Transcribing..." feedback
          if (showToast) showToast('Transcribing...', 5000);
          try {
            const transcript = await transcribeOnServer(audioBlob);
            if (transcript) {
              insertTranscription(transcript, showToast);
            } else {
              if (showToast) showToast('No speech detected');
            }
          } catch (e) {
            console.error('STT transcription error:', e);
            if (showError) showError('Transcription failed: ' + e.message);
            // Fallback: attach as file
            const audioFile = new File([audioBlob], `voice-message-${Date.now()}.webm`, { type: 'audio/webm' });
            if (onFileCreated) onFileCreated(audioFile);
          }
        } else {
          // STT disabled — attach audio file
          const audioFile = new File([audioBlob], `voice-message-${Date.now()}.webm`, { type: 'audio/webm' });
          if (onFileCreated) onFileCreated(audioFile);
        }

        _resetRecordingUI();
      };

      mediaRecorder.start();
      isRecording = true;
      recordingStartTime = new Date();

      // Start browser STT if that's the provider
      if (_sttProvider === 'browser') {
        startBrowserSTT();
      }

      if (showToast) {
        showToast('Recording...');
      }
    })
    .catch(error => {
      console.error('Microphone access error:', error);
      if (showError) {
        if (error.name === 'NotAllowedError') {
          showError('Microphone access denied. Check browser permissions.');
        } else if (error.name === 'NotFoundError') {
          showError('No microphone found.');
        } else {
          showError('Microphone error: ' + error.message);
        }
      }
      _resetRecordingUI();
    });
}

/**
 * Stop voice recording
 */
export function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    // isRecording will be set to false in _resetRecordingUI called from onstop
  } else {
    _resetRecordingUI();
  }
}

/**
 * Check if currently recording
 */
export function getIsRecording() {
  return isRecording;
}

/**
 * Initialize recording state
 */
export function init() {
  isRecording = false;
  refreshSttProvider();
}

const voiceRecorderModule = {
  startRecording,
  stopRecording,
  getIsRecording,
  startWhisperFlow,
  stopWhisperFlow,
  isWhisperFlowActive,
  init,
  refreshSttProvider,
  get _sttProvider() { return _sttProvider; },
  set _sttProvider(v) { _setSttProvider(v); },
};

export default voiceRecorderModule;
