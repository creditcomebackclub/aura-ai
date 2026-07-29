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

let isListening = false;
let isSpeaking = false;
let audioUnlocked = false;

let mediaRecorder = null;
let audioChunks = [];

// State Management
function setOrbState(state, text) {
  orb.className = state;
  statusText.textContent = text;
}

// WebSocket Reconnection Handling
socket.on('connect', () => {
  console.log('Connected to AURA server');
  if (orb.className === 'error' || statusText.textContent.includes('Reconnecting')) {
    setOrbState('idle', 'Tap to wake AURA');
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
  setOrbState('thinking', 'AURA is notifying you...');
  try {
    const ttsRes = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: data.text })
    });
    if (!ttsRes.ok) throw new Error('TTS API failed');
    const blob = await ttsRes.blob();
    audioPlayer.src = URL.createObjectURL(blob);
    setOrbState('speaking', 'Speaking...');
    isSpeaking = true;
    audioPlayer.onended = () => { isSpeaking = false; setOrbState('idle', 'Tap to wake AURA'); };
    audioPlayer.play();
  } catch (err) { console.error(err); setOrbState('idle', 'Tap to wake AURA'); }
});


// Interaction & Microphone Permission Handling
document.getElementById('orb-container').addEventListener('click', async () => {
  if (!audioUnlocked) {
    audioPlayer.play().catch(() => {});
    audioUnlocked = true;
  }
  
  if (isSpeaking) return;

  if (isListening) {
    // Tap to STOP listening
    stopListening();
  } else {
    // Tap to START listening
    await startListening();
  }
});

async function startListening() {
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
        setOrbState('idle', 'Tap to wake AURA');
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
    setTimeout(() => setOrbState('idle', 'Tap to wake AURA'), 3000);
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
    
    const transcribeRes = await fetch('/api/transcribe', {
      method: 'POST',
      body: formData
    });
    
    if (!transcribeRes.ok) throw new Error('Transcription failed');
    const { transcript } = await transcribeRes.json();
    console.log('User:', transcript);
    
    if (!transcript || transcript.trim() === '') {
      setOrbState('idle', 'Tap to wake AURA');
      return;
    }

    setOrbState('thinking', 'Thinking...');
    
    // 2. Send text to DeepSeek/OpenAI backend
    const chatRes = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: transcript })
    });
    
    if (!chatRes.ok) throw new Error('Chat API failed');
    const { reply } = await chatRes.json();
    console.log('AURA:', reply);
    
    // 3. Fetch TTS from Cartesia proxy
    setOrbState('thinking', 'Generating Voice...');
    const ttsRes = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: reply })
    });
    
    if (!ttsRes.ok) throw new Error('TTS API failed');
    
    // 4. Play audio
    const blob = await ttsRes.blob();
    const url = URL.createObjectURL(blob);
    audioPlayer.src = url;
    
    setOrbState('speaking', 'Speaking...');
    isSpeaking = true;
    
    audioPlayer.onended = () => {
      isSpeaking = false;
      setOrbState('idle', 'Tap to wake AURA');
    };
    
    audioPlayer.play();
  } catch (err) {
    console.error(err);
    setOrbState('error', 'Error occurred. Tap to retry.');
    isSpeaking = false;
    setTimeout(() => setOrbState('idle', 'Tap to wake AURA'), 3000);
  }
}
