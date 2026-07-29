const fs = require('fs');
const path = require('path');

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
const baseUrl = process.env.AURA_BASE_URL || 'http://localhost:3000';
const token = process.env.AURA_ACCESS_TOKEN || '';

async function runCase(testCase) {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-AURA-Token': token } : {})
    },
    body: JSON.stringify({ text: testCase.input })
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  const body = await response.json();
  const usedTools = new Set((body.evidence || []).filter(item => item.ok).map(item => item.tool));
  const failures = [];

  for (const tool of testCase.expectedTools || []) {
    if (!usedTools.has(tool)) failures.push(`missing required tool ${tool}`);
  }
  if (testCase.expectedAnyTool?.length &&
      !testCase.expectedAnyTool.some(tool => usedTools.has(tool))) {
    failures.push(`missing one of: ${testCase.expectedAnyTool.join(', ')}`);
  }
  for (const text of testCase.forbiddenReply || []) {
    if (body.reply.toLowerCase().includes(text.toLowerCase())) {
      failures.push(`reply included forbidden text "${text}"`);
    }
  }
  return { name: testCase.name, passed: failures.length === 0, failures, usedTools: [...usedTools], reply: body.reply };
}

(async () => {
  const results = [];
  for (const testCase of cases) {
    try {
      results.push(await runCase(testCase));
    } catch (error) {
      results.push({ name: testCase.name, passed: false, failures: [error.message] });
    }
  }

  for (const result of results) {
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}`);
    if (!result.passed) console.log(`  ${result.failures.join('; ')}`);
    if (result.usedTools) console.log(`  tools: ${result.usedTools.join(', ') || 'none'}`);
  }

  const passed = results.filter(result => result.passed).length;
  console.log(`\n${passed}/${results.length} evaluations passed`);
  if (passed !== results.length) process.exitCode = 1;
})();
