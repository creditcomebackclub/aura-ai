const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

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
  const finishVoiceQueueFn = app.slice(app.indexOf('function finishVoiceQueue()'), app.indexOf('function finishVoiceQueue()') + 400);
  assert.match(finishVoiceQueueFn, /showSearchEvidence\(\[\],\s*\[\]\)/);
  const stopSpeakingFn = app.slice(app.indexOf('function stopSpeaking()'), app.indexOf('function releaseAudioUrl'));
  assert.match(stopSpeakingFn, /showSearchEvidence\(\[\],\s*\[\]\)/);
});

test('the panel shows receipts only — search evidence or number-heavy replies', () => {
  // Voice stays primary for chit-chat; the side panel is for receipts
  // (live search citations/sources, or replies that look like money/counts).
  assert.match(app, /function showSearchEvidence\(webResults = \[\], sources = \[\], replyText = ''\)/);
  assert.match(app, /function looksLikeReceipt\(/);
  assert.match(app, /else if \(looksLikeReceipt\(replyText\)\)/);
  assert.match(app, /sourceLabel\.textContent = isSearchResult \? 'Live web result' : 'Receipt'/);
  assert.match(app, /LISTEN_ARM_GRACE_MS/);
  assert.match(app, /elapsed >= LISTEN_ARM_GRACE_MS/);
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
  const mobileBlock = css.slice(css.indexOf('@media (max-width: 700px) {\n  #source-panel'));
  assert.match(mobileBlock, /#source-panel\s*\{[^}]*top:\s*auto/s);
  assert.match(mobileBlock, /#source-panel\s*\{[^}]*bottom:/s);
  assert.match(mobileBlock, /#source-panel\s*\{[^}]*max-width:\s*none/s);
  assert.match(mobileBlock, /#source-panel\s*\{[^}]*transform:\s*translateY\(/s);
  // Reveal transform on mobile must match the mobile hide transform's axis -
  // sliding in on Y, not the desktop rail's X, or .visible would snap
  // instead of animate on a phone.
  assert.match(mobileBlock, /#source-panel\.visible\s*\{[^}]*transform:\s*translateY\(0\)/s);
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
  assert.ok(styleVersion);
  assert.equal(appVersion, styleVersion);
});

test('voice path logs wall-clock TTFA marks in the browser console', () => {
  assert.match(app, /\[timing\] TTFA/);
  assert.match(app, /timing\.whisperMs/);
  assert.match(app, /timing\.firstSentenceMs/);
  assert.match(app, /timing\.ttfaMs/);
  assert.match(app, /audioBitsPerSecond:\s*48000/);
});
