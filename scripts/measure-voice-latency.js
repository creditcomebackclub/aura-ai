#!/usr/bin/env node
// Text-path latency probe: /api/chat first-sentence + /api/tts for that
// sentence. Skips Whisper/mic so it can run headlessly. For full TTFA use
// the browser console `[timing] TTFA …` line after a live voice turn.
//
// Usage:
//   AURA_ACCESS_TOKEN=... node scripts/measure-voice-latency.js
//   AURA_BASE_URL=https://aura-brain-5o61.onrender.com AURA_ACCESS_TOKEN=... \
//     node scripts/measure-voice-latency.js "hey what's up"

const BASE = (process.env.AURA_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const TOKEN = process.env.AURA_ACCESS_TOKEN || '';
const TEXT = process.argv.slice(2).join(' ') || 'Hey, just checking in — how are you?';

async function main() {
  if (!TOKEN) {
    console.error('Set AURA_ACCESS_TOKEN to run this probe.');
    process.exit(1);
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${TOKEN}`,
    'X-Aura-Access-Token': TOKEN
  };

  console.log(`Probe against ${BASE}`);
  console.log(`Prompt: ${TEXT}`);

  const chatStarted = Date.now();
  const chatRes = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: TEXT })
  });
  if (!chatRes.ok) {
    throw new Error(`/api/chat failed: ${chatRes.status} ${await chatRes.text()}`);
  }

  const reader = chatRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let firstSentence = null;
  let firstSentenceMs = null;
  let doneMs = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === 'sentence' && !firstSentence) {
        firstSentence = event.text;
        firstSentenceMs = Date.now() - chatStarted;
        console.log(`[timing] first sentence: ${firstSentenceMs}ms`);
        console.log(`  text: ${firstSentence}`);
      } else if (event.type === 'done') {
        doneMs = Date.now() - chatStarted;
      } else if (event.type === 'error') {
        throw new Error(event.error);
      }
    }
  }

  if (!firstSentence) {
    console.log('[timing] no streamed sentence (tool-heavy or empty reply)');
    console.log(`[timing] chat done: ${doneMs}ms`);
    return;
  }

  const ttsStarted = Date.now();
  const ttsRes = await fetch(`${BASE}/api/tts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: firstSentence })
  });
  if (!ttsRes.ok) {
    throw new Error(`/api/tts failed: ${ttsRes.status} ${await ttsRes.text()}`);
  }
  const blob = Buffer.from(await ttsRes.arrayBuffer());
  const ttsMs = Date.now() - ttsStarted;
  const textPathTtfa = firstSentenceMs + ttsMs;

  console.log(`[timing] tts first sentence: ${ttsMs}ms (${blob.length} bytes)`);
  console.log(`[timing] chat done: ${doneMs}ms`);
  console.log(`[timing] text-path TTFA≈ ${textPathTtfa}ms (first_sentence + tts; excludes whisper + silence hangover)`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
