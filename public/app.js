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

  const pointCount = samples?.length || 72;
  for (let index = 0; index < pointCount; index += 1) {
    const progress = index / Math.max(1, pointCount - 1);
    const edgeFade = Math.sin(Math.PI * progress);
    const normalized = samples
      ? (samples[index] - 128) / 128
      : reducedMotion.matches
        ? 0
        : Math.sin(progress * Math.PI * 4) * 0.035;
    const x = progress * width;
    const y = centerY + normalized * amplitude * edgeFade;
    if (index === 0) voiceWaveContext.moveTo(x, y);
    else voiceWaveContext.lineTo(x, y);
  }
  voiceWaveContext.stroke();
}

function stopVoiceWave() {
  if (waveformFrame) cancelAnimationFrame(waveformFrame);
  waveformFrame = null;
  voiceWave.classList.remove('speaking');
  drawVoiceWave();
}

function animateVoiceWave() {
  if (!isSpeaking) {
    stopVoiceWave();
    return;
  }
  if (audioAnalyser && waveformSamples) {
    audioAnalyser.getByteTimeDomainData(waveformSamples);
    drawVoiceWave(waveformSamples);
  } else {
    drawVoiceWave();
  }
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

function showSearchEvidence(webResults = [], sources = []) {
  webAnswer.replaceChildren();
  sourceLinks.replaceChildren();
  const latestResult = webResults[webResults.length - 1];
  if (latestResult?.citation_blocks?.length) {
    for (const block of latestResult.citation_blocks) appendCitedBlock(block);
  } else if (latestResult?.answer) {
    const paragraph = document.createElement('p');
    paragraph.textContent = latestResult.answer;
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
  sourcePanel.hidden =
    webAnswer.childElementCount === 0 && sourceLinks.childElementCount === 0;
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
  };
  audioPlayer.onerror = () => {
    isSpeaking = false;
    stopVoiceWave();
    releaseAudioUrl();
    setOrbState('error', 'Voice playback failed');
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
    showSearchEvidence(webResults, sources);

    // 3. Fetch TTS from Cartesia proxy
    setOrbState('thinking', 'Generating Voice...');
    const ttsRes = await authenticatedFetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: reply })
    });

    if (!ttsRes.ok) throw new Error('TTS API failed');

    // 4. Play audio
    const blob = await ttsRes.blob();
    playAudioBlob(blob);
  } catch (err) {
    console.error(err);
    showSearchEvidence([], []);
    setOrbState('error', 'Error occurred. Tap to retry.');
    isSpeaking = false;
    setTimeout(() => setOrbState('idle', 'Tap to talk to AURA'), 3000);
  }
}
