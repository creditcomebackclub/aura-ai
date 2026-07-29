const socket = io({
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

const WAKE_WORD = /\baura\b/i;
const MIN_THRESHOLD = 0.012;         // floor so a silent room doesn't get too twitchy
const THRESHOLD_MULTIPLIER = 2.2;    // speech must clear this multiple of the noise floor
const NOISE_FLOOR_ALPHA = 0.05;      // how fast the noise floor adapts to the room
const SILENCE_HANGOVER_MS = 1100;    // how much trailing silence ends an utterance
const MIN_UTTERANCE_MS = 300;        // discard blips shorter than this
const MAX_UTTERANCE_MS = 15000;      // hard safety cap on a single utterance
const AWAITING_COMMAND_MS = 8000;    // window to answer after just saying "Aura"

let isSpeaking = false;
let isAlwaysOn = false;
let isPaused = false;
let audioUnlocked = false;

let stream = null;
let audioContext = null;
let analyser = null;
let vadInterval = null;
let noiseFloor = 0.005;

let speechActive = false;
let speechStart = null;
let silenceStart = null;
let discardCurrentUtterance = false;

let recorder = null;
let audioChunks = [];
let recorderMimeType = 'audio/webm';

let awaitingCommandUntil = 0;

// State Management
function setOrbState(state, text) {
  orb.className = state;
  statusText.textContent = text;
}

// WebSocket Reconnection Handling
socket.on('connect', () => {
  console.log('Connected to AURA server');
  if (orb.className === 'error') {
    setOrbState(isAlwaysOn && !isPaused ? 'idle' : 'idle', isAlwaysOn ? 'Listening for "Aura"...' : 'Tap to enable AURA');
  }
});

socket.on('disconnect', (reason) => {
  console.log('Disconnected from server:', reason);
  setOrbState('error', 'Connection lost. Reconnecting...');
});

socket.on('connect_error', (err) => {
  console.log('Connection error:', err.message);
  setOrbState('error', 'Connection error...');
});

socket.on('proactive-alert', async (data) => {
  console.log('Proactive alert received:', data.text);
  if (isSpeaking) return;
  await speak(data.text);
});

// Tap to enable always-listening mode, or tap again to mute/unmute it
document.getElementById('orb-container').addEventListener('click', async () => {
  if (!audioUnlocked) {
    audioPlayer.play().catch(() => {});
    audioUnlocked = true;
  }

  if (!isAlwaysOn) {
    await enableAlwaysListening();
  } else {
    isPaused = !isPaused;
    if (isPaused) {
      setOrbState('muted', 'Paused — tap to resume');
    } else {
      setOrbState('idle', 'Listening for "Aura"...');
    }
  }
});

async function enableAlwaysListening() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (err) {
    console.error('Mic error:', err);
    setOrbState('error', 'Microphone blocked');
    setTimeout(() => setOrbState('idle', 'Tap to enable AURA'), 3000);
    return;
  }

  recorderMimeType = 'audio/webm';
  if (!MediaRecorder.isTypeSupported('audio/webm') && MediaRecorder.isTypeSupported('audio/mp4')) {
    recorderMimeType = 'audio/mp4';
  }

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  const micSource = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  micSource.connect(analyser);

  setOrbState('thinking', 'Calibrating to the room...');
  await calibrateNoiseFloor();

  isAlwaysOn = true;
  isPaused = false;
  setOrbState('idle', 'Listening for "Aura"...');

  const dataArray = new Uint8Array(analyser.fftSize);

  vadInterval = setInterval(() => {
    if (isPaused || isSpeaking) return;

    analyser.getByteTimeDomainData(dataArray);
    const rms = computeRMS(dataArray);
    const now = Date.now();
    const threshold = Math.max(noiseFloor * THRESHOLD_MULTIPLIER, MIN_THRESHOLD);

    // Learn the room's noise floor from every sample that isn't part of an
    // active utterance - including ones louder than the current threshold,
    // so a continuously noisy room (fan, traffic) doesn't get stuck being
    // misread as nonstop speech and never adapt.
    if (!speechActive) {
      noiseFloor = noiseFloor * (1 - NOISE_FLOOR_ALPHA) + rms * NOISE_FLOOR_ALPHA;
    }

    if (rms > threshold) {
      silenceStart = null;
      if (!speechActive) {
        speechActive = true;
        speechStart = now;
        startUtteranceRecording();
      } else if (now - speechStart > MAX_UTTERANCE_MS) {
        // Never found silence for a full 15s - almost certainly a noise floor
        // that's out of date (room got louder), not a genuinely long command.
        // Bump the floor to match reality and discard rather than transcribe it.
        noiseFloor = Math.max(noiseFloor, rms * 0.8);
        discardCurrentUtterance = true;
        stopUtteranceRecording();
      }
    } else {
      if (speechActive) {
        if (silenceStart === null) silenceStart = now;
        if (now - silenceStart > SILENCE_HANGOVER_MS) {
          if (now - speechStart > MIN_UTTERANCE_MS) {
            stopUtteranceRecording();
          } else {
            discardCurrentUtterance = true;
            stopUtteranceRecording();
          }
        }
      }
    }
  }, 100);

  // iOS suspends the AudioContext when the tab is backgrounded (screen lock,
  // app switch) - without this, the VAD loop keeps "running" but only ever
  // sees frozen/silent data, so AURA silently stops responding until reload.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && audioContext && audioContext.state === 'suspended') {
      audioContext.resume();
    }
  });
}

function computeRMS(dataArray) {
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const v = (dataArray[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / dataArray.length);
}

// Samples ambient room noise for a moment before listening starts for real,
// so the trigger threshold reflects this room/mic instead of a guessed constant.
async function calibrateNoiseFloor(durationMs = 1200) {
  const dataArray = new Uint8Array(analyser.fftSize);
  const samples = [];
  const steps = Math.max(1, Math.floor(durationMs / 100));

  for (let i = 0; i < steps; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    analyser.getByteTimeDomainData(dataArray);
    samples.push(computeRMS(dataArray));
  }

  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  noiseFloor = Math.min(Math.max(avg, 0.003), 0.05);
}

function startUtteranceRecording() {
  audioChunks = [];
  discardCurrentUtterance = false;
  recorder = new MediaRecorder(stream, { mimeType: recorderMimeType });

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) audioChunks.push(event.data);
  };

  recorder.onstop = async () => {
    speechActive = false;
    silenceStart = null;

    if (discardCurrentUtterance || audioChunks.length === 0) {
      discardCurrentUtterance = false;
      return;
    }

    const blob = new Blob(audioChunks, { type: recorderMimeType });
    await handleUtterance(blob);
  };

  recorder.start();
  setOrbState('listening', Date.now() < awaitingCommandUntil ? 'Listening...' : 'Hmm?');
}

function stopUtteranceRecording() {
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
  }
}

async function handleUtterance(audioBlob) {
  try {
    setOrbState('thinking', 'Transcribing...');

    const formData = new FormData();
    const ext = recorderMimeType.includes('mp4') ? 'm4a' : 'webm';
    formData.append('audio', audioBlob, `recording.${ext}`);

    const transcribeRes = await fetch('/api/transcribe', { method: 'POST', body: formData });
    if (!transcribeRes.ok) throw new Error('Transcription failed');
    const { transcript } = await transcribeRes.json();

    if (!transcript || transcript.trim() === '') {
      resumeAmbientListening();
      return;
    }
    console.log('Heard:', transcript);

    const now = Date.now();
    const hasWakeWord = WAKE_WORD.test(transcript);
    const inCommandWindow = now < awaitingCommandUntil;

    if (!hasWakeWord && !inCommandWindow) {
      // Not addressed to AURA - ignore and keep listening ambiently.
      resumeAmbientListening();
      return;
    }

    let command = transcript;
    if (hasWakeWord) {
      // Drop everything up to and including the wake word (e.g. a leading "Hey"),
      // not just blank out the matched word in place.
      const match = transcript.match(WAKE_WORD);
      command = transcript.slice(match.index + match[0].length).replace(/^[\s,:.!-]+/, '').trim();
    }

    if (!command) {
      // Just the wake word alone ("Aura", "Hey Aura") - prompt and wait for the follow-up.
      awaitingCommandUntil = Date.now() + AWAITING_COMMAND_MS;
      await speak('Yes?');
      resumeAmbientListening();
      return;
    }

    awaitingCommandUntil = 0;
    await sendToAura(command);
  } catch (err) {
    console.error(err);
    setOrbState('error', 'Error occurred.');
    setTimeout(resumeAmbientListening, 3000);
  }
}

async function sendToAura(text) {
  try {
    setOrbState('thinking', 'Thinking...');

    const chatRes = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!chatRes.ok) throw new Error('Chat API failed');
    const { reply } = await chatRes.json();
    console.log('AURA:', reply);

    await speak(reply);
  } catch (err) {
    console.error(err);
    setOrbState('error', 'Error occurred.');
    setTimeout(resumeAmbientListening, 3000);
  }
}

async function speak(text) {
  try {
    setOrbState('thinking', 'Generating voice...');
    const ttsRes = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!ttsRes.ok) throw new Error('TTS API failed');

    const blob = await ttsRes.blob();
    audioPlayer.src = URL.createObjectURL(blob);

    isSpeaking = true;
    setOrbState('speaking', 'Speaking...');

    await new Promise((resolve) => {
      audioPlayer.onended = resolve;
      audioPlayer.play().catch(resolve);
    });
  } catch (err) {
    console.error(err);
  } finally {
    isSpeaking = false;
    resumeAmbientListening();
  }
}

function resumeAmbientListening() {
  if (!isAlwaysOn) {
    setOrbState('idle', 'Tap to enable AURA');
    return;
  }
  if (isPaused) {
    setOrbState('muted', 'Paused — tap to resume');
    return;
  }
  setOrbState('idle', 'Listening for "Aura"...');
}
