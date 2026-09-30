'use strict';

// Explicitly online authoring step. `run.js` never imports this module and
// reads only the committed cache, so benchmark/CI runs stay offline.
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const ROOT = __dirname;
const MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const read = name => JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required to create eval/retrieval/embeddings.json. The offline benchmark only reads the committed cache.');
  }
  const corpus = read('corpus.json');
  const queries = read('queries.json');
  const inputs = [
    ...corpus.map(item => ({ collection: 'corpus', id: item.id, text: item.content })),
    ...queries.map(item => ({ collection: 'queries', id: item.id, text: item.query }))
  ];
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const cache = { model: MODEL, dimensions: DIMENSIONS, corpus: {}, queries: {} };
  for (let start = 0; start < inputs.length; start += 64) {
    const batch = inputs.slice(start, start + 64);
    const response = await client.embeddings.create({ model: MODEL, dimensions: DIMENSIONS, input: batch.map(item => item.text) });
    response.data.forEach((embedding, index) => {
      const item = batch[index];
      cache[item.collection][item.id] = {
        content_hash: hash(item.text),
        embedding: embedding.embedding.map(value => Number(value.toFixed(6)))
      };
    });
    console.log(`Embedded ${Math.min(start + batch.length, inputs.length)}/${inputs.length}`);
  }
  fs.writeFileSync(path.join(ROOT, 'embeddings.json'), `${JSON.stringify(cache)}\n`);
  console.log(`Wrote ${inputs.length} ${MODEL} embeddings (${DIMENSIONS} dimensions).`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { DIMENSIONS, MODEL, hash };
