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
