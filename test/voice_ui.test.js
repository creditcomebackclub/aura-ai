const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

test('voice surface is text-free on mobile and includes an accessible reactive wave', () => {
  assert.match(html, /<canvas id="voice-wave"[^>]+aria-hidden="true"/);
  assert.doesNotMatch(html, /id="aura-title"/);
  assert.match(css, /#status-text\s*\{[^}]*clip-path:\s*inset\(50%\)/s);
  assert.match(css, /#source-panel\s*\{[^}]*display:\s*none/s);
  assert.match(
    css,
    /@media \(min-width:\s*900px\) and \(pointer:\s*fine\)[\s\S]*#source-panel:not\(\[hidden\]\)/
  );
  assert.match(
    css,
    /@media \(display-mode:\s*standalone\) and \(max-width:\s*899px\)/
  );
});

test('waveform is driven by the actual AURA audio element', () => {
  assert.match(app, /createMediaElementSource\(audioPlayer\)/);
  assert.match(app, /getByteTimeDomainData\(waveformSamples\)/);
  assert.match(app, /audioPlayer\.onplay\s*=\s*startVoiceWave/);
  assert.match(app, /audioPlayer\.onended\s*=/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
});

test('mobile cache-busting versions the waveform assets together', () => {
  const styleVersion = html.match(/style\.css\?v=([^"']+)/)?.[1];
  const appVersion = html.match(/app\.js\?v=([^"']+)/)?.[1];
  assert.ok(styleVersion);
  assert.equal(appVersion, styleVersion);
});
