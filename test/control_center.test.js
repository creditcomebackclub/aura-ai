'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'control.html'), 'utf8');
const script = fs.readFileSync(path.join(publicDir, 'control.js'), 'utf8');

test('control center exposes owner review surfaces without changing the voice screen', () => {
  assert.match(html, /<h1>Control Center<\/h1>/);
  assert.match(html, /id="preferences"/);
  assert.match(html, /id="memory-jobs"/);
  assert.match(html, /id="commitments"/);
  assert.match(html, /id="clients"/);
  assert.match(script, /\/api\/reliability\/status/);
  assert.match(script, /\/api\/memory\/candidates\//);
  assert.match(script, /\/api\/memory\/jobs\//);
  assert.match(script, /\/api\/commitments\/review\//);
  assert.doesNotMatch(script, /innerHTML/);
});
