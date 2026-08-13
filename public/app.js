const tokenFromUrl = new URLSearchParams(window.location.search).get('token');
if (tokenFromUrl) {
  localStorage.setItem('aura_access_token', tokenFromUrl);
  history.replaceState({}, document.title, window.location.pathname);
}
const authHash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
const loginIdFromUrl = new URLSearchParams(window.location.search).get('aura_login');
if (loginIdFromUrl) {
  localStorage.setItem('aura_callback_login_id', loginIdFromUrl);
}
if (authHash.get('access_token')) {
  localStorage.setItem('aura_session_token', authHash.get('access_token'));
  if (authHash.get('refresh_token')) {
    localStorage.setItem('aura_refresh_token', authHash.get('refresh_token'));
  }
  localStorage.removeItem('aura_access_token');
  history.replaceState({}, document.title, window.location.pathname);
}
let auraAccessToken = localStorage.getItem('aura_access_token') || '';
let auraSessionToken = localStorage.getItem('aura_session_token') || '';
let auraRefreshToken = localStorage.getItem('aura_refresh_token') || '';
let authPromptOpen = false;
let authMode = null;
let refreshPromise = null;
let loginPollPromise = null;

async function completeLinkCallback() {
  const loginId = localStorage.getItem('aura_callback_login_id');
  if (!auraSessionToken || !auraRefreshToken) return;
  try {
    const response = await fetch('/auth/complete-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login_id: loginId,
        access_token: auraSessionToken,
        refresh_token: auraRefreshToken
      })
    });
    if (response.ok) localStorage.removeItem('aura_callback_login_id');
  } catch (error) {
    console.error('Could not complete device sign-in:', error);
  }
}

function pollPendingLogin() {
  const loginId = localStorage.getItem('aura_pending_login_id');
  if (!loginId) return Promise.resolve(false);
  if (loginPollPromise) return loginPollPromise;
  loginPollPromise = (async () => {
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        const response = await fetch('/auth/link-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ login_id: loginId })
        });
        if (response.status === 410) {
          localStorage.removeItem('aura_pending_login_id');
          return false;
        }
        if (response.ok) {
          const session = await response.json();
          if (session.ready && session.access_token && session.refresh_token) {
            localStorage.setItem('aura_session_token', session.access_token);
            localStorage.setItem('aura_refresh_token', session.refresh_token);
            localStorage.removeItem('aura_access_token');
            localStorage.removeItem('aura_pending_login_id');
            window.location.reload();
            return true;
          }
        }
      } catch {
        // A backgrounded iPhone browser can briefly suspend its network access.
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return false;
  })().finally(() => {
    loginPollPromise = null;
  });
  return loginPollPromise;
}

async function getAuthMode() {
  if (authMode) return authMode;
  try {
    const response = await fetch('/auth/config');
    authMode = (await response.json()).mode || 'token';
  } catch {
    authMode = 'token';
  }
  return authMode;
}

async function requestAccessToken() {
  if (authPromptOpen) return;
  if (localStorage.getItem('aura_pending_login_id')) {
    pollPendingLogin();
    return;
  }
  authPromptOpen = true;
  const mode = await getAuthMode();
  if (mode === 'supabase') {
    const input = window.prompt(
      'Enter your email address and AURA will send you a secure sign-in link.\n' +
      'Or, if you already have an AURA access token, paste it here instead:'
    );
    const value = input && input.trim();
    if (value && !value.includes('@')) {
      // A Home Screen "Add to Home Screen" launch has its own isolated storage
      // on iOS, so a device paired via Safari's magic-link flow won't show as
      // signed in here. This lets an access token pair it directly, with no
      // address bar (and thus no /?token= link) available in standalone mode.
      localStorage.setItem('aura_access_token', value);
      authPromptOpen = false;
      window.location.reload();
      return;
    }
    if (value) {
      const response = await fetch('/auth/request-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: value })
      });
      if (response.ok) {
        const result = await response.json();
        if (result.login_id) {
          localStorage.setItem('aura_pending_login_id', result.login_id);
          pollPendingLogin();
        }
        window.alert('Check your email and open the AURA sign-in link on this device.');
      } else {
        window.alert('AURA could not send the sign-in link. Please try again.');
      }
    }
    authPromptOpen = false;
    return;
  }
  if (mode === 'tailscale') {
    authPromptOpen = false;
    window.alert('AURA is available only through your authenticated Tailscale connection. Make sure Tailscale is connected, then reload this page.');
    return;
  }
  const token = window.prompt('Enter your AURA access token to pair this device:');
  authPromptOpen = false;
  if (token && token.trim()) {
    localStorage.setItem('aura_access_token', token.trim());
    window.location.reload();
  }
}

async function refreshSupabaseSession() {
  if (!auraRefreshToken) return false;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const response = await fetch('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: auraRefreshToken })
      });
      if (!response.ok) return false;
      const session = await response.json();
      if (!session.access_token || !session.refresh_token) return false;
      auraSessionToken = session.access_token;
      auraRefreshToken = session.refresh_token;
      localStorage.setItem('aura_session_token', auraSessionToken);
      localStorage.setItem('aura_refresh_token', auraRefreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

function clearAuthentication() {
  localStorage.removeItem('aura_access_token');
  localStorage.removeItem('aura_session_token');
  localStorage.removeItem('aura_refresh_token');
  auraAccessToken = '';
  auraSessionToken = '';
  auraRefreshToken = '';
}

const authenticatedFetch = async (url, options = {}) => {
  const send = () => fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(auraSessionToken
        ? { Authorization: `Bearer ${auraSessionToken}` }
        : auraAccessToken
          ? { 'X-AURA-Token': auraAccessToken }
          : {})
    }
  });
  let response = await send();
  if (response.status === 401 && auraRefreshToken && await refreshSupabaseSession()) {
    response = await send();
  }
  if (response.status === 401 && window.location.hostname !== 'localhost' &&
      window.location.hostname !== '127.0.0.1') {
    clearAuthentication();
    requestAccessToken();
  }
  return response;
};

// Audio diagnostics contain signal measurements only: never PCM, transcripts,
// device labels, or other microphone content. Keep the client budget low so a
// noisy room cannot turn diagnostics into request spam.
function recordVadDiagnostic(kind, phase, metrics = {}) {
  const now = Date.now();
  const key = `${kind}:${phase}`;
  const previous = vadDiagnosticLastAt.get(key) || 0;
  if (vadDiagnosticCount >= 16 || now - previous < 1000) return;
  vadDiagnosticCount += 1;
  vadDiagnosticLastAt.set(key, now);
  const payload = {
    kind,
    phase,
    level: Number(metrics.rms) || 0,
    confidence: Number(metrics.confidence) || 0,
    noise_floor: Number(metrics.noiseFloor) || 0,
    duration_ms: Math.max(0, Math.round(Number(metrics.durationMs) || 0)),
    occurred_at: new Date(now).toISOString(),
    reason: String(metrics.reason || '').slice(0, 40)
  };
  console.info('[audio-vad]', payload);
  authenticatedFetch('/api/audio/vad-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true
  }).catch(() => {});
}

function rememberVoiceFinal(reason) {
  lastVoiceFinalizedAt = Date.now();
  lastVoiceFinalReason = String(reason || 'unknown').slice(0, 40);
}

completeLinkCallback();
pollPendingLogin();

const socket = io({
  auth: { token: auraSessionToken || auraAccessToken },
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
});

const orb = document.getElementById('orb');
const statusText = document.getElementById('status-text');
const conversationToggle = document.getElementById('conversation-toggle');
const volumeToggle = document.getElementById('volume-toggle');
const transcriptPanel = document.getElementById('transcript-panel');
const transcriptContent = document.getElementById('transcript-content');
const sourcePanel = document.getElementById('source-panel');
const sourceLabel = document.getElementById('source-label');
const webAnswer = document.getElementById('web-answer');
const sourceLinks = document.getElementById('source-links');
const voiceWave = document.getElementById('voice-wave');
const voiceWaveContext = voiceWave.getContext('2d');
const auraMesh = document.getElementById('aura-mesh');
const auraMeshContext = auraMesh.getContext('2d');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const mobileMesh = window.matchMedia('(max-width: 700px), (pointer: coarse)');
const localMeshQualityPreview = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
  ? new URLSearchParams(window.location.search).get('aura_mesh_quality')
  : null;

const DESKTOP_MESH_PROFILE = Object.freeze({
  name: 'desktop', pixelRatio: 2, fps: 30,
  latitudeLines: 20, longitudeLines: 30,
  latitudeSteps: 72, longitudeSteps: 48,
  edgeSteps: 120, particles: 72, lineGlow: true
});
const MOBILE_MESH_PROFILE = Object.freeze({
  name: 'mobile', pixelRatio: 1.5, fps: 30,
  latitudeLines: 12, longitudeLines: 18,
  latitudeSteps: 48, longitudeSteps: 32,
  edgeSteps: 72, particles: 42, lineGlow: false
});
const LOW_MESH_PROFILE = Object.freeze({
  name: 'low', pixelRatio: 1.25, fps: 20,
  latitudeLines: 9, longitudeLines: 14,
  latitudeSteps: 36, longitudeSteps: 24,
  edgeSteps: 54, particles: 28, lineGlow: false
});
const MICROPHONE_VISUAL_INTERVAL_MS = 1000 / 30;

// Global audio player for iOS Safari unlocking
const audioPlayer = new Audio();

// Conversation mode: after AURA finishes speaking, reopen the mic and
// auto-stop on a short pause. This is NOT the old ambient always-on /
// wake-word path — listening only arms for the next reply, which was the
// reliable middle ground after always-on proved spotty.
const CONVERSATION_MODE_KEY = 'aura_conversation_mode';
// Phone volume alone often isn't enough — iOS routes <audio> through Web
// Audio at unity gain, and Cartesia WAVs sit a bit quiet. A GainNode lets
// playback go louder than the HTMLMediaElement 0..1 ceiling.
const PLAYBACK_VOLUME_KEY = 'aura_playback_volume';
const PLAYBACK_VOLUME_LEVELS = {
  low: 1.15,
  medium: 1.7,
  high: 2.25
};
// Give natural pauses room before either local fallback path submits a turn.
// Deepgram streaming uses the matching 700ms endpointing value server-side.
const SILENCE_HANGOVER_MS = 700;
const MAX_UTTERANCE_MS = 60000;
const STREAM_MAX_UTTERANCE_MS = 60000;
const DEEPGRAM_STREAM_SAMPLE_RATE = 16000;
// If the mic arms after her reply and nobody speaks, drop back to idle
// instead of holding the mic open until MAX_UTTERANCE_MS.
const NO_SPEECH_IDLE_MS = 8000;
// Calibrate the local room floor before accepting speech. The adaptive VAD
// then applies a 220ms confidence window and separate start/continue gates.
const LISTEN_ARM_GRACE_MS = 650;
const SPEECH_CONFIDENCE_WINDOW_MS = 220;
const { buildProcessedAudioConstraints, createAdaptiveVad } = window.AuraAudioVad;

function processedMicrophoneConstraints() {
  const supported = navigator.mediaDevices?.getSupportedConstraints?.() || null;
  return buildProcessedAudioConstraints(supported);
}

let isListening = false;
let isSpeaking = false;
let audioUnlocked = false;
let silenceWatchFrame = null;
let silenceListenContext = null;
let listeningFromConversation = false;
// When true, the next mediaRecorder.onstop should release the mic without
// sending audio (no-speech idle timeout / explicit cancel).
let discardNextRecording = false;
let audioContext = null;
let audioAnalyser = null;
let audioSource = null;
let playbackGainNode = null;
let waveformSamples = null;
let waveformFrame = null;
// Advances every frame so the wave travels on its own. The analyser only
// scales this motion, so the wave still animates when it reports silence
// (or when the audio graph is unavailable, as on a locked-down iPhone).
let waveformPhase = 0;
// Smoothed 0..1 loudness from her actual voice, used as amplitude gain.
let waveformEnergy = 0;
// Smoothed 0..1 loudness from Chris's microphone while AURA is listening.
// Kept separate from playback energy so each side of the conversation can
// give the mesh its own character without leaking across state changes.
let microphoneEnergy = 0;
let microphoneEnergyUpdatedAt = 0;
let microphoneEnergySquareSum = 0;
let microphoneEnergyReadingCount = 0;
let meshPhase = 0;
let meshFrame = null;
let meshLastFrameAt = 0;
let meshSlowFrameScore = 0;
let meshLowQuality = false;
let meshStyleSignature = '';

let mediaRecorder = null;
let audioChunks = [];
let sttStreamingEnabled = false;
let streamListenActive = false;
let streamMedia = null;
let streamAudioCtx = null;
let streamSource = null;
let streamProcessor = null;
let streamMute = null;
let streamMaxTimer = null;
let streamNoSpeechTimer = null;
let streamFinalHandler = null;
let streamPartialHandler = null;
let streamErrorHandler = null;
let streamEndpointAt = null;

// Conversation-mode barge-in capture. This is deliberately separate from
// ordinary listening: it watches only while AURA audio is actually playing,
// keeps a short pre-roll, and hands that same microphone route to Deepgram
// when Chris speaks over her.
const BARGE_IN_GRACE_MS = 650;
const BARGE_IN_SUSTAIN_MS = 220;
const BARGE_IN_GAP_TOLERANCE_MS = 120;
const BARGE_IN_PRE_ROLL_SAMPLES = 3200; // 200ms at 16kHz
const BARGE_IN_CAPTURE_MAX_SAMPLES = 64000; // preserve up to 4s through handoff
const BARGE_IN_MIN_RMS = 0.03;
let bargeInActive = false;
let bargeInTriggered = false;
let bargeInMedia = null;
let bargeInAudioCtx = null;
let bargeInSource = null;
let bargeInProcessor = null;
let bargeInMute = null;
let bargeInNoiseFloor = 0.008;
let bargeInVad = null;
let bargeInPreRoll = [];
let bargeInPreRollSamples = 0;
let bargeInUtterancePcm = [];
let bargeInUtteranceSamples = 0;

// True from the moment a recording is handed off to processAudio() until
// its reply (or error) is fully resolved. Guards against a second tap
// during a slow request (e.g. a cold Render boot) starting an overlapping
// turn - without this, two concurrent processAudio() calls race to write
// the same orb/audio-queue state, and whichever's slow backend response
// resolves last wins the display, regardless of which question it answers.
let isProcessing = false;
// Bumped at the start of every processAudio() call. A turn only applies
// its own UI writes while its token still matches - if a newer turn started
// (or the run was superseded) while this one's fetch was in flight, its
// stale result is discarded instead of overwriting the newer exchange.
let currentTurn = 0;

// Tracks the clip currently loaded so it can be torn down on interrupt.
let currentAudioUrl = null;
// Set when the user interrupts, so a reply whose audio is still being
// generated doesn't start playing after they've told her to stop.
let playbackCancelled = false;
// Aborts in-flight transcribe/chat/TTS fetches when Chris barges in.
let turnAbortController = null;
let activeChatTurnId = null;
let currentStreamedReplyParts = [];
let pendingInterruptedReply = '';
let preserveBargeInOnNextCancel = false;
let lastVoiceFinalizedAt = 0;
let lastVoiceFinalReason = '';
let vadDiagnosticCount = 0;
const vadDiagnosticLastAt = new Map();
// Idle "hey Aura" wake listener (Web Speech). Created after startListening exists.
let wakeListener = null;

// Hard-stop the active turn: mute audio, invalidate in-flight processAudio,
// abort network work, and drop the speech queue so a barge-in can't get
// overwritten by a stale reply that finishes later.
function cancelActiveTurn() {
  const preserveBargeInMonitor = preserveBargeInOnNextCancel;
  preserveBargeInOnNextCancel = false;
  playbackCancelled = true;
  currentTurn += 1;
  isProcessing = false;
  stopWakeListening();
  showSearchEvidence([], []);
  resetVoiceQueue();
  if (!preserveBargeInMonitor) stopBargeInMonitor();
  const cancelledChatTurnId = activeChatTurnId;
  if (cancelledChatTurnId && currentStreamedReplyParts.length) {
    pendingInterruptedReply = currentStreamedReplyParts.join(' ').slice(0, 2000);
  }
  currentStreamedReplyParts = [];
  activeChatTurnId = null;
  if (cancelledChatTurnId) {
    // Do not attach this to turnAbortController: the cancellation request has
    // to survive the local fetch abort long enough to stop server-side model
    // work and prevent a partial assistant reply from being persisted.
    authenticatedFetch('/api/chat/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turn_id: cancelledChatTurnId })
    }).catch(() => {});
  }
  if (streamListenActive) {
    discardNextRecording = true;
    requestStreamStop();
  }
  if (turnAbortController) {
    try {
      turnAbortController.abort();
    } catch {
      // AbortController.abort is safe; ignore exotic environments.
    }
    turnAbortController = null;
  }
  stopPcmPlayback();
  audioPlayer.pause();
  audioPlayer.currentTime = 0;
  releaseAudioUrl();
  isSpeaking = false;
  stopVoiceWave();
  hideTranscript();
}

// Cuts AURA off mid-sentence and returns the orb to idle (unless the caller
// immediately re-arms listening for a barge-in).
function stopSpeaking() {
  cancelActiveTurn();
  setOrbState('idle', idleStatusText());
}

function createChatTurnId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `turn_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

// State Management
function setOrbState(state, text) {
  orb.className = state;
  statusText.textContent = text;
  // Lets the wordmark's neon track the orb without duplicating state.
  document.body.dataset.auraState = state;
  drawAuraMesh();
}

function currentAuraMeshProfile() {
  if (localMeshQualityPreview === 'low') return LOW_MESH_PROFILE;
  if (!mobileMesh.matches && localMeshQualityPreview !== 'mobile') return DESKTOP_MESH_PROFILE;
  return meshLowQuality ? LOW_MESH_PROFILE : MOBILE_MESH_PROFILE;
}

function resizeAuraMesh(profile = currentAuraMeshProfile()) {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, profile.pixelRatio);
  const width = Math.max(1, Math.round(auraMesh.clientWidth * pixelRatio));
  const height = Math.max(1, Math.round(auraMesh.clientHeight * pixelRatio));
  if (auraMesh.width !== width || auraMesh.height !== height) {
    auraMesh.width = width;
    auraMesh.height = height;
  }
}

function auraMeshPalette(state, energy = 0) {
  if (state === 'listening') {
    // Quiet listening is cyan/teal; Chris's voice pulls the form through
    // violet toward magenta as microphone energy rises.
    return [
      `hsl(${187 + energy * 9} 100% ${60 + energy * 8}%)`,
      `hsl(${164 + energy * 92} 100% ${64 + energy * 5}%)`,
      `hsl(${203 + energy * 105} 100% ${65 + energy * 5}%)`
    ];
  }
  if (state === 'thinking') return ['#388cff', '#8557ff', '#f140ff'];
  if (state === 'speaking') {
    return [
      `hsl(${192 + energy * 8} 100% ${60 + energy * 8}%)`,
      `hsl(${247 + energy * 14} 100% ${65 + energy * 6}%)`,
      `hsl(${305 + energy * 8} 100% ${61 + energy * 8}%)`
    ];
  }
  if (state === 'error') return ['#ff775c', '#ff376f', '#db3dff'];
  return ['#28bfff', '#5d68ff', '#d53cff'];
}

function auraMeshPoint(latitude, longitude, radius, phase, energy, state) {
  const stateMotion = state === 'thinking' ? 1.45 : state === 'listening' ? 0.72 : 1;
  const surfaceWave =
    Math.sin(longitude * 2.7 + latitude * 1.9 + phase * 1.4) * 0.1 +
    Math.sin(longitude * 5.4 - latitude * 3.2 - phase * 0.9) * 0.05 +
    Math.cos(latitude * 7 + longitude * 1.3 + phase * 0.55) * 0.026;
  const voiceWave = Math.sin(longitude * 4 + latitude * 3 - phase * 3.1) * energy * 0.19;
  const breathing = Math.sin(phase * 0.9) * 0.022;
  const deformedRadius = radius * (1 + breathing + surfaceWave * stateMotion + voiceWave);
  const rotatedLongitude = longitude + phase * 0.11;
  const cosLatitude = Math.cos(latitude);
  const x3 = deformedRadius * cosLatitude * Math.cos(rotatedLongitude);
  const z3 = deformedRadius * cosLatitude * Math.sin(rotatedLongitude);
  const y3 = deformedRadius * Math.sin(latitude) +
    radius * Math.sin(longitude * 2 - phase) * Math.cos(latitude) * 0.045;
  const perspective = 1 + z3 / (radius * 4.6);
  return { x: x3 * perspective, y: y3 * perspective, z: z3 / radius };
}

function drawAuraMesh() {
  const profile = currentAuraMeshProfile();
  resizeAuraMesh(profile);
  const width = auraMesh.width;
  const height = auraMesh.height;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.34;
  const state = orb.className || 'idle';
  const sourceEnergy = state === 'listening' ? microphoneEnergy : waveformEnergy;
  const liveEnergy = Math.max(0, Math.min(1, sourceEnergy));
  const palette = auraMeshPalette(state, liveEnergy);
  const energyFloor = state === 'thinking' ? 0.24 : state === 'listening' ? 0.12 : 0.045;
  const energy = reducedMotion.matches ? energyFloor : Math.max(energyFloor, liveEnergy);
  const detailMix = state === 'listening'
    ? 0.08 + liveEnergy * 0.92
    : state === 'speaking'
      ? 0.55 + liveEnergy * 0.45
      : 1;

  auraMeshContext.clearRect(0, 0, width, height);
  const innerGlow = auraMeshContext.createRadialGradient(
    centerX, centerY, radius * 0.08,
    centerX, centerY, radius * 1.28
  );
  innerGlow.addColorStop(0, 'rgba(74, 25, 126, 0.16)');
  innerGlow.addColorStop(0.58, 'rgba(17, 25, 83, 0.08)');
  innerGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  auraMeshContext.fillStyle = innerGlow;
  auraMeshContext.fillRect(0, 0, width, height);

  const lineGradient = auraMeshContext.createLinearGradient(
    centerX - radius * 1.15, centerY - radius,
    centerX + radius * 1.15, centerY + radius
  );
  lineGradient.addColorStop(0, palette[0]);
  lineGradient.addColorStop(0.52, palette[1]);
  lineGradient.addColorStop(1, palette[2]);
  auraMeshContext.strokeStyle = lineGradient;
  auraMeshContext.lineWidth = Math.max(0.5, width / 620);
  auraMeshContext.lineCap = 'round';
  auraMeshContext.lineJoin = 'round';
  // Per-path canvas blur is the most expensive part of this effect on iOS.
  // Phones keep the bright perimeter glow below but draw fine lines cleanly.
  auraMeshContext.shadowBlur = profile.lineGlow
    ? Math.max(2, width / 90) * (1 + liveEnergy * 1.25)
    : 0;
  auraMeshContext.shadowColor = palette[1];

  const strokeMeshLine = (points, visibility = 1) => {
    auraMeshContext.beginPath();
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const x = centerX + point.x;
      const y = centerY + point.y;
      if (index === 0) auraMeshContext.moveTo(x, y);
      else auraMeshContext.lineTo(x, y);
    }
    const averageDepth = points.reduce((sum, point) => sum + point.z, 0) / points.length;
    auraMeshContext.globalAlpha = (0.44 + Math.max(0, averageDepth) * 0.44) * visibility;
    auraMeshContext.stroke();
  };

  for (let latIndex = 1; latIndex <= profile.latitudeLines; latIndex += 1) {
    const latitude = -Math.PI / 2 + (latIndex / (profile.latitudeLines + 1)) * Math.PI;
    const points = [];
    for (let step = 0; step <= profile.latitudeSteps; step += 1) {
      const longitude = (step / profile.latitudeSteps) * Math.PI * 2;
      points.push(auraMeshPoint(latitude, longitude, radius, meshPhase, energy, state));
    }
    strokeMeshLine(points, latIndex % 2 === 0 ? 1 : detailMix);
  }

  for (let lonIndex = 0; lonIndex < profile.longitudeLines; lonIndex += 1) {
    const longitude = (lonIndex / profile.longitudeLines) * Math.PI * 2;
    const points = [];
    for (let step = 0; step <= profile.longitudeSteps; step += 1) {
      const latitude = -Math.PI / 2 + (step / profile.longitudeSteps) * Math.PI;
      points.push(auraMeshPoint(latitude, longitude, radius, meshPhase, energy, state));
    }
    strokeMeshLine(points, lonIndex % 2 === 0 ? 1 : detailMix);
  }

  // A separately deformed perimeter breaks the perfect globe silhouette and
  // gives the form the soft, topographic edge of a living energy cloud.
  auraMeshContext.beginPath();
  for (let step = 0; step <= profile.edgeSteps; step += 1) {
    const angle = (step / profile.edgeSteps) * Math.PI * 2;
    const edgeNoise =
      Math.sin(angle * 3 + meshPhase * 1.2) * 0.06 +
      Math.sin(angle * 7 - meshPhase * 0.8) * 0.032 +
      Math.sin(angle * 11 + meshPhase * 0.4) * 0.014;
    const edgeRadius = radius * (1.04 + edgeNoise + energy * Math.sin(angle * 5 - meshPhase * 2) * 0.07);
    const x = centerX + Math.cos(angle) * edgeRadius;
    const y = centerY + Math.sin(angle) * edgeRadius * 0.94;
    if (step === 0) auraMeshContext.moveTo(x, y);
    else auraMeshContext.lineTo(x, y);
  }
  auraMeshContext.closePath();
  auraMeshContext.globalAlpha = 0.72;
  auraMeshContext.lineWidth = Math.max(0.8, width / 420);
  auraMeshContext.shadowBlur = Math.max(4, width / (profile.lineGlow ? 48 : 66)) *
    (1 + liveEnergy * (profile.lineGlow ? 1.15 : 0.65));
  auraMeshContext.stroke();

  auraMeshContext.shadowBlur = 0;
  for (let index = 0; index < profile.particles; index += 1) {
    const angle = index * 2.399963 + meshPhase * 0.08;
    const seed = (Math.sin(index * 91.17) + 1) / 2;
    const particleRadius = radius * (1.08 + seed * 0.34 + energy * 0.08);
    const x = centerX + Math.cos(angle) * particleRadius;
    const y = centerY + Math.sin(angle) * particleRadius * (0.82 + seed * 0.14);
    const particleResponse = state === 'listening' || state === 'speaking'
      ? 0.58 + liveEnergy * 0.72
      : 1;
    auraMeshContext.globalAlpha = Math.min(1, (0.18 + seed * 0.48) * particleResponse);
    auraMeshContext.fillStyle = palette[index % palette.length];
    auraMeshContext.beginPath();
    auraMeshContext.arc(x, y, Math.max(0.45, width / 520) * (0.7 + seed), 0, Math.PI * 2);
    auraMeshContext.fill();
  }
  auraMeshContext.globalAlpha = 1;
  // Avoid a style/filter repaint for every tiny energy fluctuation. Desktop
  // uses twenty visual steps; phones keep one state-level compositor glow
  // while the canvas itself continues to respond smoothly.
  const styleEnergy = profile.name === 'desktop'
    ? Math.round(liveEnergy * 20) / 20
    : state === 'listening' ? 0.45 : state === 'speaking' ? 0.65 : 0;
  const meshSaturation = state === 'listening'
    ? 1.12 + styleEnergy * 0.46
    : state === 'speaking'
      ? 1.24 + styleEnergy * 0.42
      : 1.25;
  const meshGlow = state === 'listening'
    ? 7 + styleEnergy * 15
    : state === 'speaking'
      ? 10 + styleEnergy * 15
      : 11;
  const styleSignature = `${state}:${styleEnergy}:${profile.name}`;
  if (styleSignature !== meshStyleSignature) {
    meshStyleSignature = styleSignature;
    orb.style.setProperty('--voice-energy', styleEnergy.toFixed(3));
    orb.style.setProperty('--mesh-saturation', meshSaturation.toFixed(3));
    orb.style.setProperty('--mesh-glow', `${meshGlow.toFixed(1)}px`);
  }
  auraMesh.dataset.quality = profile.name;
}

function recordAuraMeshPerformance(renderMs, frameGap, profile) {
  if (profile.name !== 'mobile' || meshLowQuality) return;
  const frameInterval = 1000 / profile.fps;
  const missedFrame = meshLastFrameAt > 0 && frameGap > frameInterval * 1.55;
  const overloaded = renderMs > 16 || missedFrame;
  meshSlowFrameScore = Math.max(0, meshSlowFrameScore + (overloaded ? 1 : -0.35));
  if (meshSlowFrameScore < 6) return;

  // Stay in the cheaper mode for the session instead of oscillating between
  // quality levels whenever a busy phone briefly catches up.
  meshLowQuality = true;
  meshStyleSignature = '';
}

function animateAuraMesh(timestamp = 0) {
  if (reducedMotion.matches) {
    meshFrame = null;
    drawAuraMesh();
    return;
  }
  const profile = currentAuraMeshProfile();
  const frameInterval = 1000 / profile.fps;
  const frameGap = meshLastFrameAt ? timestamp - meshLastFrameAt : frameInterval;
  if (!meshLastFrameAt || frameGap >= frameInterval - 1) {
    const state = orb.className || 'idle';
    const speed = state === 'speaking' ? 0.052 : state === 'thinking' ? 0.036 : state === 'listening' ? 0.024 : 0.014;
    const phaseFrameRatio = Math.min(100, frameGap) / (1000 / 30);
    meshPhase += speed * phaseFrameRatio;
    const renderStartedAt = performance.now();
    drawAuraMesh();
    const renderMs = performance.now() - renderStartedAt;
    recordAuraMeshPerformance(renderMs, frameGap, profile);
    meshLastFrameAt = timestamp;
  }
  meshFrame = requestAnimationFrame(animateAuraMesh);
}

function startAuraMesh() {
  if (meshFrame) cancelAnimationFrame(meshFrame);
  meshFrame = null;
  meshLastFrameAt = 0;
  drawAuraMesh();
  if (!reducedMotion.matches) meshFrame = requestAnimationFrame(animateAuraMesh);
}

function resizeVoiceWave() {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(voiceWave.clientWidth * pixelRatio));
  const height = Math.max(1, Math.round(voiceWave.clientHeight * pixelRatio));
  if (voiceWave.width !== width || voiceWave.height !== height) {
    voiceWave.width = width;
    voiceWave.height = height;
  }
}

function drawVoiceWave(samples = null) {
  resizeVoiceWave();
  const width = voiceWave.width;
  const height = voiceWave.height;
  const centerY = height / 2;
  const amplitude = height * 0.36;
  voiceWaveContext.clearRect(0, 0, width, height);

  const gradient = voiceWaveContext.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, 'rgba(57, 137, 255, 0.08)');
  gradient.addColorStop(0.5, isSpeaking
    ? 'rgba(221, 90, 255, 0.95)'
    : 'rgba(100, 185, 255, 0.48)');
  gradient.addColorStop(1, 'rgba(57, 137, 255, 0.08)');

  voiceWaveContext.beginPath();
  voiceWaveContext.lineWidth = Math.max(2, width / 320);
  voiceWaveContext.strokeStyle = gradient;
  voiceWaveContext.lineCap = 'round';
  voiceWaveContext.lineJoin = 'round';
  voiceWaveContext.shadowBlur = isSpeaking ? 18 : 8;
  voiceWaveContext.shadowColor = isSpeaking
    ? 'rgba(200, 69, 255, 0.74)'
    : 'rgba(72, 168, 255, 0.34)';

  // Travelling wave, always in motion while speaking. Her voice raises the
  // amplitude on top of a floor, so quiet passages still read as "talking"
  // and loud ones visibly swell.
  const gain = isSpeaking
    ? 0.30 + waveformEnergy * 0.85
    : 0.05;
  const still = reducedMotion.matches;

  const pointCount = 96;
  for (let index = 0; index < pointCount; index += 1) {
    const progress = index / (pointCount - 1);
    const edgeFade = Math.sin(Math.PI * progress);

    let normalized;
    if (still) {
      normalized = 0;
    } else {
      // Two detuned travelling components keep it from looking like a metronome.
      normalized =
        Math.sin(progress * Math.PI * 5 - waveformPhase) * 0.62 +
        Math.sin(progress * Math.PI * 9 - waveformPhase * 1.7) * 0.24;
      normalized *= gain;
    }

    const x = progress * width;
    const y = centerY + normalized * amplitude * edgeFade;
    if (index === 0) voiceWaveContext.moveTo(x, y);
    else voiceWaveContext.lineTo(x, y);
  }
  voiceWaveContext.stroke();
}

// Converts the analyser's raw PCM into a smoothed 0..1 loudness figure.
// Returns false when the graph reports nothing usable, so the caller can
// keep the wave alive on its own motion instead of flatlining.
function readVoiceEnergy() {
  if (!audioAnalyser || !waveformSamples) return false;
  audioAnalyser.getByteTimeDomainData(waveformSamples);

  let peak = 0;
  for (let index = 0; index < waveformSamples.length; index += 1) {
    const deviation = Math.abs(waveformSamples[index] - 128) / 128;
    if (deviation > peak) peak = deviation;
  }

  // Anything this small is indistinguishable from a silent/idle graph.
  if (peak < 0.012) return false;

  const target = Math.min(1, peak * 1.8);
  waveformEnergy += (target - waveformEnergy) * 0.35;
  return true;
}

function stopVoiceWave() {
  if (waveformFrame) cancelAnimationFrame(waveformFrame);
  waveformFrame = null;
  voiceWave.classList.remove('speaking');
  waveformEnergy = 0;
  drawVoiceWave();
  drawAuraMesh();
}

function animateVoiceWave() {
  if (!isSpeaking) {
    stopVoiceWave();
    return;
  }

  // If the analyser gives us nothing usable, ease toward a mid-level so the
  // wave keeps moving convincingly rather than collapsing to a flat line.
  if (!readVoiceEnergy()) {
    waveformEnergy += (0.45 - waveformEnergy) * 0.08;
  }

  waveformPhase += 0.22;
  drawVoiceWave();
  waveformFrame = requestAnimationFrame(animateVoiceWave);
}

function playbackVolumeLevel() {
  const stored = localStorage.getItem(PLAYBACK_VOLUME_KEY);
  if (stored && Object.prototype.hasOwnProperty.call(PLAYBACK_VOLUME_LEVELS, stored)) {
    return stored;
  }
  // Default a bit above unity — the usual complaint is "quiet on iPhone
  // even at max ringer," not that she's too loud.
  return 'medium';
}

function playbackGainValue() {
  return PLAYBACK_VOLUME_LEVELS[playbackVolumeLevel()] || PLAYBACK_VOLUME_LEVELS.medium;
}

function syncVolumeToggle() {
  if (!volumeToggle) return;
  const level = playbackVolumeLevel();
  volumeToggle.dataset.level = level;
  volumeToggle.setAttribute('aria-label', `Playback volume: ${level}. Tap to change.`);
  volumeToggle.title = `Playback volume: ${level}. Tap to cycle.`;
  volumeToggle.textContent = level === 'low'
    ? 'Volume low'
    : level === 'high'
      ? 'Volume high'
      : 'Volume med';
}

function applyPlaybackGain() {
  audioPlayer.volume = 1;
  if (playbackGainNode) {
    playbackGainNode.gain.value = playbackGainValue();
  }
}

function cyclePlaybackVolume() {
  const order = ['low', 'medium', 'high'];
  const next = order[(order.indexOf(playbackVolumeLevel()) + 1) % order.length];
  localStorage.setItem(PLAYBACK_VOLUME_KEY, next);
  applyPlaybackGain();
  syncVolumeToggle();
}

async function ensureAudioGraph() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return false;
  if (!audioContext) {
    audioContext = new AudioContextClass();
    audioAnalyser = audioContext.createAnalyser();
    audioAnalyser.fftSize = 256;
    audioAnalyser.smoothingTimeConstant = 0.82;
    waveformSamples = new Uint8Array(audioAnalyser.fftSize);
    audioSource = audioContext.createMediaElementSource(audioPlayer);
    playbackGainNode = audioContext.createGain();
    playbackGainNode.gain.value = playbackGainValue();
    // Soft ceiling so High doesn't turn Cartesia peaks into harsh clipping
    // on phone speakers.
    const compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 18;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.22;
    audioSource.connect(playbackGainNode);
    playbackGainNode.connect(audioAnalyser);
    audioAnalyser.connect(compressor);
    compressor.connect(audioContext.destination);
    audioPlayer.volume = 1;
  }
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  applyPlaybackGain();
  return true;
}

function playAudioBlob(blob) {
  playbackCancelled = false;
  resetVoiceQueue();
  voiceQueueTail = voiceQueueTail.then(async () => {
    if (playbackCancelled) return;
    setOrbState('speaking', 'Speaking... tap to interrupt');
    isSpeaking = true;
    audioPlayer.onplay = startVoiceWave;
    await playBlobAndWait(blob);
  });
  finishVoiceQueue();
}

function startVoiceWave() {
  if (waveformFrame) cancelAnimationFrame(waveformFrame);
  voiceWave.classList.add('speaking');
  // Start with visible motion immediately instead of ramping up from flat.
  waveformEnergy = Math.max(waveformEnergy, 0.4);
  waveformFrame = requestAnimationFrame(animateVoiceWave);
}

drawVoiceWave();
startAuraMesh();
window.addEventListener('resize', () => drawVoiceWave(
  isSpeaking && waveformSamples ? waveformSamples : null
));
reducedMotion.addEventListener?.('change', () => {
  drawVoiceWave();
  startAuraMesh();
});
mobileMesh.addEventListener?.('change', () => {
  meshLowQuality = false;
  meshSlowFrameScore = 0;
  meshStyleSignature = '';
  startAuraMesh();
});

// Local visual QA: preview a state without opening the microphone, calling
// the backend, or playing audio. The hostname guard makes the query inert on
// Render even if someone copies a preview URL there.
function applyLocalAuraPreview() {
  if (!['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)) return;
  const previewState = new URLSearchParams(window.location.search).get('aura_preview');
  if (!['idle', 'listening', 'thinking', 'speaking', 'error'].includes(previewState)) return;

  isSpeaking = previewState === 'speaking';
  waveformEnergy = isSpeaking ? 0.72 : 0;
  microphoneEnergy = previewState === 'listening' ? 0.68 : 0;
  setOrbState(previewState, `${previewState} preview`);
  voiceWave.classList.toggle('speaking', isSpeaking);
  drawVoiceWave();
  drawAuraMesh();
}

window.setTimeout(applyLocalAuraPreview, 120);

function safeWebUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function appendCitedBlock(block) {
  if (!block?.text) return;
  const paragraph = document.createElement('p');
  let cursor = 0;
  const citations = [...(block.citations || [])]
    .filter(citation => Number.isInteger(citation.start_index) &&
      Number.isInteger(citation.end_index) &&
      citation.start_index >= cursor &&
      citation.end_index > citation.start_index &&
      citation.end_index <= block.text.length &&
      safeWebUrl(citation.url))
    .sort((a, b) => a.start_index - b.start_index);

  for (const citation of citations) {
    if (citation.start_index < cursor) continue;
    paragraph.appendChild(document.createTextNode(
      block.text.slice(cursor, citation.start_index)
    ));
    const url = safeWebUrl(citation.url);
    const link = document.createElement('a');
    link.href = url.toString();
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = citation.title && citation.title !== url.hostname
      ? `[${citation.title} · ${url.hostname}]`
      : `[${url.hostname}]`;
    paragraph.appendChild(link);
    cursor = citation.end_index;
  }
  paragraph.appendChild(document.createTextNode(block.text.slice(cursor)));
  webAnswer.appendChild(paragraph);
}

function hideTranscript() {
  if (!transcriptPanel) return;
  transcriptPanel.classList.remove('visible');
  transcriptPanel.setAttribute('aria-hidden', 'true');
}

// Transcript history used to auto-appear when idle (top sheet on phones).
// That fights the voice-first surface — every open dumped leftover text over
// the orb. Keep the panel in the DOM for a future explicit affordance, but
// never auto-show it.
function refreshTranscript() {
  hideTranscript();
}

// Ear for talk, panel for receipts: show search citations/sources, or a
// number-heavy business reply (balances, counts, MRR). Plain chit-chat stays
// voice-only so the side rail doesn't compete with conversation mode.
function looksLikeReceipt(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return /\$\s?\d|\d+\s*%|\bMRR\b|\boutstanding\b|\bbalance\b|\brevenue\b|\b\d{1,3}(,\d{3})+(\.\d+)?\b|\b\d+\s+(clients?|letters?|accounts?|items?|goals?|people|furnishers?)\b|\b(clients?|letters?|accounts?|goals?)\b[^.]{0,40}\b\d+/i.test(t);
}

function showSearchEvidence(webResults = [], sources = [], replyText = '') {
  webAnswer.replaceChildren();
  sourceLinks.replaceChildren();
  const latestResult = webResults[webResults.length - 1];
  let isSearchResult = false;

  if (latestResult?.citation_blocks?.length) {
    for (const block of latestResult.citation_blocks) appendCitedBlock(block);
    isSearchResult = true;
  } else if (latestResult?.answer) {
    const paragraph = document.createElement('p');
    paragraph.textContent = latestResult.answer;
    webAnswer.appendChild(paragraph);
    isSearchResult = true;
  } else if (looksLikeReceipt(replyText)) {
    const paragraph = document.createElement('p');
    paragraph.textContent = replyText.trim();
    webAnswer.appendChild(paragraph);
  }

  for (const source of sources.slice(0, 6)) {
    const url = safeWebUrl(source.url);
    if (!url) continue;
    const link = document.createElement('a');
    link.href = url.toString();
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = source.title && source.title !== url.hostname
      ? `${source.title} · ${url.hostname}`
      : url.hostname;
    sourceLinks.appendChild(link);
  }
  sourceLabel.textContent = isSearchResult ? 'Live web result' : 'Receipt';

  // Non-persistent by design: only ever made visible when there's actually
  // something to show, and hidden again as soon as there isn't - opacity/
  // transform driven (see CSS) rather than the `hidden` attribute, so it can
  // fade in/out instead of snapping.
  const hasContent = webAnswer.childElementCount > 0 || sourceLinks.childElementCount > 0;
  sourcePanel.classList.toggle('visible', hasContent);
  sourcePanel.setAttribute('aria-hidden', String(!hasContent));
}

function isConversationMode() {
  return localStorage.getItem(CONVERSATION_MODE_KEY) !== 'false';
}

function speechRecognitionAvailable() {
  return typeof window !== 'undefined' &&
    Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function idleStatusText() {
  if (!isConversationMode()) return 'Tap to talk to AURA';
  if (wakeListener?.isArmed?.()) return 'Say hey Aura, or tap';
  if (speechRecognitionAvailable()) return 'Say hey Aura, or tap';
  return 'Tap to talk · conversation on';
}

function canRunWakeListener() {
  return isConversationMode() &&
    speechRecognitionAvailable() &&
    !isListening &&
    !isSpeaking &&
    !isProcessing &&
    typeof document !== 'undefined' &&
    document.visibilityState !== 'hidden';
}

function syncConversationToggle() {
  if (!conversationToggle) return;
  const on = isConversationMode();
  conversationToggle.setAttribute('aria-pressed', String(on));
  conversationToggle.textContent = on ? 'Conversation on' : 'Conversation off';
}

function setConversationMode(on) {
  localStorage.setItem(CONVERSATION_MODE_KEY, on ? 'true' : 'false');
  syncConversationToggle();
  if (!on) {
    wakeListener?.stop?.();
    stopBargeInMonitor();
  }
  if (!isListening && !isSpeaking && !isProcessing) {
    setOrbState('idle', idleStatusText());
    if (on) maybeStartWakeListening();
  }
}

function maybeStartWakeListening() {
  if (!wakeListener) return false;
  if (!canRunWakeListener()) {
    wakeListener.stop();
    return false;
  }
  return wakeListener.start();
}

function stopWakeListening() {
  wakeListener?.stop?.();
}

function updateMicrophoneEnergy(rms, timestamp = performance.now()) {
  if (!Number.isFinite(rms) || rms < 0) return false;
  microphoneEnergySquareSum += rms * rms;
  microphoneEnergyReadingCount += 1;

  const elapsed = microphoneEnergyUpdatedAt
    ? timestamp - microphoneEnergyUpdatedAt
    : MICROPHONE_VISUAL_INTERVAL_MS;
  if (elapsed < MICROPHONE_VISUAL_INTERVAL_MS) return false;

  const windowRms = Math.sqrt(
    microphoneEnergySquareSum / Math.max(1, microphoneEnergyReadingCount)
  );
  microphoneEnergySquareSum = 0;
  microphoneEnergyReadingCount = 0;

  // Time-based attack/release remains equally smooth whether AudioWorklet
  // delivers hundreds of tiny buffers or the fallback analyser runs at 60Hz.
  const target = Math.max(0, Math.min(1, (windowRms - 0.008) / 0.11));
  const timeConstant = target > microphoneEnergy ? 70 : 190;
  const smoothing = 1 - Math.exp(-elapsed / timeConstant);
  microphoneEnergy += (target - microphoneEnergy) * smoothing;
  microphoneEnergyUpdatedAt = timestamp;
  return true;
}

function updateMicrophoneEnergyFromSamples(samples) {
  if (!samples?.length) return;
  let sum = 0;
  let sampled = 0;
  // Every fourth PCM sample is plenty for a visual loudness envelope and
  // avoids duplicating full-rate audio work already required by STT.
  for (let index = 0; index < samples.length; index += 4) {
    const value = samples[index];
    sum += value * value;
    sampled += 1;
  }
  updateMicrophoneEnergy(Math.sqrt(sum / Math.max(1, sampled)));
}

function resetMicrophoneEnergy() {
  microphoneEnergy = 0;
  microphoneEnergyUpdatedAt = 0;
  microphoneEnergySquareSum = 0;
  microphoneEnergyReadingCount = 0;
}

function clearSilenceWatch() {
  if (silenceWatchFrame) {
    cancelAnimationFrame(silenceWatchFrame);
    silenceWatchFrame = null;
  }
  if (silenceListenContext) {
    silenceListenContext.close().catch(() => {});
    silenceListenContext = null;
  }
  resetMicrophoneEnergy();
}

function armSilenceAutoStop(stream, { autoStop = true } = {}) {
  clearSilenceWatch();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  const ctx = new AudioCtx();
  silenceListenContext = ctx;
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  const normalizedSamples = new Float32Array(analyser.fftSize);
  const startedAt = Date.now();
  let heardSpeech = false;
  let lastAnalysisAt = 0;
  const adaptiveVad = createAdaptiveVad({
    calibrationMs: LISTEN_ARM_GRACE_MS,
    startWindowMs: SPEECH_CONFIDENCE_WINDOW_MS,
    hangoverMs: SILENCE_HANGOVER_MS
  });

  const tick = (timestamp = performance.now()) => {
    if (!isListening || !mediaRecorder || mediaRecorder.state === 'inactive') {
      clearSilenceWatch();
      return;
    }
    if (lastAnalysisAt && timestamp - lastAnalysisAt < MICROPHONE_VISUAL_INTERVAL_MS) {
      silenceWatchFrame = requestAnimationFrame(tick);
      return;
    }
    lastAnalysisAt = timestamp;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = (samples[i] - 128) / 128;
      normalizedSamples[i] = v;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / samples.length);
    updateMicrophoneEnergy(rms);
    const elapsed = Date.now() - startedAt;
    const decision = adaptiveVad.process(normalizedSamples, timestamp, {
      sampleRate: ctx.sampleRate
    });
    if (decision.event === 'false_start') {
      recordVadDiagnostic('false_start', 'batch', decision);
    }
    if (decision.event === 'speech_start' || decision.state === 'speech') {
      heardSpeech = true;
    }
    if (autoStop && !heardSpeech && elapsed >= NO_SPEECH_IDLE_MS) {
      cancelListeningToIdle();
      return;
    }
    if (autoStop && elapsed >= MAX_UTTERANCE_MS) {
      stopListening();
      return;
    }
    if (autoStop && decision.event === 'speech_end') {
      rememberVoiceFinal('local_hangover');
      stopListening();
      return;
    }
    silenceWatchFrame = requestAnimationFrame(tick);
  };
  silenceWatchFrame = requestAnimationFrame(tick);
}

function releaseAudioUrl() {
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
}

// Chained playback queue for streamed replies: the first complete sentence
// starts promptly, then later sentences arrive in connected speech groups.
// voiceQueueTail is a running promise chain - each call appends "wait for
// this group's TTS, then play it and wait for it to finish." TTS fetches still
// overlap playback, but Cartesia gets enough connected text to keep natural
// cadence instead of restarting its performance sentence by sentence.
let voiceQueueTail = Promise.resolve();
// Bumped whenever the queue is reset so orphaned .then() chains from an
// interrupted turn cannot resume listening or play audio after barge-in.
let voiceGeneration = 0;
// Active Web Audio BufferSources from streamed PCM TTS (interrupted on barge-in).
let pcmPlaybackSources = [];

function resetVoiceQueue() {
  voiceGeneration += 1;
  voiceQueueTail = Promise.resolve();
}

function stopPcmPlayback() {
  for (const source of pcmPlaybackSources) {
    try {
      source.stop(0);
    } catch {
      // Already stopped or never started.
    }
  }
  pcmPlaybackSources = [];
}

// Plays one clip and resolves once it's done - on natural end, on error, or
// on interruption (stopSpeaking() calls audioPlayer.pause(), which fires a
// 'pause' event; since pause() alone never fires 'ended', that event is the
// only way this promise would otherwise hang forever after an interrupt).
function playBlobAndWait(blob, { onPlayStart = null } = {}) {
  return new Promise(resolve => {
    if (playbackCancelled) {
      resolve();
      return;
    }
    releaseAudioUrl();
    currentAudioUrl = URL.createObjectURL(blob);
    audioPlayer.src = currentAudioUrl;

    const finish = () => {
      audioPlayer.removeEventListener('ended', finish);
      audioPlayer.removeEventListener('error', finish);
      audioPlayer.removeEventListener('pause', onPause);
      resolve();
    };
    const onPause = () => {
      if (playbackCancelled) finish();
    };
    audioPlayer.addEventListener('ended', finish);
    audioPlayer.addEventListener('error', finish);
    audioPlayer.addEventListener('pause', onPause);

    ensureAudioGraph()
      .catch(() => false)
      .finally(() => {
        if (playbackCancelled) {
          finish();
          return;
        }
        audioPlayer.play().then(() => {
          if (typeof onPlayStart === 'function') onPlayStart();
        }).catch(error => {
          console.error('Audio playback error:', error);
          finish();
        });
      });
  });
}

// Stream raw pcm_s16le from /api/tts?stream=1 and schedule Web Audio buffers
// as chunks arrive — first audible audio before Cartesia finishes the clip.
async function playPcmStreamAndWait(response, { onPlayStart = null, sampleRate = 24000 } = {}) {
  if (playbackCancelled) return;
  const ready = await ensureAudioGraph().catch(() => false);
  if (!ready || !audioContext || !playbackGainNode || !response.body) {
    const blob = await response.blob();
    return playBlobAndWait(blob, { onPlayStart });
  }

  const reader = response.body.getReader();
  let leftover = new Uint8Array(0);
  let nextTime = 0;
  let started = false;
  const minFirstFrames = Math.max(1, Math.floor(sampleRate * 0.06));
  const scheduleChunkFrames = Math.max(minFirstFrames, Math.floor(sampleRate * 0.08));
  let pending = new Int16Array(0);

  const scheduleFrames = (frames, { force = false } = {}) => {
    if (!frames.length) return frames;
    let offset = 0;
    while (offset < frames.length) {
      const remaining = frames.length - offset;
      const need = started ? scheduleChunkFrames : minFirstFrames;
      if (!force && remaining < need) break;
      const take = force ? remaining : Math.min(scheduleChunkFrames, remaining);
      if (!force && take < need) break;

      const slice = frames.subarray(offset, offset + take);
      offset += take;
      const buffer = audioContext.createBuffer(1, slice.length, sampleRate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < slice.length; i += 1) {
        channel[i] = slice[i] / 32768;
      }
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(playbackGainNode);
      const startAt = Math.max(audioContext.currentTime + 0.02, nextTime || audioContext.currentTime + 0.02);
      source.start(startAt);
      nextTime = startAt + buffer.duration;
      pcmPlaybackSources.push(source);
      source.onended = () => {
        pcmPlaybackSources = pcmPlaybackSources.filter(entry => entry !== source);
      };
      if (!started) {
        started = true;
        if (typeof onPlayStart === 'function') onPlayStart();
      }
      if (force) break;
    }
    return frames.subarray(offset);
  };

  try {
    while (true) {
      if (playbackCancelled) {
        try { await reader.cancel(); } catch { /* ignore */ }
        stopPcmPlayback();
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;

      const merged = new Uint8Array(leftover.length + value.length);
      merged.set(leftover);
      merged.set(value, leftover.length);
      const usable = merged.byteLength - (merged.byteLength % 2);
      leftover = merged.slice(usable);
      const pcm = new Int16Array(merged.buffer, merged.byteOffset, usable / 2);

      const combined = new Int16Array(pending.length + pcm.length);
      combined.set(pending);
      combined.set(pcm, pending.length);
      pending = scheduleFrames(combined);
    }
    if (leftover.length >= 2) {
      const tail = new Int16Array(leftover.buffer, leftover.byteOffset, Math.floor(leftover.byteLength / 2));
      const combined = new Int16Array(pending.length + tail.length);
      combined.set(pending);
      combined.set(tail, pending.length);
      pending = combined;
    }
    scheduleFrames(pending, { force: true });
  } catch (error) {
    if (error?.name === 'AbortError' || playbackCancelled) {
      stopPcmPlayback();
      return;
    }
    throw error;
  }

  if (!started || playbackCancelled) {
    stopPcmPlayback();
    return;
  }

  const remainingMs = Math.max(0, (nextTime - audioContext.currentTime) * 1000) + 30;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, remainingMs);
    const watch = () => {
      if (playbackCancelled) {
        clearTimeout(timer);
        stopPcmPlayback();
        resolve();
        return;
      }
      if (audioContext.currentTime >= nextTime - 0.01) {
        clearTimeout(timer);
        resolve();
        return;
      }
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
}

// Fetches TTS for one speech group immediately (so synthesis overlaps with
// whatever's currently playing) and appends its playback as the next link
// in the queue. isFirst puts the orb into "speaking" state right away,
// matching the old single-blob behavior of setting state before playback
// starts rather than waiting for audio to actually begin.
function enqueueSpeechAudio(text, isFirst, timing = null, signal = null) {
  if (isFirst) {
    setOrbState('speaking', 'Speaking... tap to interrupt');
    isSpeaking = true;
    audioPlayer.onplay = startVoiceWave;
  }
  const ttsStartedAt = timing ? performance.now() : 0;
  const generation = voiceGeneration;
  const ttsPromise = authenticatedFetch('/api/tts?stream=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    ...(signal ? { signal } : {})
  }).then(async res => {
    if (!res.ok) throw new Error('TTS API failed');
    return res;
  });

  voiceQueueTail = voiceQueueTail.then(async () => {
    if (playbackCancelled || signal?.aborted || generation !== voiceGeneration) return;
    let response;
    try {
      response = await ttsPromise;
    } catch (error) {
      if (error?.name === 'AbortError' || playbackCancelled) return;
      console.error('TTS error:', error);
      return;
    }
    if (playbackCancelled || signal?.aborted || generation !== voiceGeneration) return;

    const sampleRate = Number(response.headers.get('X-Aura-Sample-Rate')) || 24000;
    const onPlayStart = isFirst
      ? () => {
          startBargeInMonitor();
          if (!timing) return;
          timing.ttsMs = Math.round(performance.now() - ttsStartedAt);
          timing.ttfaMs = Math.round(performance.now() - timing.t0);
          console.log(
            `[timing] TTFA ${timing.ttfaMs}ms` +
            ` (stt ${timing.sttMs ?? timing.whisperMs ?? '?'}ms` +
            `, first_sentence ${timing.firstSentenceMs ?? '?'}ms` +
            `, tts ${timing.ttsMs ?? '?'}ms)`
          );
        }
      : null;

    try {
      if (response.body && typeof response.body.getReader === 'function') {
        if (isFirst) startVoiceWave();
        await playPcmStreamAndWait(response, { onPlayStart, sampleRate });
      } else {
        const blob = await response.blob();
        if (timing && isFirst) {
          timing.ttsMs = Math.round(performance.now() - ttsStartedAt);
        }
        await playBlobAndWait(blob, { onPlayStart });
      }
    } catch (error) {
      if (error?.name === 'AbortError' || playbackCancelled) return;
      console.error('TTS playback error:', error);
    }
  });
}

// Called once the whole reply is known to be fully queued (the stream's
// 'done' event arrived) - the actual "return to idle" only happens once
// every queued clip has finished playing, not the moment this is called.
function finishVoiceQueue() {
  const generation = voiceGeneration;
  voiceQueueTail = voiceQueueTail.then(async () => {
    if (playbackCancelled || generation !== voiceGeneration) return;
    await stopBargeInMonitor();
    isSpeaking = false;
    stopVoiceWave();
    releaseAudioUrl();
    showSearchEvidence([], []);
    // Hands-free follow-up: reopen the mic after she finishes speaking.
    // Silence auto-stop ends the utterance; tap still cancels anytime.
    if (isConversationMode() && !isProcessing && !isListening) {
      try {
        await startListening({ fromConversation: true });
        return;
      } catch (error) {
        console.warn('Conversation re-listen failed:', error.message || error);
      }
    }
    setOrbState('idle', idleStatusText());
    refreshTranscript();
    maybeStartWakeListening();
  });
}

// WebSocket Reconnection Handling
socket.on('connect', () => {
  console.log('Connected to AURA server');
  refreshSttStreamingFlag();
  if (orb.className === 'error' || statusText.textContent.includes('Reconnecting')) {
    setOrbState('idle', idleStatusText());
  }
});

socket.on('disconnect', (reason) => {
  console.log('Disconnected from server:', reason);
  setOrbState('error', 'Connection lost. Reconnecting...');
});

socket.on('connect_error', async (err) => {
  console.log('Connection error:', err.message);
  if (/auth|token|disabled/i.test(err.message)) {
    if (await refreshSupabaseSession()) {
      socket.auth.token = auraSessionToken;
      socket.connect();
      return;
    }
    setOrbState('error', 'Authentication required');
    clearAuthentication();
    requestAccessToken();
  } else {
    setOrbState('error', 'Connection error...');
  }
});

socket.on('proactive-alert', async (data) => {
  console.log('Proactive alert received:', data.text);
  if (isSpeaking || isListening) return;
  // A new alert is its own exchange, so a previous interrupt shouldn't mute it.
  playbackCancelled = false;
  setOrbState('thinking', 'AURA is notifying you...');
  try {
    // Prefer the prose `spoken` field when present (morning brief) so TTS
    // doesn't read bullet layout / section headers aloud.
    const speakText = data.spoken || data.metadata?.spoken || data.text;
    const ttsRes = await authenticatedFetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: speakText })
    });
    if (!ttsRes.ok) throw new Error('TTS API failed');
    const blob = await ttsRes.blob();
    playAudioBlob(blob);
  } catch (err) { console.error(err); setOrbState('idle', idleStatusText()); }
});

if (conversationToggle) {
  syncConversationToggle();
  conversationToggle.addEventListener('click', event => {
    event.stopPropagation();
    setConversationMode(!isConversationMode());
  });
}

if (volumeToggle) {
  syncVolumeToggle();
  applyPlaybackGain();
  volumeToggle.addEventListener('click', event => {
    event.stopPropagation();
    cyclePlaybackVolume();
  });
}

// Interaction & Microphone Permission Handling
document.getElementById('orb-container').addEventListener('click', async () => {
  if (!audioUnlocked) {
    await ensureAudioGraph().catch(() => false);
    audioPlayer.play().catch(() => {});
    audioUnlocked = true;
  }

  // Tapping the orb while she's speaking OR still thinking interrupts her
  // and, in conversation mode, arms the mic for the barge-in reply. Without
  // this, mid-reply taps only muted audio while isProcessing stayed true —
  // so she wouldn't listen until you tapped again.
  if (isSpeaking || isProcessing) {
    cancelActiveTurn();
    if (isConversationMode()) {
      try {
        await startListening({ fromConversation: true });
      } catch (error) {
        console.warn('Barge-in re-listen failed:', error.message || error);
        setOrbState('idle', idleStatusText());
      }
    } else {
      setOrbState('idle', idleStatusText());
      maybeStartWakeListening();
    }
    return;
  }

  if (isListening) {
    // Tap to STOP listening
    stopListening();
  } else {
    // Tap to START listening
    await startListening();
  }
});

document.getElementById('orb-container').addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.currentTarget.click();
});

async function refreshSttStreamingFlag() {
  try {
    const res = await fetch('/healthz');
    if (!res.ok) return;
    const data = await res.json();
    sttStreamingEnabled = data?.brain?.stt_streaming === true;
  } catch {
    // Keep last known value.
  }
}

function downsampleFloat32(buffer, inRate, outRate) {
  if (inRate === outRate) return buffer;
  const ratio = inRate / outRate;
  const newLen = Math.max(1, Math.round(buffer.length / ratio));
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i += 1) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, buffer.length - 1);
    const frac = idx - i0;
    result[i] = buffer[i0] * (1 - frac) + buffer[i1] * frac;
  }
  return result;
}

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function clearStreamTimers() {
  if (streamMaxTimer) {
    clearTimeout(streamMaxTimer);
    streamMaxTimer = null;
  }
  if (streamNoSpeechTimer) {
    clearTimeout(streamNoSpeechTimer);
    streamNoSpeechTimer = null;
  }
}

function detachStreamSocketHandlers() {
  if (streamFinalHandler) {
    socket.off('stt:final', streamFinalHandler);
    streamFinalHandler = null;
  }
  if (streamPartialHandler) {
    socket.off('stt:partial', streamPartialHandler);
    streamPartialHandler = null;
  }
  if (streamErrorHandler) {
    socket.off('stt:error', streamErrorHandler);
    streamErrorHandler = null;
  }
}

async function teardownStreamCapture() {
  clearStreamTimers();
  try { streamProcessor?.disconnect(); } catch { /* ignore */ }
  try { streamSource?.disconnect(); } catch { /* ignore */ }
  try { streamMute?.disconnect(); } catch { /* ignore */ }
  streamProcessor = null;
  streamSource = null;
  streamMute = null;
  if (streamAudioCtx) {
    try { await streamAudioCtx.close(); } catch { /* ignore */ }
    streamAudioCtx = null;
  }
  if (streamMedia) {
    streamMedia.getTracks().forEach(track => track.stop());
    streamMedia = null;
  }
  resetMicrophoneEnergy();
}

function requestStreamStop() {
  if (!streamListenActive) return;
  streamEndpointAt = performance.now();
  try { socket.emit('stt:stop'); } catch { /* ignore */ }
}

async function attachPcmCapture(audioCtx, mediaStream, onSamples = null) {
  const source = audioCtx.createMediaStreamSource(mediaStream);
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  const emitPcm = float32 => {
    if (typeof onSamples === 'function') {
      onSamples(float32);
      return;
    }
    if (!streamListenActive || !isListening) return;
    updateMicrophoneEnergyFromSamples(float32);
    const down = downsampleFloat32(float32, audioCtx.sampleRate, DEEPGRAM_STREAM_SAMPLE_RATE);
    const pcm = floatTo16BitPCM(down);
    socket.emit('stt:audio', pcm.buffer);
  };

  // Prefer AudioWorklet (no deprecation warning). Fall back to ScriptProcessor
  // on older WebKit builds that still lack worklet support.
  if (audioCtx.audioWorklet) {
    try {
      const workletSource = `
        class AuraPcmCaptureProcessor extends AudioWorkletProcessor {
          process(inputs) {
            const input = inputs[0] && inputs[0][0];
            if (input && input.length) {
              this.port.postMessage(input);
            }
            return true;
          }
        }
        registerProcessor('aura-pcm-capture', AuraPcmCaptureProcessor);
      `;
      const blobUrl = URL.createObjectURL(new Blob([workletSource], { type: 'application/javascript' }));
      try {
        await audioCtx.audioWorklet.addModule(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      const node = new AudioWorkletNode(audioCtx, 'aura-pcm-capture');
      node.port.onmessage = event => {
        if (event.data instanceof Float32Array) emitPcm(event.data);
        else if (event.data?.buffer) emitPcm(new Float32Array(event.data.buffer));
      };
      source.connect(node);
      node.connect(mute);
      mute.connect(audioCtx.destination);
      return { source, processor: node, mute };
    } catch (error) {
      console.warn('[stt] AudioWorklet unavailable, using ScriptProcessor:', error.message || error);
    }
  }

  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = event => {
    emitPcm(event.inputBuffer.getChannelData(0));
  };
  source.connect(processor);
  processor.connect(mute);
  mute.connect(audioCtx.destination);
  return { source, processor, mute };
}

function rememberBargeInPcm(float32, sampleRate) {
  const downsampled = downsampleFloat32(float32, sampleRate, DEEPGRAM_STREAM_SAMPLE_RATE);
  const pcm = floatTo16BitPCM(downsampled);
  if (!pcm.length) return null;
  bargeInPreRoll.push(pcm);
  bargeInPreRollSamples += pcm.length;
  while (bargeInPreRollSamples > BARGE_IN_PRE_ROLL_SAMPLES && bargeInPreRoll.length > 1) {
    const removed = bargeInPreRoll.shift();
    bargeInPreRollSamples -= removed.length;
  }
  return pcm;
}

function appendBargeInUtterancePcm(pcm) {
  if (!pcm?.length || bargeInUtteranceSamples >= BARGE_IN_CAPTURE_MAX_SAMPLES) return;
  const remaining = BARGE_IN_CAPTURE_MAX_SAMPLES - bargeInUtteranceSamples;
  const kept = pcm.length > remaining ? pcm.slice(0, remaining) : new Int16Array(pcm);
  bargeInUtterancePcm.push(kept);
  bargeInUtteranceSamples += kept.length;
}

function beginBargeInUtterance() {
  bargeInUtterancePcm = bargeInPreRoll.map(chunk => new Int16Array(chunk));
  bargeInUtteranceSamples = bargeInUtterancePcm.reduce((total, chunk) => total + chunk.length, 0);
}

async function stopBargeInMonitor({ preserveMedia = false } = {}) {
  const media = bargeInMedia;
  try { bargeInProcessor?.disconnect(); } catch { /* ignore */ }
  try { bargeInSource?.disconnect(); } catch { /* ignore */ }
  try { bargeInMute?.disconnect(); } catch { /* ignore */ }
  bargeInProcessor = null;
  bargeInSource = null;
  bargeInMute = null;
  if (media && !preserveMedia) media.getTracks().forEach(track => track.stop());
  if (bargeInAudioCtx) {
    try { await bargeInAudioCtx.close(); } catch { /* ignore */ }
    bargeInAudioCtx = null;
  }
  bargeInMedia = null;
  bargeInActive = false;
  bargeInVad = null;
  if (!preserveMedia) {
    bargeInTriggered = false;
    bargeInPreRoll = [];
    bargeInPreRollSamples = 0;
    bargeInUtterancePcm = [];
    bargeInUtteranceSamples = 0;
  }
  return media;
}

async function triggerVoiceBargeIn(vadMetrics = {}) {
  if (!bargeInActive || bargeInTriggered || !bargeInMedia) return;
  bargeInTriggered = true;
  const preservedMedia = bargeInMedia;
  const readInterruption = () => {
    const captured = bargeInUtterancePcm.length ? bargeInUtterancePcm : bargeInPreRoll;
    return captured.map(chunk => new Int16Array(chunk));
  };
  console.log(`[barge-in] triggered with ${Math.round(bargeInUtteranceSamples / 16)}ms captured`);
  const sinceFinalMs = lastVoiceFinalizedAt ? Date.now() - lastVoiceFinalizedAt : Infinity;
  if (sinceFinalMs <= 5000) {
    recordVadDiagnostic('suspected_false_cutoff', 'barge_in', {
      ...vadMetrics,
      durationMs: sinceFinalMs,
      reason: lastVoiceFinalReason
    });
  }
  preserveBargeInOnNextCancel = true;
  cancelActiveTurn();
  setOrbState('listening', 'Listening...');
  try {
    await startStreamingListen({
      fromConversation: true,
      existingMedia: preservedMedia,
      initialPcmProvider: readInterruption
    });
  } catch (error) {
    await stopBargeInMonitor();
    preservedMedia.getTracks().forEach(track => track.stop());
    console.warn('Voice barge-in handoff failed:', error.message || error);
    setOrbState('idle', idleStatusText());
  }
}

async function startBargeInMonitor() {
  if (!isConversationMode() || !sttStreamingEnabled || !isSpeaking || isListening || bargeInActive) return;
  try {
    bargeInMedia = await navigator.mediaDevices.getUserMedia({
      audio: processedMicrophoneConstraints()
    });
    if (!isConversationMode() || !isSpeaking || playbackCancelled) {
      await stopBargeInMonitor();
      return;
    }
    bargeInAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (bargeInAudioCtx.state === 'suspended') await bargeInAudioCtx.resume().catch(() => {});
    bargeInNoiseFloor = 0.008;
    bargeInVad = createAdaptiveVad({
      calibrationMs: BARGE_IN_GRACE_MS,
      startWindowMs: BARGE_IN_SUSTAIN_MS,
      gapToleranceMs: BARGE_IN_GAP_TOLERANCE_MS,
      minStartRms: BARGE_IN_MIN_RMS,
      initialNoiseFloor: bargeInNoiseFloor
    });
    bargeInPreRoll = [];
    bargeInPreRollSamples = 0;
    bargeInUtterancePcm = [];
    bargeInUtteranceSamples = 0;
    bargeInTriggered = false;
    bargeInActive = true;
    const capture = await attachPcmCapture(bargeInAudioCtx, bargeInMedia, samples => {
      if (!bargeInActive) return;
      const pcm = rememberBargeInPcm(samples, bargeInAudioCtx.sampleRate);
      if (bargeInTriggered) {
        appendBargeInUtterancePcm(pcm);
        return;
      }
      const now = performance.now();
      const decision = bargeInVad.process(samples, now, {
        sampleRate: bargeInAudioCtx.sampleRate,
        // Playback energy is an extra echo guard on top of WebRTC AEC.
        minimumStartRms: Math.max(BARGE_IN_MIN_RMS, waveformEnergy * 0.06)
      });
      bargeInNoiseFloor = decision.noiseFloor;
      if (decision.event === 'candidate') {
        if (!bargeInUtterancePcm.length) beginBargeInUtterance();
        else appendBargeInUtterancePcm(pcm);
      } else if (decision.event === 'speech_start') {
        if (!bargeInUtterancePcm.length) beginBargeInUtterance();
        else appendBargeInUtterancePcm(pcm);
        triggerVoiceBargeIn(decision);
      } else if (decision.event === 'false_start') {
        recordVadDiagnostic('false_start', 'barge_in', decision);
        bargeInUtterancePcm = [];
        bargeInUtteranceSamples = 0;
      } else if (decision.state === 'candidate') {
        appendBargeInUtterancePcm(pcm);
      } else if (decision.event === 'idle') {
        bargeInUtterancePcm = [];
        bargeInUtteranceSamples = 0;
      }
    });
    bargeInSource = capture.source;
    bargeInProcessor = capture.processor;
    bargeInMute = capture.mute;
  } catch (error) {
    await stopBargeInMonitor();
    console.warn('[barge-in] microphone monitor unavailable:', error.message || error);
  }
}

async function startStreamingListen({
  fromConversation = false,
  existingMedia = null,
  initialPcmProvider = null
} = {}) {
  stopWakeListening();
  discardNextRecording = false;
  listeningFromConversation = fromConversation;
  showSearchEvidence([], []);
  hideTranscript();
  streamListenActive = true;
  streamEndpointAt = null;

  const ready = new Promise((resolve, reject) => {
    const onReady = () => { cleanup(); resolve(); };
    const onError = payload => {
      cleanup();
      reject(new Error(payload?.error || 'Deepgram streaming unavailable'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Deepgram streaming ready timeout'));
    }, 5000);
    function cleanup() {
      clearTimeout(timer);
      socket.off('stt:ready', onReady);
      socket.off('stt:error', onError);
    }
    socket.once('stt:ready', onReady);
    socket.once('stt:error', onError);
    socket.emit('stt:start');
  });

  try {
    streamMedia = existingMedia || await navigator.mediaDevices.getUserMedia({
      audio: processedMicrophoneConstraints()
    });
    await ready;

    streamAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (streamAudioCtx.state === 'suspended') {
      await streamAudioCtx.resume().catch(() => {});
    }
    const capture = await attachPcmCapture(streamAudioCtx, streamMedia);
    streamSource = capture.source;
    streamProcessor = capture.processor;
    streamMute = capture.mute;

    // Keep the old monitor capturing until the new Deepgram socket and audio
    // graph are ready, then hand over its final 500ms so “wait—” survives.
    const initialPcm = typeof initialPcmProvider === 'function' ? initialPcmProvider() : [];
    if (existingMedia) await stopBargeInMonitor({ preserveMedia: true });

    isListening = true;
    for (const chunk of initialPcm) socket.emit('stt:audio', chunk.buffer);
    setOrbState(
      'listening',
      fromConversation || isConversationMode()
        ? 'Listening... pause to send'
        : 'Listening... Tap to stop'
    );

    streamPartialHandler = payload => {
      if (!streamListenActive || !payload?.transcript || !statusText || !isListening) return;
      if (streamNoSpeechTimer) {
        clearTimeout(streamNoSpeechTimer);
        streamNoSpeechTimer = null;
      }
      statusText.textContent = payload.is_final
        ? 'Listening...'
        : `Hearing: ${String(payload.transcript).slice(0, 48)}`;
    };
    socket.on('stt:partial', streamPartialHandler);

    streamFinalHandler = async payload => {
      if (!streamListenActive) return;
      streamListenActive = false;
      detachStreamSocketHandlers();
      clearStreamTimers();
      isListening = false;
      await teardownStreamCapture();

      if (discardNextRecording) {
        discardNextRecording = false;
        listeningFromConversation = false;
        setOrbState('idle', idleStatusText());
        maybeStartWakeListening();
        return;
      }

      const transcript = String(payload?.transcript || '').trim();
      const sttMs = streamEndpointAt
        ? Math.max(0, Math.round(performance.now() - streamEndpointAt))
        : 0;
      if (!transcript) {
        listeningFromConversation = false;
        setOrbState('idle', idleStatusText());
        maybeStartWakeListening();
        return;
      }
      rememberVoiceFinal(payload?.reason || 'stream_final');
      setOrbState('thinking', 'Thinking...');
      await processTranscript(transcript, { sttMs, streamed: true });
    };
    socket.once('stt:final', streamFinalHandler);

    streamErrorHandler = async () => {
      if (!streamListenActive) return;
      streamListenActive = false;
      detachStreamSocketHandlers();
      clearStreamTimers();
      isListening = false;
      await teardownStreamCapture();
      try {
        await startListeningBatch({ fromConversation });
      } catch {
        listeningFromConversation = false;
        setOrbState('error', 'Microphone blocked');
        setTimeout(() => setOrbState('idle', idleStatusText()), 3000);
      }
    };
    socket.once('stt:error', streamErrorHandler);

    streamMaxTimer = setTimeout(() => requestStreamStop(), STREAM_MAX_UTTERANCE_MS);
    if (fromConversation || isConversationMode()) {
      streamNoSpeechTimer = setTimeout(() => {
        if (!isListening || !streamListenActive) return;
        discardNextRecording = true;
        requestStreamStop();
      }, NO_SPEECH_IDLE_MS);
    }
  } catch (error) {
    streamListenActive = false;
    detachStreamSocketHandlers();
    clearStreamTimers();
    isListening = false;
    if (existingMedia) await stopBargeInMonitor();
    await teardownStreamCapture();
    console.warn('[stt] streaming start failed, using batch:', error.message || error);
    await startListeningBatch({ fromConversation });
  }
}

async function startListening({ fromConversation = false } = {}) {
  if (sttStreamingEnabled) {
    await startStreamingListen({ fromConversation });
    return;
  }
  await startListeningBatch({ fromConversation });
}

async function startListeningBatch({ fromConversation = false } = {}) {
  // Do NOT clear playbackCancelled here — a barge-in after interrupt would
  // otherwise let the previous turn's queued TTS resume. processAudio clears
  // it when the new turn actually owns the mic→reply pipeline.
  stopWakeListening();
  discardNextRecording = false;
  listeningFromConversation = fromConversation;
  showSearchEvidence([], []);
  hideTranscript();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: processedMicrophoneConstraints()
    });

    // Safari prefers audio/mp4, Chrome prefers audio/webm
    let mimeType = 'audio/webm';
    if (!MediaRecorder.isTypeSupported('audio/webm') && MediaRecorder.isTypeSupported('audio/mp4')) {
      mimeType = 'audio/mp4';
    }

    // Cap bitrate so Whisper/STT uploads stay small — long webm blobs were a
    // real slice of the measured ~6s transcription stage.
    const recorderOptions = { mimeType, audioBitsPerSecond: 48000 };
    try {
      mediaRecorder = new MediaRecorder(stream, recorderOptions);
    } catch {
      mediaRecorder = new MediaRecorder(stream, { mimeType });
    }
    audioChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      clearSilenceWatch();
      // Release microphone tracks immediately when stopped
      stream.getTracks().forEach(track => track.stop());

      if (discardNextRecording) {
        discardNextRecording = false;
        listeningFromConversation = false;
        return;
      }

      const audioBlob = new Blob(audioChunks, { type: mimeType });
      // Empty captures used to re-arm forever in conversation mode and
      // felt like the old spotty always-on mic. Go idle instead.
      if (audioBlob.size === 0) {
        listeningFromConversation = false;
        setOrbState('idle', idleStatusText());
        return;
      }

      await processAudio(audioBlob);
    };

    mediaRecorder.start();
    isListening = true;
    setOrbState(
      'listening',
      fromConversation || isConversationMode()
        ? 'Listening... pause to send'
        : 'Listening... Tap to stop'
    );
    // Every listen gets microphone-driven visuals. Conversation follow-ups
    // additionally end on a short pause so you don't have to re-tap the orb.
    armSilenceAutoStop(stream, { autoStop: fromConversation || isConversationMode() });
  } catch (err) {
    console.error('Mic error:', err);
    listeningFromConversation = false;
    setOrbState('error', 'Microphone blocked');
    setTimeout(() => setOrbState('idle', idleStatusText()), 3000);
    throw err;
  }
}

function cancelListeningToIdle() {
  discardNextRecording = true;
  clearSilenceWatch();
  if (streamListenActive) {
    requestStreamStop();
    return;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  isListening = false;
  listeningFromConversation = false;
  setOrbState('idle', idleStatusText());
  maybeStartWakeListening();
}

function stopListening() {
  clearSilenceWatch();
  if (streamListenActive) {
    setOrbState('thinking', 'Processing Voice...');
    requestStreamStop();
    return;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  isListening = false;
  setOrbState('thinking', 'Processing Voice...');
}

async function processTranscript(transcript, { sttMs = 0, streamed = false } = {}) {
  if (turnAbortController) {
    try { turnAbortController.abort(); } catch { /* ignore */ }
  }
  turnAbortController = new AbortController();
  const { signal } = turnAbortController;
  playbackCancelled = false;
  isProcessing = true;
  const myTurn = ++currentTurn;
  const timing = { t0: performance.now(), sttMs, whisperMs: sttMs, streamed };
  let chatTurnId = null;
  const stale = () => myTurn !== currentTurn || signal.aborted;
  try {
    console.log('User:', transcript);
    if (stale()) return;
    if (!transcript || !String(transcript).trim()) {
      setOrbState('idle', idleStatusText());
      maybeStartWakeListening();
      return;
    }

    setOrbState('thinking', 'Thinking...');
    const chatStartedAt = performance.now();
    chatTurnId = createChatTurnId();
    activeChatTurnId = chatTurnId;
    currentStreamedReplyParts = [];
    const interruptedReply = pendingInterruptedReply;
    pendingInterruptedReply = '';
    const chatRes = await authenticatedFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: transcript,
        turn_id: chatTurnId,
        ...(interruptedReply ? { interrupted_reply: interruptedReply } : {})
      }),
      signal
    });

    if (!chatRes.ok) throw new Error('Chat API failed');
    if (stale()) return;

    resetVoiceQueue();
    const reader = chatRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let speechChunkCount = 0;
    let finalResult = null;

    while (true) {
      if (stale()) {
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'sentence') {
          if (stale()) continue;
          currentStreamedReplyParts.push(event.text);
          speechChunkCount += 1;
          if (speechChunkCount === 1) {
            timing.firstSentenceMs = Math.round(performance.now() - chatStartedAt);
          }
          enqueueSpeechAudio(event.text, speechChunkCount === 1, timing, signal);
        } else if (event.type === 'done') {
          finalResult = event;
          if (event.timing) {
            timing.serverTiming = event.timing;
            console.log(
              `[timing] server` +
              ` (pre_model ${event.timing.pre_model_ms ?? '?'}ms` +
              `, first_delta ${event.timing.first_delta_ms ?? '?'}ms` +
              `, context ${event.timing.context_build_ms ?? '?'}ms` +
              `${event.timing.lightweight ? ', lightweight' : ''}` +
              `${event.timing.skip_semantic ? ', no-semantic' : ''}` +
              `${event.timing.direct_metrics ? ', direct-metrics' : ''}` +
              `${event.brain?.reasoning_effort ? `, reasoning ${event.brain.reasoning_effort}` : ''})`
            );
          }
        } else if (event.type === 'error') {
          throw new Error(event.error);
        }
      }
    }

    if (stale()) return;
    if (!finalResult) throw new Error('Chat stream ended without a result.');
    const { reply, sources = [], web_results: webResults = [] } = finalResult;
    console.log('AURA:', reply);
    if (speechChunkCount === 0 && reply) {
      timing.firstSentenceMs = Math.round(performance.now() - chatStartedAt);
      enqueueSpeechAudio(reply, true, timing, signal);
    }
    showSearchEvidence(webResults, sources, reply);
    finishVoiceQueue();
  } catch (err) {
    if (err?.name === 'AbortError' || stale()) return;
    console.error(err);
    playbackCancelled = true;
    audioPlayer.pause();
    releaseAudioUrl();
    showSearchEvidence([], []);
    hideTranscript();
    setOrbState('error', 'Error occurred. Tap to retry.');
    isSpeaking = false;
    setTimeout(() => {
      if (myTurn !== currentTurn) return;
      setOrbState('idle', idleStatusText());
      refreshTranscript();
      maybeStartWakeListening();
    }, 3000);
  } finally {
    if (activeChatTurnId === chatTurnId) activeChatTurnId = null;
    if (myTurn === currentTurn) {
      isProcessing = false;
      turnAbortController = null;
    }
  }
}

async function processAudio(audioBlob) {
  if (turnAbortController) {
    try {
      turnAbortController.abort();
    } catch {
      // ignore
    }
  }
  turnAbortController = new AbortController();
  const { signal } = turnAbortController;
  // This turn owns playback now.
  playbackCancelled = false;
  isProcessing = true;
  const myTurn = ++currentTurn;
  // Wall-clock voice latency marks: mic-stop → first audible audio.
  // Open the browser console on a live turn to read `[timing] TTFA …`.
  const timing = { t0: performance.now() };
  let chatTurnId = null;
  // True once this turn has been superseded (a newer tap started, or this
  // one errored out) - any UI write after that point is a stale reply and
  // must be dropped instead of displayed/spoken.
  const stale = () => myTurn !== currentTurn || signal.aborted;
  try {
    // 1. Send Audio to Whisper for Transcription
    const formData = new FormData();
    const ext = audioBlob.type.includes('mp4') ? 'm4a' : 'webm';
    formData.append('audio', audioBlob, `recording.${ext}`);

    const sttStartedAt = performance.now();
    const transcribeRes = await authenticatedFetch('/api/transcribe', {
      method: 'POST',
      body: formData,
      signal
    });

    if (!transcribeRes.ok) throw new Error('Transcription failed');
    const { transcript } = await transcribeRes.json();
    timing.sttMs = Math.round(performance.now() - sttStartedAt);
    timing.whisperMs = timing.sttMs; // back-compat for older console greps
    console.log('User:', transcript);

    if (stale()) return;
    if (!transcript || transcript.trim() === '') {
      setOrbState('idle', idleStatusText());
      maybeStartWakeListening();
      return;
    }

    setOrbState('thinking', 'Thinking...');

    // 2. Send text to the chat backend. The response is newline-delimited
    // JSON, not one object - legacy `sentence` events now carry the first
    // complete sentence followed by connected speech groups, then one final
    // `done` event. The opening sentence begins TTS while the rest of the
    // reply is still being generated; later groups preserve voice continuity.
    const chatStartedAt = performance.now();
    chatTurnId = createChatTurnId();
    activeChatTurnId = chatTurnId;
    currentStreamedReplyParts = [];
    const interruptedReply = pendingInterruptedReply;
    pendingInterruptedReply = '';
    const chatRes = await authenticatedFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: transcript,
        turn_id: chatTurnId,
        ...(interruptedReply ? { interrupted_reply: interruptedReply } : {})
      }),
      signal
    });

    if (!chatRes.ok) throw new Error('Chat API failed');
    if (stale()) return;

    resetVoiceQueue();
    const reader = chatRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let speechChunkCount = 0;
    let finalResult = null;

    while (true) {
      if (stale()) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'sentence') {
          if (stale()) continue;
          currentStreamedReplyParts.push(event.text);
          speechChunkCount += 1;
          if (speechChunkCount === 1) {
            timing.firstSentenceMs = Math.round(performance.now() - chatStartedAt);
          }
          enqueueSpeechAudio(event.text, speechChunkCount === 1, timing, signal);
        } else if (event.type === 'done') {
          finalResult = event;
          // Arrives after the tool loop finishes — later than TTFA, but this is
          // where pre_model / first_delta / lightweight are known accurately.
          if (event.timing) {
            timing.serverTiming = event.timing;
            console.log(
              `[timing] server` +
              ` (pre_model ${event.timing.pre_model_ms ?? '?'}ms` +
              `, first_delta ${event.timing.first_delta_ms ?? '?'}ms` +
              `, context ${event.timing.context_build_ms ?? '?'}ms` +
              `${event.timing.lightweight ? ', lightweight' : ''}` +
              `${event.timing.skip_semantic ? ', no-semantic' : ''}` +
              `${event.timing.direct_metrics ? ', direct-metrics' : ''}` +
              `${event.brain?.reasoning_effort ? `, reasoning ${event.brain.reasoning_effort}` : ''})`
            );
          }
        } else if (event.type === 'error') {
          throw new Error(event.error);
        }
      }
    }

    if (stale()) return;
    if (!finalResult) throw new Error('Chat stream ended without a result.');
    const { reply, sources = [], web_results: webResults = [] } = finalResult;
    console.log('AURA:', reply);

    // Fallback for the rare case nothing streamed as sentences (e.g. an
    // empty reply) - still speak the full reply as one clip rather than
    // silently saying nothing.
    if (speechChunkCount === 0 && reply) {
      timing.firstSentenceMs = Math.round(performance.now() - chatStartedAt);
      enqueueSpeechAudio(reply, true, timing, signal);
    }

    // Evidence is shown once the reply is fully known, which lands close to
    // when the last sentence starts playing rather than the first - sources
    // and evidence are only fully resolved once the whole tool loop
    // finishes, so this is the earliest point they can be shown accurately.
    showSearchEvidence(webResults, sources, reply);
    finishVoiceQueue();
  } catch (err) {
    if (err?.name === 'AbortError' || stale()) return;
    console.error(err);
    // Halts any sentences already queued/playing from this same turn before
    // the error - startListening() resets this back to false at the start
    // of the next turn, same as a manual interrupt.
    playbackCancelled = true;
    audioPlayer.pause();
    releaseAudioUrl();
    showSearchEvidence([], []);
    hideTranscript();
    setOrbState('error', 'Error occurred. Tap to retry.');
    isSpeaking = false;
    setTimeout(() => {
      if (myTurn !== currentTurn) return;
      setOrbState('idle', idleStatusText());
      refreshTranscript();
      maybeStartWakeListening();
    }, 3000);
  } finally {
    if (activeChatTurnId === chatTurnId) activeChatTurnId = null;
    // Only the live turn clears the processing lock — a cancelled turn's
    // finally must not unlock while a newer barge-in turn is running.
    if (myTurn === currentTurn) {
      isProcessing = false;
      turnAbortController = null;
    }
  }
}

wakeListener = window.AuraWakeWord?.createWakeWordListener({
  shouldRun: canRunWakeListener,
  onWake: async () => {
    console.log('[wake] hey Aura detected');
    try {
      await ensureAudioGraph().catch(() => false);
      await startListening({ fromConversation: true });
    } catch (error) {
      console.warn('[wake] failed to start listening:', error.message || error);
      setOrbState('idle', idleStatusText());
      maybeStartWakeListening();
    }
  },
  onStatus: text => {
    if (!isListening && !isSpeaking && !isProcessing) {
      setOrbState('idle', text);
    }
  }
}) || null;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    stopWakeListening();
    stopBargeInMonitor();
    return;
  }
  if (!isListening && !isSpeaking && !isProcessing) {
    maybeStartWakeListening();
  }
});

syncConversationToggle();
refreshSttStreamingFlag();
if (!isListening && !isSpeaking && !isProcessing) {
  setOrbState(orb.className || 'idle', idleStatusText());
}
hideTranscript();
// Don't auto-start wake until a user gesture has unlocked audio/mic once.
// First orb tap or conversation toggle will arm it via setConversationMode /
// startListening completion paths.
