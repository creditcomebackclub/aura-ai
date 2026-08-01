const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WebSearchError,
  createDailyWebSearchLimiter,
  createOpenAIWebSearch,
  dateInTimeZone,
  extractCitationBlocks,
  extractWebSearchMetadata
} = require('../web_search');

function successfulResponse() {
  return {
    status: 'completed',
    incomplete_details: null,
    output_text: 'Sebastian, Florida is currently warm with scattered clouds.',
    output: [
      {
        type: 'web_search_call',
        status: 'completed',
        action: {
          type: 'search',
          query: 'Sebastian Florida weather right now',
          sources: [
            { title: 'National Weather Service', url: 'https://www.weather.gov/' },
            { title: 'Duplicate NWS result', url: 'https://www.weather.gov/' }
          ]
        }
      },
      {
        type: 'message',
        status: 'completed',
        content: [{
          type: 'output_text',
          text: 'Sebastian, Florida is currently warm with scattered clouds.',
          annotations: [{
            type: 'url_citation',
            start_index: 0,
            end_index: 9,
            title: 'Current conditions',
            url: 'https://forecast.weather.gov/'
          }]
        }]
      }
    ]
  };
}

test('web search forces live Responses search and returns deduplicated sources', async () => {
  let requestBody;
  let requestOptions;
  const client = {
    responses: {
      create: async (body, options) => {
        requestBody = body;
        requestOptions = options;
        return successfulResponse();
      }
    }
  };
  const search = createOpenAIWebSearch({
    client,
    model: 'test-search-model',
    contextSize: 'high',
    timeoutMs: 1000,
    now: () => new Date('2026-07-29T09:00:00Z')
  });

  const result = await search.search('weather in Sebastian, Florida');

  assert.equal(requestBody.model, 'test-search-model');
  assert.equal(requestBody.tools[0].type, 'web_search');
  assert.equal(requestBody.tools[0].external_web_access, true);
  assert.equal(requestBody.tools[0].search_context_size, 'high');
  assert.equal(requestBody.tool_choice, 'required');
  assert.deepEqual(requestBody.include, ['web_search_call.action.sources']);
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.max_tool_calls, 3);
  assert.equal(requestBody.input, 'weather in Sebastian, Florida');
  assert.equal(requestOptions.signal instanceof AbortSignal, true);

  assert.equal(result.answer, successfulResponse().output_text);
  assert.equal(result.citation_blocks.length, 1);
  assert.equal(result.citation_blocks[0].citations.length, 1);
  assert.equal(result.sources.length, 2);
  assert.deepEqual(result.sources.map(source => source.url), [
    'https://www.weather.gov/',
    'https://forecast.weather.gov/'
  ]);
  assert.deepEqual(result.searches, ['Sebastian Florida weather right now']);
  assert.equal(result.searched_at, '2026-07-29T09:00:00.000Z');
});

test('web search metadata ignores malformed and unsafe source URLs', () => {
  const response = successfulResponse();
  response.output[0].action.sources.push(
    { title: 'Unsafe', url: 'javascript:alert(1)' },
    { title: 'Malformed', url: 'not a url' }
  );

  const metadata = extractWebSearchMetadata(response);
  assert.equal(metadata.completedSearches, 1);
  assert.equal(metadata.sources.length, 2);
});

test('citation blocks preserve safe inline source positions', () => {
  const blocks = extractCitationBlocks(successfulResponse());
  assert.deepEqual(blocks[0].citations[0], {
    start_index: 0,
    end_index: 9,
    title: 'Current conditions',
    url: 'https://forecast.weather.gov/'
  });
});

test('web search fails closed when no OpenAI key or client is configured', async () => {
  const search = createOpenAIWebSearch({ apiKey: '' });
  await assert.rejects(
    () => search.search('latest news'),
    error => error instanceof WebSearchError &&
      error.code === 'WEB_SEARCH_NOT_CONFIGURED'
  );
});

test('web search rejects malformed provider responses', async () => {
  const missingSearch = createOpenAIWebSearch({
    client: {
      responses: {
        create: async () => ({
          status: 'completed',
          incomplete_details: null,
          output_text: 'An uncited guess',
          output: []
        })
      }
    }
  });
  await assert.rejects(
    () => missingSearch.search('latest news'),
    error => error.code === 'WEB_SEARCH_NOT_PERFORMED'
  );

  const emptyAnswer = createOpenAIWebSearch({
    client: {
      responses: {
        create: async () => ({
          status: 'completed',
          output_text: '',
          output: [{ type: 'web_search_call', status: 'completed', action: {} }]
        })
      }
    }
  });
  await assert.rejects(
    () => emptyAnswer.search('latest news'),
    error => error.code === 'WEB_SEARCH_EMPTY_RESPONSE'
  );
});

test('web search rejects incomplete or truncated Responses results', async () => {
  const response = successfulResponse();
  response.status = 'incomplete';
  response.incomplete_details = { reason: 'max_output_tokens' };
  const search = createOpenAIWebSearch({
    client: { responses: { create: async () => response } }
  });

  await assert.rejects(
    () => search.search('latest news'),
    error => error.code === 'WEB_SEARCH_INCOMPLETE_RESPONSE'
  );
});

test('web search returns a safe provider error without leaking upstream details', async () => {
  const search = createOpenAIWebSearch({
    client: {
      responses: {
        create: async () => {
          throw new Error('secret upstream diagnostic');
        }
      }
    }
  });

  await assert.rejects(
    () => search.search('latest news'),
    error => error.code === 'WEB_SEARCH_PROVIDER_ERROR' &&
      !error.message.includes('secret upstream diagnostic')
  );
});

test('web search enforces its timeout', async () => {
  const search = createOpenAIWebSearch({
    client: {
      responses: {
        create: async () => new Promise(() => {})
      }
    },
    timeoutMs: 100
  });

  await assert.rejects(
    () => search.search('latest news'),
    error => error.code === 'WEB_SEARCH_TIMEOUT'
  );
});

test('daily web search limiter persists counts and resets in its configured timezone', async () => {
  let currentTime = new Date('2026-07-30T06:59:00Z');
  let savedState = null;
  const limiter = createDailyWebSearchLimiter({
    getState: async () => savedState,
    setState: async (_key, value) => { savedState = value; },
    limit: 2,
    timeZone: 'America/Phoenix',
    now: () => currentTime
  });

  assert.equal(dateInTimeZone(currentTime, 'America/Phoenix'), '2026-07-29');
  assert.equal((await limiter.consume()).count, 1);
  assert.equal((await limiter.consume()).count, 2);
  await assert.rejects(
    () => limiter.consume(),
    error => error.code === 'WEB_SEARCH_DAILY_LIMIT'
  );

  currentTime = new Date('2026-07-30T07:01:00Z');
  assert.equal((await limiter.consume()).count, 1);
  assert.equal(savedState.date, '2026-07-30');
});

test('daily web search limiter serializes concurrent usage checks', async () => {
  let savedState = null;
  const limiter = createDailyWebSearchLimiter({
    getState: async () => savedState,
    setState: async (_key, value) => { savedState = value; },
    limit: 2,
    now: () => new Date('2026-07-29T12:00:00Z')
  });

  const results = await Promise.all([limiter.consume(), limiter.consume()]);
  assert.deepEqual(results.map(result => result.count), [1, 2]);
  await assert.rejects(
    () => limiter.consume(),
    error => error.code === 'WEB_SEARCH_DAILY_LIMIT'
  );
});

function slowLimiter({ limit = 10, savedState = null } = {}) {
  const state = { value: savedState };
  const limiter = createDailyWebSearchLimiter({
    getState: async () => {
      // Yield between read and write so an unserialized implementation
      // would lose increments.
      await new Promise(resolve => setImmediate(resolve));
      return state.value;
    },
    setState: async (_key, value) => { state.value = value; },
    limit,
    now: () => new Date('2026-07-29T12:00:00Z')
  });
  return { limiter, state };
}

test('daily web search limiter charges the real number of provider searches', async () => {
  const { limiter, state } = slowLimiter({ limit: 5 });

  assert.equal((await limiter.consume(3)).count, 3);
  // A reservation is allowed whenever budget remains, even when the units
  // it charges overshoot the limit - the count has to match what was billed.
  assert.equal((await limiter.consume(3)).count, 6);
  await assert.rejects(
    () => limiter.consume(),
    error => error.code === 'WEB_SEARCH_DAILY_LIMIT'
  );
  assert.equal(state.value.count, 6);
});

test('daily web search limiter settles reservations up and down', async () => {
  const { limiter, state } = slowLimiter({ limit: 10 });

  await limiter.consume();
  // One search_web that made OpenAI run three searches.
  assert.equal((await limiter.settle(2)).count, 3);
  // A search that failed before billing anything.
  await limiter.consume();
  assert.equal((await limiter.settle(-1)).count, 3);
  assert.equal(state.value.count, 3);
});

test('daily web search limiter never refunds below zero', async () => {
  const { limiter } = slowLimiter({ limit: 10 });

  assert.equal((await limiter.settle(-5)).count, 0);
  assert.equal((await limiter.consume()).count, 1);
});

test('daily web search refunds do not credit the day after a timezone reset', async () => {
  let currentTime = new Date('2026-07-30T06:59:00Z');
  let savedState = null;
  const limiter = createDailyWebSearchLimiter({
    getState: async () => savedState,
    setState: async (_key, value) => { savedState = value; },
    limit: 5,
    timeZone: 'America/Phoenix',
    now: () => currentTime
  });

  await limiter.consume();
  assert.equal(savedState.date, '2026-07-29');

  // The search was reserved yesterday and failed after midnight in Phoenix.
  currentTime = new Date('2026-07-30T07:01:00Z');
  const refunded = await limiter.settle(-1);
  assert.equal(refunded.date, '2026-07-30');
  assert.equal(refunded.count, 0);
  assert.equal((await limiter.consume()).count, 1);
});

test('daily web search limiter serializes settlements against concurrent reservations', async () => {
  const { limiter, state } = slowLimiter({ limit: 10 });

  const results = await Promise.all([
    limiter.consume(),
    limiter.settle(-1),
    limiter.consume(),
    limiter.settle(2)
  ]);

  assert.deepEqual(results.map(result => result.count), [1, 0, 1, 3]);
  assert.equal(state.value.count, 3);
});

test('daily web search limiter CAS path retries lost cross-process updates', async () => {
  let value = null;
  let token = null;
  let writes = 0;
  const limiter = createDailyWebSearchLimiter({
    getState: async () => value,
    setState: async (_key, next) => { value = next; },
    readUsage: async () => ({ value, token }),
    tryWriteUsage: async (_key, expectedToken, next) => {
      writes += 1;
      // First write loses to a simulated concurrent process, then succeeds.
      if (writes === 1) {
        token = 'other-process';
        value = { date: '2026-07-29', count: 1, limit: 5, updated_at: 'other' };
        return false;
      }
      if (expectedToken !== token) return false;
      value = next;
      token = `t${writes}`;
      return true;
    },
    limit: 5,
    now: () => new Date('2026-07-29T12:00:00Z')
  });

  const usage = await limiter.consume();
  assert.equal(usage.count, 2);
  assert.equal(value.count, 2);
  assert.ok(writes >= 2);
});

test('daily web search limiter CAS path enforces the daily limit across contending writers', async () => {
  let value = { date: '2026-07-29', count: 4, limit: 5, updated_at: 't0' };
  let token = 't0';
  const limiter = createDailyWebSearchLimiter({
    getState: async () => value,
    setState: async (_key, next) => { value = next; },
    readUsage: async () => ({ value, token }),
    tryWriteUsage: async (_key, expectedToken, next) => {
      if (expectedToken !== token) return false;
      value = next;
      token = next.updated_at;
      return true;
    },
    limit: 5,
    now: () => new Date('2026-07-29T12:00:00Z')
  });

  assert.equal((await limiter.consume()).count, 5);
  await assert.rejects(
    () => limiter.consume(),
    error => error.code === 'WEB_SEARCH_DAILY_LIMIT'
  );
});

test('web search reports how many billable provider searches it ran', async () => {
  const response = successfulResponse();
  response.output.unshift({
    type: 'web_search_call',
    status: 'completed',
    action: { type: 'search', query: 'Sebastian Florida forecast' }
  });
  // An incomplete call still cost a billable web_search invocation.
  response.output.unshift({ type: 'web_search_call', status: 'incomplete', action: {} });

  const search = createOpenAIWebSearch({
    client: { responses: { create: async () => response } }
  });

  const result = await search.search('weather in Sebastian, Florida');
  assert.equal(result.billable_searches, 3);
  assert.equal(extractWebSearchMetadata(response).completedSearches, 2);
});

test('web search failures report what they billed so the reservation can settle', async () => {
  async function billingFor(client) {
    const search = createOpenAIWebSearch({ client, timeoutMs: 100 });
    try {
      await search.search('latest news');
      throw new Error('expected the search to reject');
    } catch (error) {
      return { code: error.code, billableSearches: error.billableSearches };
    }
  }

  // Nothing reached the provider: fully refundable.
  assert.deepEqual(
    await billingFor({ responses: { create: async () => { throw new Error('429'); } } }),
    { code: 'WEB_SEARCH_PROVIDER_ERROR', billableSearches: 0 }
  );
  assert.deepEqual(
    await billingFor({
      responses: {
        create: async () => ({ status: 'completed', output_text: 'guess', output: [] })
      }
    }),
    { code: 'WEB_SEARCH_NOT_PERFORMED', billableSearches: 0 }
  );

  // The provider searched before the response turned out to be unusable.
  assert.deepEqual(
    await billingFor({
      responses: {
        create: async () => ({
          status: 'completed',
          output_text: '',
          output: [{ type: 'web_search_call', status: 'completed', action: {} }]
        })
      }
    }),
    { code: 'WEB_SEARCH_EMPTY_RESPONSE', billableSearches: 1 }
  );

  const incomplete = successfulResponse();
  incomplete.status = 'incomplete';
  incomplete.incomplete_details = { reason: 'max_output_tokens' };
  incomplete.output.unshift({
    type: 'web_search_call',
    status: 'completed',
    action: { type: 'search', query: 'second search' }
  });
  assert.deepEqual(
    await billingFor({ responses: { create: async () => incomplete } }),
    { code: 'WEB_SEARCH_INCOMPLETE_RESPONSE', billableSearches: 2 }
  );

  // A timeout aborts without ever seeing the response, so the cost is
  // unknown rather than zero and the reserved unit has to stand.
  assert.deepEqual(
    await billingFor({ responses: { create: async () => new Promise(() => {}) } }),
    { code: 'WEB_SEARCH_TIMEOUT', billableSearches: null }
  );

  const unconfigured = createOpenAIWebSearch({ apiKey: '' });
  await assert.rejects(
    () => unconfigured.search('latest news'),
    error => error.code === 'WEB_SEARCH_NOT_CONFIGURED' && error.billableSearches === 0
  );
});
