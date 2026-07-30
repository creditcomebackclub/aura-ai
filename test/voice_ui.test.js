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
  // when she finishes speaking (onended) / is interrupted (stopSpeaking) -
  // so old text doesn't linger on screen until the next interaction starts.
  assert.match(app, /showSearchEvidence\(\[\],\s*\[\]\)/);
  const onended = app.slice(app.indexOf('audioPlayer.onended = () => {'), app.indexOf('audioPlayer.onerror'));
  assert.match(onended, /showSearchEvidence\(\[\],\s*\[\]\)/);
  const stopSpeakingFn = app.slice(app.indexOf('function stopSpeaking()'), app.indexOf('function releaseAudioUrl'));
  assert.match(stopSpeakingFn, /showSearchEvidence\(\[\],\s*\[\]\)/);
});

test('the panel shows plain reply text on screen when there is no search result', () => {
  // Text-on-screen was an explicit ask, distinct from the search-citations
  // case: every answer should be readable on screen, not only ones that
  // triggered a live web search. Falls back to replyText only when there is
  // no citation block/answer to show, and the label switches accordingly.
  assert.match(app, /function showSearchEvidence\(webResults = \[\], sources = \[\], replyText = ''\)/);
  assert.match(app, /else if \(replyText\.trim\(\)\)/);
  assert.match(app, /sourceLabel\.textContent = isSearchResult \? 'Live web result' : 'AURA said'/);
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
  // Evidence must be shown at the point playback actually begins, not the
  // moment the reply text arrives - otherwise the panel appears during
  // "Generating Voice..." well before she starts talking. Assert the call
  // sits after the TTS fetch resolves and immediately alongside playAudioBlob.
  const processAudio = app.slice(app.indexOf('async function processAudio'));
  const ttsIndex = processAudio.indexOf("await authenticatedFetch('/api/tts'");
  const evidenceIndex = processAudio.indexOf('showSearchEvidence(webResults, sources, reply)');
  const playIndex = processAudio.indexOf('playAudioBlob(blob)');
  assert.ok(ttsIndex > -1 && evidenceIndex > -1 && playIndex > -1, 'expected all three calls to be present');
  assert.ok(evidenceIndex > ttsIndex, 'evidence must show after the TTS fetch, not right after the chat reply');
  assert.ok(evidenceIndex < playIndex, 'evidence must show at/just before playback starts, not after');
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
  assert.match(app, /audioPlayer\.onended\s*=/);
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
