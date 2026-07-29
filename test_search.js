require('dotenv').config();
const { createOpenAIWebSearch } = require('./web_search');

(async () => {
  const search = createOpenAIWebSearch({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_WEB_SEARCH_MODEL || 'gpt-5.4-mini'
  });
  const result = await search.search(
    process.argv.slice(2).join(' ') || 'weather in Sebastian, Florida right now'
  );
  console.log(JSON.stringify(result, null, 2));
})().catch(error => {
  console.error(`${error.code || 'WEB_SEARCH_ERROR'}: ${error.message}`);
  process.exitCode = 1;
});
