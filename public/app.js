const tokenFromUrl = new URLSearchParams(window.location.search).get('token');
if (tokenFromUrl) {
  localStorage.setItem('aura_access_token', tokenFromUrl);
  history.replaceState({}, document.title, window.location.pathname);
}
const authHash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
if (authHash.get('access_token')) {
  localStorage.setItem('aura_session_token', authHash.get('access_token'));
  history.replaceState({}, document.title, window.location.pathname);
}
let auraAccessToken = localStorage.getItem('aura_access_token') || '';
let auraSessionToken = localStorage.getItem('aura_session_token') || '';
let authPromptOpen = false;
let authMode = null;

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
        window.alert('Check your email and open the AURA sign-in link on this device.');
      } else {
        window.alert('AURA could not send the sign-in link. Please try again.');
      }
    }
    authPromptOpen = false;
    return;
  }
  const token = window.prompt('Enter your AURA access token to pair this device:');
  authPromptOpen = false;
  if (token && token.trim()) {
    localStorage.setItem('aura_access_token', token.trim());
    window.location.reload();
  }
}

const authenticatedFetch = async (url, options = {}) => {
  const response = await fetch(url, {
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
  if (response.status === 401 && window.location.hostname !== 'localhost' &&
      window.location.hostname !== '127.0.0.1') {
    localStorage.removeItem('aura_access_token');
    localStorage.removeItem('aura_session_token');
    auraAccessToken = '';
    auraSessionToken = '';
    requestAccessToken();
  }
  return response;
};

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

// Global audio player for iOS Safari unlocking
const audioPlayer = new Audio();

let isListening = false;
let isSpeaking = false;
let audioUnlocked = false;

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

// Cuts AURA off mid-sentence and returns the orb to idle.
function stopSpeaking() {
  playbackCancelled = true;
  audioPlayer.pause();
  audioPlayer.currentTime = 0;
  releaseAudioUrl();
  isSpeaking = false;
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

  audioPlayer.onended = () => {
    isSpeaking = false;
    releaseAudioUrl();
    setOrbState('idle', 'Tap to talk to AURA');
  };

  audioPlayer.play();
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

socket.on('connect_error', (err) => {
  console.log('Connection error:', err.message);
  if (/auth|token|disabled/i.test(err.message)) {
    setOrbState('error', 'Authentication required');
    localStorage.removeItem('aura_access_token');
    localStorage.removeItem('aura_session_token');
    auraAccessToken = '';
    auraSessionToken = '';
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

async function startListening() {
  // Clear any prior interrupt so this new exchange is allowed to speak.
  playbackCancelled = false;
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
    const { reply } = await chatRes.json();
    console.log('AURA:', reply);

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
    setOrbState('error', 'Error occurred. Tap to retry.');
    isSpeaking = false;
    setTimeout(() => setOrbState('idle', 'Tap to talk to AURA'), 3000);
  }
}
