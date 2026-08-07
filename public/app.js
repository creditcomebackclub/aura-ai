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
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

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
const SILENCE_HANGOVER_MS = 400;
const MIN_UTTERANCE_MS = 350;
const MAX_UTTERANCE_MS = 20000;
// If the mic arms after her reply and nobody speaks, drop back to idle
// instead of holding the mic open until MAX_UTTERANCE_MS.
const NO_SPEECH_IDLE_MS = 4000;
// Ignore the first beat after arming so speaker bleed / room echo from her
// last sentence doesn't look like the start of Chris's reply.
const LISTEN_ARM_GRACE_MS = 500;
const SPEECH_RMS_START = 0.028;
const SPEECH_RMS_CONTINUE = 0.014;

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

let mediaRecorder = null;
let audioChunks = [];

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
// Idle "hey Aura" wake listener (Web Speech). Created after startListening exists.
let wakeListener = null;

// Hard-stop the active turn: mute audio, invalidate in-flight processAudio,
// abort network work, and drop the speech queue so a barge-in can't get
// overwritten by a stale reply that finishes later.
function cancelActiveTurn() {
  playbackCancelled = true;
  currentTurn += 1;
  isProcessing = false;
  stopWakeListening();
  if (turnAbortController) {
    try {
      turnAbortController.abort();
    } catch {
      // AbortController.abort is safe; ignore exotic environments.
    }
    turnAbortController = null;
  }
  audioPlayer.pause();
  audioPlayer.currentTime = 0;
  releaseAudioUrl();
  resetVoiceQueue();
  isSpeaking = false;
  stopVoiceWave();
  showSearchEvidence([], []);
  hideTranscript();
}

// Cuts AURA off mid-sentence and returns the orb to idle (unless the caller
// immediately re-arms listening for a barge-in).
function stopSpeaking() {
  cancelActiveTurn();
  setOrbState('idle', idleStatusText());
}

// State Management
function setOrbState(state, text) {
  orb.className = state;
  statusText.textContent = text;
  // Lets the wordmark's neon track the orb without duplicating state.
  document.body.dataset.auraState = state;
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
    ? 'rgba(255, 174, 91, 0.95)'
    : 'rgba(100, 185, 255, 0.48)');
  gradient.addColorStop(1, 'rgba(57, 137, 255, 0.08)');

  voiceWaveContext.beginPath();
  voiceWaveContext.lineWidth = Math.max(2, width / 320);
  voiceWaveContext.strokeStyle = gradient;
  voiceWaveContext.lineCap = 'round';
  voiceWaveContext.lineJoin = 'round';
  voiceWaveContext.shadowBlur = isSpeaking ? 18 : 8;
  voiceWaveContext.shadowColor = isSpeaking
    ? 'rgba(255, 137, 45, 0.7)'
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
window.addEventListener('resize', () => drawVoiceWave(
  isSpeaking && waveformSamples ? waveformSamples : null
));
reducedMotion.addEventListener?.('change', () => drawVoiceWave());

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

function clearSilenceWatch() {
  if (silenceWatchFrame) {
    cancelAnimationFrame(silenceWatchFrame);
    silenceWatchFrame = null;
  }
  if (silenceListenContext) {
    silenceListenContext.close().catch(() => {});
    silenceListenContext = null;
  }
}

function armSilenceAutoStop(stream) {
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
  const startedAt = Date.now();
  let heardSpeech = false;
  let silenceStartedAt = null;

  const tick = () => {
    if (!isListening || !mediaRecorder || mediaRecorder.state === 'inactive') {
      clearSilenceWatch();
      return;
    }
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = (samples[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / samples.length);
    const elapsed = Date.now() - startedAt;
    if (!heardSpeech && elapsed >= NO_SPEECH_IDLE_MS) {
      cancelListeningToIdle();
      return;
    }
    if (elapsed >= MAX_UTTERANCE_MS) {
      stopListening();
      return;
    }
    // Skip RMS speech detection during the arming grace window so residual
    // speaker bleed from her last sentence doesn't trip heardSpeech.
    if (elapsed >= LISTEN_ARM_GRACE_MS) {
      const threshold = heardSpeech ? SPEECH_RMS_CONTINUE : SPEECH_RMS_START;
      if (rms >= threshold) {
        heardSpeech = true;
        silenceStartedAt = null;
      } else if (heardSpeech && elapsed >= MIN_UTTERANCE_MS) {
        if (!silenceStartedAt) silenceStartedAt = Date.now();
        else if (Date.now() - silenceStartedAt >= SILENCE_HANGOVER_MS) {
          stopListening();
          return;
        }
      }
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

function resetVoiceQueue() {
  voiceGeneration += 1;
  voiceQueueTail = Promise.resolve();
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
  const ttsPromise = authenticatedFetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    ...(signal ? { signal } : {})
  }).then(res => {
    if (!res.ok) throw new Error('TTS API failed');
    return res.blob();
  }).then(blob => {
    if (timing && isFirst) {
      timing.ttsMs = Math.round(performance.now() - ttsStartedAt);
    }
    return blob;
  });

  voiceQueueTail = voiceQueueTail.then(async () => {
    if (playbackCancelled || signal?.aborted || generation !== voiceGeneration) return;
    let blob;
    try {
      blob = await ttsPromise;
    } catch (error) {
      if (error?.name === 'AbortError' || playbackCancelled) return;
      console.error('TTS error:', error);
      return;
    }
    if (playbackCancelled || signal?.aborted || generation !== voiceGeneration) return;
    await playBlobAndWait(blob, {
      onPlayStart: isFirst && timing
        ? () => {
          timing.ttfaMs = Math.round(performance.now() - timing.t0);
          console.log(
            `[timing] TTFA ${timing.ttfaMs}ms` +
            ` (whisper ${timing.whisperMs ?? '?'}ms` +
            `, first_sentence ${timing.firstSentenceMs ?? '?'}ms` +
            `, tts ${timing.ttsMs ?? '?'}ms)`
          );
        }
        : null
    });
  });
}

// Called once the whole reply is known to be fully queued (the stream's
// 'done' event arrived) - the actual "return to idle" only happens once
// every queued clip has finished playing, not the moment this is called.
function finishVoiceQueue() {
  const generation = voiceGeneration;
  voiceQueueTail = voiceQueueTail.then(async () => {
    if (playbackCancelled || generation !== voiceGeneration) return;
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

async function startListening({ fromConversation = false } = {}) {
  // Do NOT clear playbackCancelled here — a barge-in after interrupt would
  // otherwise let the previous turn's queued TTS resume. processAudio clears
  // it when the new turn actually owns the mic→reply pipeline.
  stopWakeListening();
  discardNextRecording = false;
  listeningFromConversation = fromConversation;
  showSearchEvidence([], []);
  hideTranscript();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

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
    // Conversation follow-ups (and normal listens while conversation mode is
    // on) end on a short pause so you don't have to re-tap the orb.
    if (fromConversation || isConversationMode()) {
      armSilenceAutoStop(stream);
    }
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
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  isListening = false;
  setOrbState('thinking', 'Processing Voice...');
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
  // True once this turn has been superseded (a newer tap started, or this
  // one errored out) - any UI write after that point is a stale reply and
  // must be dropped instead of displayed/spoken.
  const stale = () => myTurn !== currentTurn || signal.aborted;
  try {
    // 1. Send Audio to Whisper for Transcription
    const formData = new FormData();
    const ext = audioBlob.type.includes('mp4') ? 'm4a' : 'webm';
    formData.append('audio', audioBlob, `recording.${ext}`);

    const whisperStartedAt = performance.now();
    const transcribeRes = await authenticatedFetch('/api/transcribe', {
      method: 'POST',
      body: formData,
      signal
    });

    if (!transcribeRes.ok) throw new Error('Transcription failed');
    const { transcript } = await transcribeRes.json();
    timing.whisperMs = Math.round(performance.now() - whisperStartedAt);
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
    const chatRes = await authenticatedFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: transcript }),
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
              `${event.timing.direct_metrics ? ', direct-metrics' : ''})`
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
    return;
  }
  if (!isListening && !isSpeaking && !isProcessing) {
    maybeStartWakeListening();
  }
});

syncConversationToggle();
if (!isListening && !isSpeaking && !isProcessing) {
  setOrbState(orb.className || 'idle', idleStatusText());
}
hideTranscript();
// Don't auto-start wake until a user gesture has unlocked audio/mic once.
// First orb tap or conversation toggle will arm it via setConversationMode /
// startListening completion paths.