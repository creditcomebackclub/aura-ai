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
    const email = window.prompt('Enter your email address and AURA will send you a secure sign-in link:');
    if (email && email.trim()) {
      const response = await fetch('/auth/request-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() })
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
const sourcePanel = document.getElementById('source-panel');
const sourceLabel = document.getElementById('source-label');
const webAnswer = document.getElementById('web-answer');
const sourceLinks = document.getElementById('source-links');
const voiceWave = document.getElementById('voice-wave');
const voiceWaveContext = voiceWave.getContext('2d');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// Global audio player for iOS Safari unlocking
const audioPlayer = new Audio();

let isListening = false;
let isSpeaking = false;
let audioUnlocked = false;
let audioContext = null;
let audioAnalyser = null;
let audioSource = null;
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

// Tracks the clip currently loaded so it can be torn down on interrupt.
let currentAudioUrl = null;
// Set when the user interrupts, so a reply whose audio is still being
// generated doesn't start playing after they've told her to stop.
let playbackCancelled = false;

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
    audioSource.connect(audioAnalyser);
    audioAnalyser.connect(audioContext.destination);
  }
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  return true;
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

// Shows AURA's last answer as on-screen text in the side panel. When the
// turn included a live web search, that takes priority (citations/sources
// are the more useful thing to show); otherwise falls back to her plain
// reply text, so every answer is readable on screen, not just search ones.
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
  } else if (replyText.trim()) {
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
  sourceLabel.textContent = isSearchResult ? 'Live web result' : 'AURA said';

  // Non-persistent by design: only ever made visible when there's actually
  // something to show, and hidden again as soon as there isn't - opacity/
  // transform driven (see CSS) rather than the `hidden` attribute, so it can
  // fade in/out instead of snapping.
  const hasContent = webAnswer.childElementCount > 0 || sourceLinks.childElementCount > 0;
  sourcePanel.classList.toggle('visible', hasContent);
  sourcePanel.setAttribute('aria-hidden', String(!hasContent));
}

// Cuts AURA off mid-sentence and returns the orb to idle.
function stopSpeaking() {
  playbackCancelled = true;
  audioPlayer.pause();
  audioPlayer.currentTime = 0;
  releaseAudioUrl();
  isSpeaking = false;
  stopVoiceWave();
  setOrbState('idle', 'Tap to talk to AURA');
  showSearchEvidence([], []);
}

function releaseAudioUrl() {
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
}

// Loads and plays a reply, unless the user interrupted while it was generating.
function playAudioBlob(blob) {
  if (playbackCancelled) return;

  releaseAudioUrl();
  currentAudioUrl = URL.createObjectURL(blob);
  audioPlayer.src = currentAudioUrl;

  setOrbState('speaking', 'Speaking... Tap to stop');
  isSpeaking = true;

  audioPlayer.onplay = startVoiceWave;
  audioPlayer.onended = () => {
    isSpeaking = false;
    stopVoiceWave();
    releaseAudioUrl();
    setOrbState('idle', 'Tap to talk to AURA');
    showSearchEvidence([], []);
  };
  audioPlayer.onerror = () => {
    isSpeaking = false;
    stopVoiceWave();
    releaseAudioUrl();
    setOrbState('error', 'Voice playback failed');
    showSearchEvidence([], []);
  };

  ensureAudioGraph()
    .catch(() => false)
    .finally(() => {
      audioPlayer.play().catch(error => {
        console.error('Audio playback error:', error);
        isSpeaking = false;
        stopVoiceWave();
        setOrbState('error', 'Tap to enable voice');
      });
    });
}

// WebSocket Reconnection Handling
socket.on('connect', () => {
  console.log('Connected to AURA server');
  if (orb.className === 'error' || statusText.textContent.includes('Reconnecting')) {
    setOrbState('idle', 'Tap to talk to AURA');
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
    const ttsRes = await authenticatedFetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: data.text })
    });
    if (!ttsRes.ok) throw new Error('TTS API failed');
    const blob = await ttsRes.blob();
    playAudioBlob(blob);
  } catch (err) { console.error(err); setOrbState('idle', 'Tap to talk to AURA'); }
});


// Interaction & Microphone Permission Handling
document.getElementById('orb-container').addEventListener('click', async () => {
  if (!audioUnlocked) {
    await ensureAudioGraph().catch(() => false);
    audioPlayer.play().catch(() => {});
    audioUnlocked = true;
  }

  // Tapping the orb while she's speaking (orange) interrupts her.
  if (isSpeaking) {
    stopSpeaking();
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

async function startListening() {
  // Clear any prior interrupt so this new exchange is allowed to speak.
  playbackCancelled = false;
  showSearchEvidence([], []);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Safari prefers audio/mp4, Chrome prefers audio/webm
    let mimeType = 'audio/webm';
    if (!MediaRecorder.isTypeSupported('audio/webm') && MediaRecorder.isTypeSupported('audio/mp4')) {
      mimeType = 'audio/mp4';
    }

    mediaRecorder = new MediaRecorder(stream, { mimeType });
    audioChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      // Release microphone tracks immediately when stopped
      stream.getTracks().forEach(track => track.stop());

      const audioBlob = new Blob(audioChunks, { type: mimeType });
      if (audioBlob.size === 0) {
        setOrbState('idle', 'Tap to talk to AURA');
        return;
      }

      await processAudio(audioBlob);
    };

    mediaRecorder.start();
    isListening = true;
    setOrbState('listening', 'Listening... Tap to stop');
  } catch (err) {
    console.error('Mic error:', err);
    setOrbState('error', 'Microphone blocked');
    setTimeout(() => setOrbState('idle', 'Tap to talk to AURA'), 3000);
  }
}

function stopListening() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  isListening = false;
  setOrbState('thinking', 'Processing Voice...');
}

async function processAudio(audioBlob) {
  try {
    // 1. Send Audio to Whisper for Transcription
    const formData = new FormData();
    const ext = audioBlob.type.includes('mp4') ? 'm4a' : 'webm';
    formData.append('audio', audioBlob, `recording.${ext}`);

    const transcribeRes = await authenticatedFetch('/api/transcribe', {
      method: 'POST',
      body: formData
    });

    if (!transcribeRes.ok) throw new Error('Transcription failed');
    const { transcript } = await transcribeRes.json();
    console.log('User:', transcript);

    if (!transcript || transcript.trim() === '') {
      setOrbState('idle', 'Tap to talk to AURA');
      return;
    }

    setOrbState('thinking', 'Thinking...');

    // 2. Send text to the chat backend
    const chatRes = await authenticatedFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: transcript })
    });

    if (!chatRes.ok) throw new Error('Chat API failed');
    const { reply, sources = [], web_results: webResults = [] } = await chatRes.json();
    console.log('AURA:', reply);

    // 3. Fetch TTS from Cartesia proxy
    setOrbState('thinking', 'Generating Voice...');
    const ttsRes = await authenticatedFetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: reply })
    });

    if (!ttsRes.ok) throw new Error('TTS API failed');

    // 4. Play audio. Evidence is shown right as playback starts, not the
    // moment the reply text arrives - otherwise the panel appears during
    // "Generating Voice..." well before she actually starts talking.
    const blob = await ttsRes.blob();
    showSearchEvidence(webResults, sources, reply);
    playAudioBlob(blob);
  } catch (err) {
    console.error(err);
    showSearchEvidence([], []);
    setOrbState('error', 'Error occurred. Tap to retry.');
    isSpeaking = false;
    setTimeout(() => setOrbState('idle', 'Tap to talk to AURA'), 3000);
  }
}
