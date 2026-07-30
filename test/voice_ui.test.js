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
  // Cleared at the start of every new listen and on error, not just set once.
  assert.match(app, /showSearchEvidence\(\[\],\s*\[\]\)/);
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
