const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('voice surface shows only the wordmark and an accessible reactive wave', () => {
  assert.match(html, /<canvas id="voice-wave"[^>]+aria-hidden="true"/);
  // The wordmark is deliberately present; the running caption stays screen-reader only.
  assert.match(html, /<h1 id="aura-title">AURA<\/h1>/);
  assert.match(css, /#aura-title\s*\{[^}]*text-shadow:/s);
  assert.match(css, /#status-text\s*\{[^}]*clip-path:\s*inset\(50%\)/s);
});

test('the search-results panel is non-persistent and appears only with content', () => {
  // Deliberately reactivated (was fully display:none, permanently, for a
  // stretch): hidden by default via opacity/pointer-events so it can animate,
  // never display:none (which cannot transition), and made visible only by
  // a .visible class - which app.js adds only when a search actually
  // returned content, and removes on every new turn otherwise.
  const sourcePanelTag = html.match(/<section id="source-panel"[^>]*>/)[0];
  assert.match(sourcePanelTag, /aria-hidden="true"/);
  assert.doesNotMatch(sourcePanelTag, /(?<!aria-)\bhidden\b/);
  assert.match(css, /#source-panel\s*\{[^}]*opacity:\s*0;/s);
  assert.match(css, /#source-panel\s*\{[^}]*pointer-events:\s*none;/s);
  assert.match(css, /#source-panel\.visible\s*\{[^}]*opacity:\s*1;/s);
  assert.match(app, /sourcePanel\.classList\.toggle\('visible',\s*hasContent\)/);
  assert.match(app, /sourcePanel\.setAttribute\('aria-hidden'/);
  // Cleared at the start of every new listen, on error, and now also right
  // when she finishes speaking the whole queued reply (finishVoiceQueue) /
  // is interrupted (stopSpeaking) - so old text doesn't linger on screen
  // until the next interaction starts.
  assert.match(app, /showSearchEvidence\(\[\],\s*\[\]\)/);
  const cancelActiveTurnFn = app.slice(
    app.indexOf('function cancelActiveTurn()'),
    app.indexOf('function cancelActiveTurn()') + 700
  );
  assert.match(cancelActiveTurnFn, /showSearchEvidence\(\[\],\s*\[\]\)/);
  assert.match(cancelActiveTurnFn, /playbackCancelled = true/);
  assert.match(cancelActiveTurnFn, /resetVoiceQueue\(\)/);
  const finishVoiceQueueFn = app.slice(app.indexOf('function finishVoiceQueue()'), app.indexOf('function finishVoiceQueue()') + 400);
  assert.match(finishVoiceQueueFn, /showSearchEvidence\(\[\],\s*\[\]\)/);
  const stopSpeakingFn = app.slice(app.indexOf('function stopSpeaking()'), app.indexOf('function setOrbState'));
  assert.match(stopSpeakingFn, /cancelActiveTurn\(\)/);
});

test('the panel shows receipts only — search evidence or number-heavy replies', () => {
  // Voice stays primary for chit-chat; the side panel is for receipts
  // (live search citations/sources, or replies that look like money/counts).
  assert.match(app, /function showSearchEvidence\(webResults = \[\], sources = \[\], replyText = ''\)/);
  assert.match(app, /function looksLikeReceipt\(/);
  assert.match(app, /else if \(looksLikeReceipt\(replyText\)\)/);
  assert.match(app, /sourceLabel\.textContent = isSearchResult \? 'Live web result' : 'Receipt'/);
  assert.match(app, /LISTEN_ARM_GRACE_MS = 650/);
  assert.match(app, /createAdaptiveVad/);
});

test('the search panel sits right of the wave, never over it, and syncs to speech start', () => {
  // The panel's width is DERIVED from the same formula that sizes #voice-wave
  // (min(82vw, 560px), centered) so the two are mathematically guaranteed not
  // to overlap at any viewport size, rather than relying on "usually enough
  // margin" - assert the derivation is actually present, not just a fixed
  // right-side width that happens to look fine today.
  assert.match(css, /#source-panel\s*\{[^}]*right:/s);
  // Pinned via `left`, not `right` + shrinking width - a width-based approach
  // was tried and failed on narrow viewports (the padding/border floor
  // silently widened the box until it overlapped the wave by ~10px, caught
  // by measuring getBoundingClientRect in a live browser). Anchoring `left`
  // means any floor-driven overflow spills rightward off-screen instead.
  assert.match(css, /#source-panel\s*\{[^}]*left:\s*calc\(50% \+ var\(--wave-width\)\s*\/\s*2/s);
  // Both #voice-wave and #source-panel derive from ONE --wave-width custom
  // property rather than each repeating the min(82vw, 560px) formula
  // separately - shrinking the wave on narrow screens without also moving
  // the panel's copy of the same formula is exactly how the overlap bug
  // happened the first time; a single shared variable makes that class of
  // drift structurally impossible rather than merely fixed once.
  assert.match(css, /--wave-width:\s*min\(82vw,\s*560px\)/);
  assert.match(css, /#voice-wave\s*\{[^}]*width:\s*var\(--wave-width\)/s);
  // Evidence must be shown once the full reply/sources are known (the
  // stream's `done` event), not the moment the first sentence starts
  // playing - sources/evidence aren't fully resolved until the tool loop
  // finishes. Assert it's shown after the streaming read loop and before
  // the queue is told no more sentences are coming (finishVoiceQueue).
  const processAudio = app.slice(app.indexOf('async function processAudio'));
  const streamLoopIndex = processAudio.indexOf('reader.read()');
  const evidenceIndex = processAudio.indexOf('showSearchEvidence(webResults, sources, reply)');
  const finishIndex = processAudio.indexOf('finishVoiceQueue()');
  assert.ok(streamLoopIndex > -1 && evidenceIndex > -1 && finishIndex > -1, 'expected all three to be present');
  assert.ok(evidenceIndex > streamLoopIndex, 'evidence must show after the stream is fully read');
  assert.ok(evidenceIndex < finishIndex, 'evidence must show before the queue is marked finished');
});

test('on a phone the panel docks below the orb/wave instead of beside them', () => {
  // The desktop side-rail is unreadably narrow on a phone - a real
  // breakpoint override, not just a smaller version of the same rail.
  const mobileBlock = css.slice(css.indexOf('@media (max-width: 700px)'));
  assert.match(mobileBlock, /#source-panel\s*\{[^}]*top:\s*auto/s);
  // Lifted above #orb-controls so conversation/volume toggles stay tappable.
  assert.match(mobileBlock, /#source-panel\s*\{[^}]*bottom:\s*max\(72px/s);
  assert.match(mobileBlock, /#source-panel\s*\{[^}]*max-width:\s*none/s);
  assert.match(mobileBlock, /#source-panel\s*\{[^}]*transform:\s*translateY\(/s);
  // Reveal transform on mobile must match the mobile hide transform's axis -
  // sliding in on Y, not the desktop rail's X, or .visible would snap
  // instead of animate on a phone.
  assert.match(mobileBlock, /#source-panel\.visible\s*\{[^}]*transform:\s*translateY\(0\)/s);
});

test('conversation transcript panel stays hidden — voice-first, no leftover text on open', () => {
  const transcriptTag = html.match(/<section id="transcript-panel"[^>]*>/)[0];
  assert.match(transcriptTag, /aria-hidden="true"/);
  assert.match(css, /#transcript-panel\s*\{[^}]*opacity:\s*0;/s);
  assert.match(app, /function hideTranscript\(/);
  assert.match(app, /function refreshTranscript\(/);
  // Must never auto-fetch / auto-show history on idle or boot.
  assert.doesNotMatch(app, /authenticatedFetch\('\/api\/messages\?limit=12'\)/);
  assert.match(app, /never auto-show/i);
  const refreshFn = app.slice(
    app.indexOf('function refreshTranscript()'),
    app.indexOf('function refreshTranscript()') + 200
  );
  assert.match(refreshFn, /hideTranscript\(\)/);
  assert.doesNotMatch(refreshFn, /\.visible/);
});

test('waveform is driven by the actual AURA audio element', () => {
  assert.match(app, /createMediaElementSource\(audioPlayer\)/);
  assert.match(app, /getByteTimeDomainData\(waveformSamples\)/);
  assert.match(app, /audioPlayer\.onplay\s*=\s*startVoiceWave/);
  // Each queued sentence clip listens for its own end via addEventListener
  // (not a single audioPlayer.onended= assignment) - playBlobAndWait needs
  // to add/remove listeners per clip since the same <audio> element is
  // reused sequentially for every sentence in a reply.
  assert.match(app, /addEventListener\('ended',\s*finish\)/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
});

test('wireframe energy-form emerges by state and follows real voice energy', () => {
  assert.match(html, /<canvas id="aura-mesh"[^>]+aria-hidden="true"/);
  assert.match(app, /function drawAuraMesh\(\)/);
  assert.match(app, /Math\.max\(energyFloor, liveEnergy\)/);
  assert.match(app, /function auraMeshPoint\(/);
  assert.match(app, /requestAnimationFrame\(animateAuraMesh\)/);
  for (const state of ['listening', 'thinking', 'speaking', 'error']) {
    assert.match(css, new RegExp(`body\\[data-aura-state="${state}"\\] #aura-mesh`));
  }
  assert.match(css, /#aura-mesh\s*\{[^}]*animation:\s*none !important/s);
  assert.doesNotMatch(css, /@keyframes think-spin/);
  assert.match(app, /function applyLocalAuraPreview\(\)/);
  assert.match(app, /\['localhost', '127\.0\.0\.1', '::1'\]/);
  assert.match(app, /new URLSearchParams\(window\.location\.search\)\.get\('aura_preview'\)/);
});

test('listening mesh follows microphone energy with smoothly layered detail and glow', () => {
  assert.match(app, /let microphoneEnergy = 0/);
  assert.match(app, /function updateMicrophoneEnergy\(rms,/);
  assert.match(app, /function updateMicrophoneEnergyFromSamples\(samples\)/);
  assert.match(app, /state === 'listening' \? microphoneEnergy : waveformEnergy/);
  assert.match(app, /updateMicrophoneEnergy\(rms\)/);
  assert.match(app, /updateMicrophoneEnergyFromSamples\(float32\)/);
  assert.match(app, /latIndex % 2 === 0 \? 1 : detailMix/);
  assert.match(app, /lonIndex % 2 === 0 \? 1 : detailMix/);
  assert.match(app, /--mesh-saturation/);
  assert.match(app, /--mesh-glow/);
  assert.match(css, /body\[data-aura-state="listening"\] #aura-mesh\s*\{[^}]*var\(--mesh-glow/s);
  assert.match(css, /body\[data-aura-state="speaking"\] #aura-mesh\s*\{[^}]*var\(--mesh-glow/s);
});

test('mobile mesh has a bounded render budget and adaptive fallback', () => {
  assert.match(app, /const MOBILE_MESH_PROFILE = Object\.freeze\(\{[^}]*pixelRatio: 1\.5, fps: 30/s);
  assert.match(app, /const MOBILE_MESH_PROFILE = Object\.freeze\(\{[^}]*latitudeLines: 12, longitudeLines: 18/s);
  assert.match(app, /const LOW_MESH_PROFILE = Object\.freeze\(\{[^}]*pixelRatio: 1\.25, fps: 20/s);
  assert.match(app, /lineGlow: false/);
  assert.match(app, /function recordAuraMeshPerformance\(/);
  assert.match(app, /meshSlowFrameScore < 6/);
  assert.match(app, /frameGap >= frameInterval - 1/);
  assert.match(app, /auraMesh\.dataset\.quality = profile\.name/);
  assert.match(app, /localMeshQualityPreview === 'low'/);
  assert.match(app, /localMeshQualityPreview !== 'mobile'/);
  assert.match(css, /#orb\s*\{[^}]*will-change:\s*transform, opacity/s);
});

test('microphone visual energy is throttled and smoothed by elapsed time', () => {
  assert.match(app, /MICROPHONE_VISUAL_INTERVAL_MS = 1000 \/ 30/);
  assert.match(app, /elapsed < MICROPHONE_VISUAL_INTERVAL_MS/);
  assert.match(app, /1 - Math\.exp\(-elapsed \/ timeConstant\)/);
  assert.match(app, /index \+= 4/);
  assert.match(app, /timestamp - lastAnalysisAt < MICROPHONE_VISUAL_INTERVAL_MS/);
  assert.match(app, /microphoneEnergySquareSum = 0/);
  assert.match(app, /microphoneEnergyReadingCount = 0/);
});

test('the wordmark glow tracks the orb state and respects reduced motion', () => {
  assert.match(app, /document\.body\.dataset\.auraState\s*=\s*state/);
  for (const state of ['listening', 'speaking', 'error']) {
    assert.match(css, new RegExp(`body\\[data-aura-state="${state}"\\] #aura-title`));
  }
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*#aura-title/s);
});

test('mobile cache-busting versions the waveform assets together', () => {
  const styleVersion = html.match(/style\.css\?v=([^"']+)/)?.[1];
  const appVersion = html.match(/app\.js\?v=([^"']+)/)?.[1];
  const wakeVersion = html.match(/wake_word\.js\?v=([^"']+)/)?.[1];
  assert.ok(styleVersion);
  assert.equal(appVersion, styleVersion);
  assert.equal(wakeVersion, styleVersion);
});

test('voice path logs wall-clock TTFA marks in the browser console', () => {
  assert.match(app, /\[timing\] TTFA/);
  assert.match(app, /timing\.sttMs/);
  assert.match(app, /timing\.whisperMs/);
  assert.match(app, /\(stt /);
  assert.match(app, /timing\.firstSentenceMs/);
  assert.match(app, /timing\.ttfaMs/);
  assert.match(app, /audioBitsPerSecond:\s*48000/);
});

test('chat routes adaptive reasoning and reports the selected effort', () => {
  assert.match(server, /reasoningEffortForTurn\(text,/);
  assert.match(server, /!usePrimaryModel && modelConfig\.routerModel/);
  assert.match(server, /_reasoningEffort:\s*turnReasoningEffort/);
  assert.match(server, /reasoning_effort:\s*turnReasoningEffort/);
  assert.match(app, /reasoning \$\{event\.brain\.reasoning_effort\}/);
  assert.match(server, /app\.get\('\/api\/agents\/telemetry'/);
  assert.match(server, /response_ready_ms/);
});

test('uncertain durable preferences require a scoped natural confirmation', () => {
  assert.match(server, /classifyMemoryConfirmationReply\(text\)/);
  assert.match(server, /previousAssistant\?\.content[\s\S]*pendingMemoryConfirmation\.question/);
  assert.match(server, /PENDING OWNER MEMORY CONFIRMATION/);
  assert.match(server, /Answer the owner’s current request first/);
  assert.match(server, /memoryContext\.pendingConfirmation/);
});

test('streamed voice uses connected TTS groups instead of resetting every sentence', () => {
  assert.match(app, /function enqueueSpeechAudio/);
  assert.match(server, /createSpeechChunkAccumulator\(emitChunk\)/);
  // Narration emitted before a tool call is held and discarded rather than
  // spoken, so a preamble and the post-tool answer cannot overlap.
  assert.match(server, /const mayCallTools =/);
  assert.match(server, /discarded \$\{heldChunks\.length\} pre-tool-call chunk/);
  assert.match(server, /extractEarlySpeakable/);
  assert.match(server, /await synthesizeSpeechChunk\(text\.trim\(\)\)/);
  assert.doesNotMatch(server, /Promise\.all\(sentences\.map\(synthesizeSpeechChunk\)\)/);
  assert.match(app, /function cancelActiveTurn\(/);
  assert.match(app, /turnAbortController/);
  assert.match(app, /isSpeaking \|\| isProcessing/);
  assert.match(app, /SILENCE_HANGOVER_MS = 700/);
  assert.match(app, /MAX_UTTERANCE_MS = 60000/);
  assert.match(app, /STREAM_MAX_UTTERANCE_MS = 60000/);
  assert.match(app, /NO_SPEECH_IDLE_MS = 8000/);
  assert.match(app, /!heardSpeech && elapsed >= NO_SPEECH_IDLE_MS/);
});

test('tap interrupt copy and hey Aura wake wiring are present', () => {
  assert.match(app, /Speaking\.\.\. tap to interrupt/);
  assert.match(app, /Say hey Aura, or tap/);
  assert.match(app, /function maybeStartWakeListening\(/);
  assert.match(app, /function stopWakeListening\(/);
  assert.match(app, /createWakeWordListener/);
  assert.match(app, /canRunWakeListener/);
  assert.match(html, /wake_word\.js\?v=/);
  // Wake arms on idle after conversation listen times out / reply finishes;
  // listening/speaking stops it.
  assert.match(app, /stopWakeListening\(\)/);
  assert.match(app, /maybeStartWakeListening\(\)/);
});

test('Deepgram streaming listen path is wired', () => {
  assert.match(app, /AudioWorkletNode|aura-pcm-capture/);
  assert.match(app, /function startStreamingListen/);
  assert.match(app, /stt:start/);
  assert.match(app, /stt:audio/);
  assert.match(app, /stt:final/);
  assert.match(app, /sttStreamingEnabled/);
  assert.match(server, /attachDeepgramSttProxy/);
  assert.match(server, /speech_final/);
  assert.match(server, /utterance_end/);
});

test('conversation mode supports voice barge-in with preroll and server cancellation', () => {
  assert.match(app, /BARGE_IN_SUSTAIN_MS = 220/);
  assert.match(app, /BARGE_IN_GAP_TOLERANCE_MS = 120/);
  assert.match(app, /BARGE_IN_PRE_ROLL_SAMPLES = 3200/);
  assert.match(app, /BARGE_IN_CAPTURE_MAX_SAMPLES = 64000/);
  assert.match(app, /function beginBargeInUtterance/);
  assert.match(app, /appendBargeInUtterancePcm/);
  assert.match(app, /async function startBargeInMonitor/);
  assert.match(app, /async function triggerVoiceBargeIn/);
  assert.match(app, /processedMicrophoneConstraints/);
  assert.match(app, /buildProcessedAudioConstraints/);
  assert.match(app, /createAdaptiveVad/);
  assert.match(app, /recordVadDiagnostic\('false_start', 'barge_in'/);
  assert.match(app, /suspected_false_cutoff/);
  assert.match(app, /existingMedia: preservedMedia/);
  assert.match(app, /initialPcmProvider: readInterruption/);
  assert.match(app, /startBargeInMonitor\(\)/);
  assert.match(app, /\/api\/chat\/cancel/);
  assert.match(app, /interrupted_reply/);
  assert.match(server, /app\.post\('\/api\/chat\/cancel'/);
  assert.match(server, /activeChatTurns/);
  assert.match(server, /interruptedContext/);
  assert.match(server, /markConversationMessageCancelled/);
  assert.match(server, /onUserMessagePersisted/);
});

test('server blocks text tool protocol from speech and promotes only safe reads', () => {
  assert.match(server, /recoverTextToolCalls/);
  assert.match(server, /isCapabilityCorrectionToolAllowed/);
  assert.match(server, /blocked unrecovered text tool reply/);
  assert.match(server, /_signal \? \{ signal: _signal \}/);
});

test('every playback path silences the other audio path first', () => {
  // Two independent outputs exist: the <audio> element for whole clips and Web
  // Audio BufferSources for streamed PCM. A proactive alert used to reset the
  // queue without stopping already-scheduled PCM, so the alert and the reply
  // still coming out of the PCM path played at the same time.
  assert.match(app, /function silenceAllPlayback\(\)/);
  assert.match(app, /function playAudioBlob\(blob\) \{\s*\n\s*silenceAllPlayback\(\);/);
  assert.match(app, /stopPcmPlayback\(\);\s*\n\s*audioPlayer\.pause\(\);/);
  // An alert must not start while a turn is still being answered.
  assert.match(app, /if \(isSpeaking \|\| isListening \|\| isProcessing\) return;/);
  // ...and must not silently un-cancel a barge-in the owner just performed.
  assert.match(app, /if \(!turnAbortController && !activeChatTurnId\) playbackCancelled = false;/);
});

test('spoken proactive alerts are mirrored into the conversation', () => {
  // Alerts used to live only in the notifications table, so AURA had no record
  // of having said them and would raise the same thing again minutes later.
  assert.match(server, /addConversationMessage\('assistant', text, \{\s*\n\s*proactive: true/);
  // The confirmation gate must skip them so they cannot shadow her question.
  assert.match(server, /message\.metadata\?\.proactive !== true/);
});

test('memory confirmation is anchored on the candidate id, not its wording', () => {
  assert.match(server, /function memoryConfirmationAskedId\(message\)/);
  assert.match(server, /memory_confirmation_asked: pendingMemoryConfirmation\.id/);
  assert.match(server, /askedId === pendingMemoryConfirmation\.id/);
  // A barge-in never persists the reply, so the candidate's own ask record is
  // the fallback that still lets the owner's "yes" land.
  assert.match(server, /MEMORY_CONFIRMATION_RECENT_ASK_MS/);
  // The owner's verbatim text is what gets stored, never the rewritten form.
  assert.match(server, /addConversationMessage\('user', ownerTextRaw/);
});
