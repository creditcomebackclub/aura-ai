#!/usr/bin/env node
/**
 * Headless first-turn tool-selection + latency A/B across chat providers.
 *
 * Does NOT spin up AURA or execute tools — it scores whether each model
 * chooses the right tool(s) on the same prompts/tools/system prompt that
 * AURA uses, which is the decision that matters for a brain swap.
 *
 * Usage:
 *   OPENAI_API_KEY=... XAI_API_KEY=... node eval/compare_models.js
 *   node eval/compare_models.js --repeat=2
 *
 * Models default to gpt-5.6-sol (OpenAI) and grok-4.5 (xAI). Override with
 *   AURA_COMPARE_MODELS=gpt-5.6-sol,grok-4.5
 *
 * Keys are read from the environment only — never commit them.
 */
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
const soul = fs.readFileSync(path.join(__dirname, '..', 'SOUL.md'), 'utf8');

const repeatArg = process.argv.find(arg => arg.startsWith('--repeat='));
const repeat = repeatArg ? Math.max(1, parseInt(repeatArg.split('=')[1], 10) || 1) : 1;

// Representative tool surface — same names/descriptions AURA exposes for the
// behaviors these cases exercise. Full server.js tool list isn't importable
// without booting Express.
const tools = [
  {
    type: 'function',
    function: {
      name: 'count_database_rows',
      description: 'Returns the EXACT number of rows matching a filter, without returning the rows. You MUST use this for any "how many" question (e.g. how many active clients) instead of counting rows yourself - counting returned rows gives wrong answers because results can be truncated.',
      parameters: {
        type: 'object',
        properties: {
          table_name: { type: 'string' },
          filters: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                column: { type: 'string' },
                value: { type: 'string' },
                op: { type: 'string' }
              }
            }
          }
        },
        required: ['table_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_client_current_phase',
      description: 'Returns a named client’s current phase from their latest letter, including the source record used as evidence. Prefer this or get_client_snapshot for named-client phase questions.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_client_snapshot',
      description: 'Returns one deterministic client summary including status, billing, current phase, recent letters, and outstanding ledger entries. Prefer this over manually chaining generic table queries for a named client.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_outstanding_balances',
      description: 'Lists every client who still owes money, with the amount and what it is for. ALWAYS use this tool rather than querying the clients table for balances.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Search and browse the live public internet for current information, news, weather, prices, facts, source verification, research, or the contents of a public URL. Never use this tool for private CCC records.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_database_table',
      description: 'Query a CCC database table with optional filters. Do not use this to count rows or read nested ledger balances.',
      parameters: {
        type: 'object',
        properties: {
          table_name: { type: 'string' },
          filters: { type: 'array', items: { type: 'object' } }
        },
        required: ['table_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Immediately emails someone else only when the owner explicitly asks and includes the exact address in the current message.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' }
        },
        required: ['to', 'subject', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_owner_email',
      description: 'Immediately emails the owner at the fixed configured address when explicitly requested.',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          body: { type: 'string' }
        },
        required: ['subject', 'body']
      }
    }
  }
];

const MODEL_PRESETS = {
  'gpt-5.6-sol': {
    label: 'gpt-5.6-sol (current)',
    client: () => {
      if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
      return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    },
    // Match AURA: tools force reasoning_effort none on Sol.
    requestExtras: { reasoning_effort: 'none' }
  },
  'grok-4.5': {
    label: 'grok-4.5 (xAI)',
    client: () => {
      if (!process.env.XAI_API_KEY) throw new Error('XAI_API_KEY is not set');
      return new OpenAI({
        apiKey: process.env.XAI_API_KEY,
        baseURL: 'https://api.x.ai/v1'
      });
    },
    requestExtras: {}
  }
};

function inputForAttempt(testCase, attempt) {
  const variants = testCase.variants?.length ? testCase.variants : [testCase.input];
  return variants[attempt % variants.length];
}

function scoreAttempt(testCase, message) {
  const usedTools = (message.tool_calls || [])
    .map(call => call.function?.name)
    .filter(Boolean);
  const usedSet = new Set(usedTools);
  const failures = [];
  const reply = message.content || '';

  for (const tool of testCase.expectedTools || []) {
    if (!usedSet.has(tool)) failures.push(`missing required tool ${tool}`);
  }
  if (testCase.expectedAnyTool?.length &&
      !testCase.expectedAnyTool.some(tool => usedSet.has(tool))) {
    failures.push(`missing one of: ${testCase.expectedAnyTool.join(', ')}`);
  }
  for (const tool of testCase.forbiddenTools || []) {
    if (usedSet.has(tool)) failures.push(`forbidden tool called: ${tool}`);
  }
  for (const text of testCase.forbiddenReply || []) {
    if (reply.toLowerCase().includes(text.toLowerCase())) {
      failures.push(`reply included forbidden text "${text}"`);
    }
  }
  // requireSources needs a live search execution — out of scope here.
  return { passed: failures.length === 0, failures, usedTools, reply };
}

async function runOne(preset, modelId, testCase, input) {
  const client = preset.client();
  const started = Date.now();
  const response = await client.chat.completions.create({
    model: modelId,
    messages: [
      { role: 'system', content: soul },
      { role: 'user', content: input }
    ],
    tools,
    tool_choice: 'auto',
    ...preset.requestExtras
  });
  const latencyMs = Date.now() - started;
  const message = response.choices[0]?.message || {};
  const scored = scoreAttempt(testCase, message);
  return {
    ...scored,
    latencyMs,
    usage: response.usage || null,
    model: response.model || modelId
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarize(attempts) {
  const latencies = attempts.map(a => a.latencyMs).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  const passed = attempts.filter(a => a.passed).length;
  return {
    passed,
    total: attempts.length,
    passRate: attempts.length ? passed / attempts.length : 0,
    latency: {
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      mean: latencies.length
        ? Math.round(latencies.reduce((sum, n) => sum + n, 0) / latencies.length)
        : null
    }
  };
}

(async () => {
  const requested = (process.env.AURA_COMPARE_MODELS || 'gpt-5.6-sol,grok-4.5')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const models = [];
  for (const modelId of requested) {
    const preset = MODEL_PRESETS[modelId];
    if (!preset) {
      console.error(`Unknown model preset: ${modelId}`);
      process.exitCode = 1;
      return;
    }
    try {
      preset.client();
      models.push({ modelId, preset });
    } catch (error) {
      console.error(`SKIP ${preset.label}: ${error.message}`);
    }
  }

  if (!models.length) {
    console.error('No models available. Set OPENAI_API_KEY and/or XAI_API_KEY.');
    process.exitCode = 1;
    return;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    repeat,
    note: 'First-turn tool selection only; tools are not executed. requireSources cases score tool choice + forbidden text only.',
    models: {}
  };

  for (const { modelId, preset } of models) {
    console.log(`\n=== ${preset.label} ===`);
    const byCase = [];
    for (const testCase of cases) {
      const attempts = [];
      for (let attempt = 0; attempt < repeat; attempt++) {
        const input = inputForAttempt(testCase, attempt);
        try {
          const result = await runOne(preset, modelId, testCase, input);
          attempts.push(result);
          const mark = result.passed ? 'PASS' : 'FAIL';
          console.log(
            `  ${mark} ${testCase.name} [${attempt + 1}/${repeat}] ${result.latencyMs}ms tools=[${result.usedTools.join(', ') || 'none'}]`
          );
          if (!result.passed) console.log(`       ${result.failures.join('; ')}`);
        } catch (error) {
          attempts.push({
            passed: false,
            failures: [error.message],
            usedTools: [],
            reply: '',
            latencyMs: null,
            usage: null
          });
          console.log(`  FAIL ${testCase.name} [${attempt + 1}/${repeat}] ${error.message}`);
        }
      }
      byCase.push({ name: testCase.name, attempts, summary: summarize(attempts) });
    }
    const flat = byCase.flatMap(item => item.attempts);
    report.models[modelId] = {
      label: preset.label,
      overall: summarize(flat),
      cases: byCase.map(item => ({
        name: item.name,
        ...item.summary,
        attempts: item.attempts.map(attempt => ({
          passed: attempt.passed,
          failures: attempt.failures,
          usedTools: attempt.usedTools,
          latencyMs: attempt.latencyMs,
          usage: attempt.usage
        }))
      }))
    };
  }

  const outPath = path.join(__dirname, 'compare-results.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);

  console.log('\n=== SUMMARY ===');
  for (const [modelId, data] of Object.entries(report.models)) {
    const { passed, total, passRate, latency } = data.overall;
    console.log(
      `${data.label}: ${(passRate * 100).toFixed(0)}% pass (${passed}/${total}), ` +
      `latency mean ${latency.mean ?? 'n/a'}ms p50 ${latency.p50 ?? 'n/a'}ms p90 ${latency.p90 ?? 'n/a'}ms`
    );
  }

  const rates = Object.values(report.models).map(m => m.overall.passRate);
  if (rates.some(rate => rate < 1)) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
