const fs = require('fs');
const path = require('path');

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
const baseUrl = process.env.AURA_BASE_URL || 'http://localhost:3000';
const token = process.env.AURA_ACCESS_TOKEN || '';

// --repeat=N reruns every case N times to check reliability. AURA has no
// per-request conversation isolation - every call lands in the same shared
// history - so resending the exact same string N times in a row teaches the
// model "I already answered this" and it starts skipping the tool, which
// looks like flakiness but is really eval self-pollution. Cycling through
// each case's `variants` (paraphrases of the same intent) avoids that while
// still testing the same tool-selection behavior N times.
const repeatArg = process.argv.find(arg => arg.startsWith('--repeat='));
const repeat = repeatArg ? Math.max(1, parseInt(repeatArg.split('=')[1], 10) || 1) : 1;

function inputForAttempt(testCase, attempt) {
  const variants = testCase.variants?.length ? testCase.variants : [testCase.input];
  return variants[attempt % variants.length];
}

async function runCase(testCase, input) {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-AURA-Token': token } : {})
    },
    body: JSON.stringify({ text: input, eval: true })
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  const raw = await response.text();
  const lines = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const done = lines.find(line => line.type === 'done');
  if (!done) throw new Error('no "done" line in NDJSON response');
  const { type, ...body } = done;
  const usedTools = new Set((body.evidence || []).filter(item => item.ok).map(item => item.tool));
  const failures = [];

  for (const tool of testCase.expectedTools || []) {
    if (!usedTools.has(tool)) failures.push(`missing required tool ${tool}`);
  }
  if (testCase.expectedAnyTool?.length &&
      !testCase.expectedAnyTool.some(tool => usedTools.has(tool))) {
    failures.push(`missing one of: ${testCase.expectedAnyTool.join(', ')}`);
  }
  if (testCase.requireSources && !(body.sources || []).length) {
    failures.push('search returned no source links');
  }
  for (const text of testCase.forbiddenReply || []) {
    if (body.reply.toLowerCase().includes(text.toLowerCase())) {
      failures.push(`reply included forbidden text "${text}"`);
    }
  }
  for (const tool of testCase.forbiddenTools || []) {
    if (usedTools.has(tool)) failures.push(`forbidden tool called: ${tool}`);
  }
  return { name: testCase.name, passed: failures.length === 0, failures, usedTools: [...usedTools], reply: body.reply };
}

(async () => {
  const results = [];
  for (const testCase of cases) {
    const attempts = [];
    for (let attempt = 0; attempt < repeat; attempt++) {
      const input = inputForAttempt(testCase, attempt);
      try {
        attempts.push(await runCase(testCase, input));
      } catch (error) {
        attempts.push({ name: testCase.name, passed: false, failures: [error.message] });
      }
    }
    results.push({ name: testCase.name, attempts });
  }

  for (const { name, attempts } of results) {
    const passedCount = attempts.filter(attempt => attempt.passed).length;
    const summary = repeat > 1 ? `${passedCount}/${repeat}` : (attempts[0].passed ? 'PASS' : 'FAIL');
    console.log(`${passedCount === attempts.length ? 'PASS' : 'FAIL'} ${name}${repeat > 1 ? ` (${summary})` : ''}`);
    attempts.forEach((attempt, index) => {
      if (!attempt.passed) console.log(`  [${index + 1}] ${attempt.failures.join('; ')}`);
      if (repeat > 1 || !attempt.passed) console.log(`  [${index + 1}] tools: ${attempt.usedTools?.join(', ') || 'none'}`);
    });
  }

  const totalAttempts = results.reduce((sum, r) => sum + r.attempts.length, 0);
  const passedAttempts = results.reduce((sum, r) => sum + r.attempts.filter(a => a.passed).length, 0);
  console.log(`\n${passedAttempts}/${totalAttempts} evaluations passed`);
  if (passedAttempts !== totalAttempts) process.exitCode = 1;
})();
