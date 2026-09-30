'use strict';

// Offline, deterministic retrieval benchmark. Production scoring functions are
// imported directly; only the dataset and cached vectors are fixture-specific.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { textMatchScore } = require('../../memory_v2');
const { entityMatchScore, isRelevantRetrieval, recencyBoost, scoreMemoryRetrieval } = require('../../retrieval_scoring');
const { DIMENSIONS, MODEL, hash } = require('./embed');

const ROOT = __dirname;
const RESULTS = path.join(ROOT, 'results');
const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const LIMIT = 4;
const CONFIGS = ['full', 'vector_only', 'lexical_only', 'entity_only', 'vector_lexical', 'full_no_recency', 'full_no_confidence', 'full_no_filter'];
const METRICS = ['recall_at_1', 'recall_at_3', 'recall_at_4', 'precision_at_4', 'mrr', 'ndcg_at_4', 'no_answer_accuracy', 'distractor_false_positive_rate'];

const read = name => JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));
const datasetHash = (corpus, queries) => crypto.createHash('sha256').update(JSON.stringify({ corpus, queries })).digest('hex');
function validateCache(corpus, queries, cache) {
  if (cache.model !== MODEL || cache.dimensions !== DIMENSIONS) throw new Error(`Embedding cache has ${cache.model || 'unknown'} / ${cache.dimensions || 'unknown'} dimensions; re-run npm run bench:retrieval:embed.`);
  for (const [collection, items, field] of [['corpus', corpus, 'content'], ['queries', queries, 'query']]) {
    for (const item of items) {
      const entry = cache[collection] && cache[collection][item.id];
      if (!entry || entry.content_hash !== hash(item[field]) || !Array.isArray(entry.embedding) || entry.embedding.length !== DIMENSIONS) {
        throw new Error(`Embedding cache is stale or incomplete for ${collection}/${item.id}. Re-run npm run bench:retrieval:embed and commit embeddings.json.`);
      }
    }
  }
}
function loadFixture() {
  const corpus = read('corpus.json');
  const queries = read('queries.json');
  const cachePath = path.join(ROOT, 'embeddings.json');
  if (!fs.existsSync(cachePath)) throw new Error('Embedding cache is missing. Run `npm run bench:retrieval:embed` (requires OPENAI_API_KEY), then commit eval/retrieval/embeddings.json.');
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  validateCache(corpus, queries, cache);
  return { corpus, queries, cache, dataset_hash: datasetHash(corpus, queries) };
}
function cosine(a, b) {
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
function recomposedTrace({ query, memory, vectorScore, lexicalScore, config }) {
  const entityScore = entityMatchScore(query, memory.content);
  const useVector = !['lexical_only', 'entity_only'].includes(config);
  const useLexical = !['vector_only', 'entity_only'].includes(config);
  const useEntity = !['vector_only', 'lexical_only', 'vector_lexical'].includes(config);
  const useRecency = config !== 'full_no_recency';
  const useConfidence = config !== 'full_no_confidence';
  const vector = useVector ? vectorScore : 0;
  const lexical = useLexical ? lexicalScore : 0;
  const entity = useEntity ? entityScore : 0;
  const base = Math.max(vector, lexical * 0.95, entity * 0.85);
  const recency = useRecency ? recencyBoost(memory.updated_at || memory.created_at, NOW) : { age_days: null, boost: 0 };
  const confidence = useConfidence ? Number((0.04 * Math.max(0, Math.min(1, Number(memory.confidence) || 0))).toFixed(4)) : 0;
  return {
    base_score: Number(base.toFixed(4)), final_score: Number(Math.min(1, base + recency.boost + confidence).toFixed(4)),
    vector_score: Number(vector.toFixed(4)), lexical_score: Number(lexical.toFixed(4)), entity_score: Number(entity.toFixed(4)),
    recency_boost: recency.boost, confidence_boost: confidence, age_days: recency.age_days
  };
}
function scoreCandidate(query, memory, cache, config = 'full') {
  const vectorScore = cosine(cache.queries[query.id].embedding, cache.corpus[memory.id].embedding);
  const lexicalScore = textMatchScore(query.query, memory.content);
  if (config === 'full' || config === 'full_no_filter') return scoreMemoryRetrieval({ query: query.query, content: memory.content, kind: memory.kind, confidence: memory.confidence, vectorScore, lexicalScore, createdAt: memory.created_at, updatedAt: memory.updated_at, now: NOW });
  return recomposedTrace({ query: query.query, memory, vectorScore, lexicalScore, config });
}
function rankQuery(query, corpus, cache, { config = 'full', vectorThreshold = 0.35, lexicalThreshold = 0.34 } = {}) {
  const rows = corpus.map(memory => {
    const retrieval = scoreCandidate(query, memory, cache, config);
    return { id: memory.id, retrieval, score: retrieval.final_score };
  }).filter(row => config === 'full_no_filter' || isRelevantRetrieval(row.retrieval, { threshold: vectorThreshold, lexicalThreshold }));
  return rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, LIMIT);
}
function gain(grade) { return (2 ** Number(grade || 0)) - 1; }
function measures(ranked, relevant) {
  const entries = Object.entries(relevant || {});
  if (!entries.length) return { recall_at_1: null, recall_at_3: null, recall_at_4: null, precision_at_4: null, mrr: null, ndcg_at_4: null, empty_correct: ranked.length === 0 ? 1 : 0 };
  const ids = new Set(entries.map(([id]) => id));
  const recall = k => ranked.slice(0, k).filter(row => ids.has(row.id)).length / ids.size;
  const first = ranked.findIndex(row => ids.has(row.id));
  const dcg = ranked.slice(0, LIMIT).reduce((sum, row, index) => sum + gain(relevant[row.id]) / Math.log2(index + 2), 0);
  const ideal = entries.map(([, grade]) => gain(grade)).sort((a, b) => b - a).slice(0, LIMIT).reduce((sum, value, index) => sum + value / Math.log2(index + 2), 0);
  return { recall_at_1: recall(1), recall_at_3: recall(3), recall_at_4: recall(4), precision_at_4: ranked.slice(0, LIMIT).filter(row => ids.has(row.id)).length / LIMIT, mrr: first < 0 ? 0 : 1 / (first + 1), ndcg_at_4: ideal ? dcg / ideal : 0, empty_correct: null };
}
function average(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function seedRandom(seed = 90210) { let state = seed >>> 0; return () => ((state = (1664525 * state + 1013904223) >>> 0) / 4294967296); }
function quantile(sorted, probability) { if (!sorted.length) return null; const index = (sorted.length - 1) * probability; const low = Math.floor(index); const high = Math.ceil(index); return sorted[low] + (sorted[high] - sorted[low]) * (index - low); }
function ci(values, resamples = 2000, seed = 90210) {
  if (!values.length) return { value: null, ci95: [null, null], n: 0 };
  const rand = seedRandom(seed); const sampled = [];
  for (let i = 0; i < resamples; i++) { let total = 0; for (let j = 0; j < values.length; j++) total += values[Math.floor(rand() * values.length)]; sampled.push(total / values.length); }
  sampled.sort((a, b) => a - b);
  return { value: average(values), ci95: [quantile(sampled, 0.025), quantile(sampled, 0.975)], n: values.length };
}
function pairedCi(left, right, resamples = 2000, seed = 112358) {
  const rand = seedRandom(seed); const sampled = [];
  for (let i = 0; i < resamples; i++) { let total = 0; for (let j = 0; j < left.length; j++) { const index = Math.floor(rand() * left.length); total += left[index] - right[index]; } sampled.push(total / left.length); }
  sampled.sort((a, b) => a - b); return { value: average(left.map((value, i) => value - right[i])), ci95: [quantile(sampled, 0.025), quantile(sampled, 0.975)], n: left.length };
}
function evaluate(queries, corpus, cache, options = {}) {
  const perQuery = queries.map(query => {
    const ranked = rankQuery(query, corpus, cache, options); const metric = measures(ranked, query.relevant);
    return { id: query.id, category: query.category, ranked_ids: ranked.map(row => row.id), ...metric, distractor_hit: query.distractor_id ? Number(ranked.some(row => row.id === query.distractor_id)) : null };
  });
  const summarize = rows => Object.fromEntries(METRICS.map(metric => {
    let values;
    if (metric === 'no_answer_accuracy') values = rows.filter(row => row.category === 'no_answer').map(row => row.empty_correct);
    else if (metric === 'distractor_false_positive_rate') values = rows.filter(row => row.category === 'distractor').map(row => row.distractor_hit);
    else values = rows.filter(row => row.category !== 'no_answer').map(row => row[metric]);
    return [metric, ci(values)];
  }));
  const categories = Object.fromEntries([...new Set(queries.map(query => query.category))].sort().map(category => [category, summarize(perQuery.filter(row => row.category === category))]));
  return { metrics: summarize(perQuery), categories, per_query: perQuery };
}
function fixed(value) { return value == null ? '—' : value.toFixed(3); }
function table(rows, headers) { return `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map(row => `| ${row.join(' | ')} |`).join('\n')}`; }
function metricText(metric) { return metric.value == null ? '—' : `${fixed(metric.value)} [${fixed(metric.ci95[0])}, ${fixed(metric.ci95[1])}]`; }
function writeSvg(results) {
  const width = 1060; const height = 390; const chartHeight = 270; const barWidth = 14; const gap = 11;
  const groups = CONFIGS.map((name, index) => {
    const x = 70 + index * 122; const recall = results.configs[name].metrics.recall_at_4; const mrr = results.configs[name].metrics.mrr;
    const bar = (metric, offset, color) => { const y = 330 - metric.value * chartHeight; const hi = 330 - metric.ci95[1] * chartHeight; const lo = 330 - metric.ci95[0] * chartHeight; return `<rect x="${x + offset}" y="${y}" width="${barWidth}" height="${metric.value * chartHeight}" fill="${color}"/><path d="M${x + offset + 7},${hi}V${lo}M${x + offset + 3},${hi}H${x + offset + 11}M${x + offset + 3},${lo}H${x + offset + 11}" stroke="#18202b"/>`; };
    return `${bar(recall, 0, '#3478c5')}${bar(mrr, barWidth + gap, '#d8792c')}<text x="${x + 16}" y="355" text-anchor="middle" font-size="10">${name.replace('full_', 'f_')}</text>`;
  }).join('');
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, 'recall_by_config.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/><style>text{font-family:system-ui,sans-serif;fill:#18202b}</style><text x="50" y="28" font-size="18" font-weight="600">Test retrieval metrics (95% bootstrap CI)</text><path d="M55,60V330H1040" stroke="#465466"/>${[0, .25, .5, .75, 1].map(v => `<path d="M50,${330-v*chartHeight}H1040" stroke="#e7edf3"/><text x="45" y="${334-v*chartHeight}" text-anchor="end" font-size="10">${v}</text>`).join('')}<rect x="820" y="20" width="12" height="12" fill="#3478c5"/><text x="838" y="31" font-size="11">Recall@4</text><rect x="920" y="20" width="12" height="12" fill="#d8792c"/><text x="938" y="31" font-size="11">MRR</text>${groups}</svg>`);
}
function report(results) {
  const headline = CONFIGS.map(name => { const m = results.configs[name].metrics; return [name, metricText(m.recall_at_1), metricText(m.recall_at_3), metricText(m.recall_at_4), metricText(m.precision_at_4), metricText(m.mrr), metricText(m.ndcg_at_4), metricText(m.no_answer_accuracy), metricText(m.distractor_false_positive_rate)]; });
  const paired = results.paired.full_vs_vector_only;
  const pairedSentence = paired.mrr.ci95[1] < 0 && paired.ndcg_at_4.ci95[1] < 0 ? 'On this test fixture, full ranks worse than vector-only on both MRR and nDCG@4; both paired confidence intervals exclude zero.' : paired.mrr.ci95[0] > 0 && paired.ndcg_at_4.ci95[0] > 0 ? 'On this test fixture, full ranks better than vector-only on both MRR and nDCG@4; both paired confidence intervals exclude zero.' : 'On this test fixture, the full-versus-vector-only result is not statistically distinguishable on at least one paired metric.';
  const byCategory = Object.entries(results.configs.full.categories).flatMap(([category, metrics]) => [[category, ...['recall_at_1', 'recall_at_3', 'recall_at_4', 'precision_at_4', 'mrr', 'ndcg_at_4', 'no_answer_accuracy', 'distractor_false_positive_rate'].map(key => metricText(metrics[key]))]]);
  const sweepRows = results.threshold_sweep.dev.map(row => [row.threshold.toFixed(2), fixed(row.recall_at_4), fixed(row.no_answer_accuracy)]);
  const recommendations = results.paired.full_vs_vector_only.mrr.ci95[0] > 0 ? 'The fixture supports retaining hybrid scoring as a hypothesis, but not changing production thresholds from this synthetic result alone.' : 'Do not claim hybrid scoring beats vector-only from this fixture; collect owner-reviewed retrieval traces before changing production scoring.';
  const full = results.configs.full.metrics;
  const vector = results.configs.vector_only.metrics;
  const lexical = results.configs.lexical_only.metrics;
  const entity = results.configs.entity_only.metrics;
  const noRecency = results.configs.full_no_recency.metrics;
  const noConfidence = results.configs.full_no_confidence.metrics;
  return `# Offline retrieval benchmark\n\n## Question and setup\n\nDoes AURA’s production hybrid memory ranker beat vector-only recall? This deterministic, offline fixture contains ${results.dataset.memories} fictional memories and ${results.dataset.queries} fictional queries (${results.dataset.dev_queries} dev / ${results.dataset.test_queries} test), with a fixed clock of ${new Date(NOW).toISOString()}. All headline values are test-split estimates; CIs are 2,000-resample query bootstraps. Retrieval metrics exclude no-answer questions, which are measured separately.\n\n## Headline test results\n\n${table(headline, ['config', 'R@1', 'R@3', 'R@4', 'P@4', 'MRR', 'nDCG@4', 'No-answer acc.', 'Distractor FP'])}\n\n![Recall@4 and MRR](/eval/retrieval/results/recall_by_config.svg)\n\n## Paired full vs vector-only\n\n- MRR difference: ${metricText(paired.mrr)}\n- nDCG@4 difference: ${metricText(paired.ndcg_at_4)}\n\n${pairedSentence}\n\n## Full configuration by category\n\n${table(byCategory, ['category', 'R@1', 'R@3', 'R@4', 'P@4', 'MRR', 'nDCG@4', 'No-answer acc.', 'Distractor FP'])}\n\n## Threshold sweep\n\nProduction MemoryStore.search() uses vector threshold 0.35; isRelevantRetrieval() defaults to 0.32. The dev-only sweep chose ${results.threshold_sweep.optimal_threshold.toFixed(2)} (tie-break: no-answer accuracy, then distance to 0.35).\n\n${table(sweepRows, ['dev threshold', 'Recall@4', 'No-answer accuracy'])}\n\n| Test evaluation | Recall@4 | No-answer accuracy |\n| --- | --- | --- |\n| Production 0.35 | ${fixed(results.threshold_sweep.test_production.recall_at_4)} | ${fixed(results.threshold_sweep.test_production.no_answer_accuracy)} |\n| Dev-selected ${results.threshold_sweep.optimal_threshold.toFixed(2)} | ${fixed(results.threshold_sweep.test_selected.recall_at_4)} | ${fixed(results.threshold_sweep.test_selected.no_answer_accuracy)} |\n\n## What the ablations say\n\nVector-only MRR is ${fixed(vector.mrr.value)} versus ${fixed(full.mrr.value)} for full; lexical-only (${fixed(lexical.mrr.value)}) and entity-only (${fixed(entity.mrr.value)}) do not recover that gap. Removing recency changes full MRR to ${fixed(noRecency.mrr.value)}; removing confidence changes it to ${fixed(noConfidence.mrr.value)}. These fixture-specific ablations are diagnostic evidence, not a production-change authorization.\n\n## Limitations\n\nThis is synthetic data with machine-generated labels, a small sample, and a 200-row candidate cap that the 180-row corpus does not stress. Cached embeddings are rounded to six decimals. The fixture is a regression benchmark, not a representative sample of private owner memories or a proof of real-world retrieval quality.\n\n## Recommendations — not implemented in this PR\n\n${recommendations}\n`;
}
function gitSha() { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(ROOT, '../..'), encoding: 'utf8' }).trim(); } catch { return 'unavailable'; } }
function runBenchmark() {
  const fixture = loadFixture(); const test = fixture.queries.filter(query => query.split === 'test'); const dev = fixture.queries.filter(query => query.split === 'dev');
  const configs = Object.fromEntries(CONFIGS.map(config => [config, evaluate(test, fixture.corpus, fixture.cache, { config })]));
  const pairedRows = ['mrr', 'ndcg_at_4'].reduce((out, metric) => { const a = configs.full.per_query.filter(row => row.category !== 'no_answer').map(row => row[metric]); const b = configs.vector_only.per_query.filter(row => row.category !== 'no_answer').map(row => row[metric]); out[metric] = pairedCi(a, b); return out; }, {});
  const devSweep = []; for (let threshold = 0.20; threshold <= 0.5001; threshold += 0.02) { const result = evaluate(dev, fixture.corpus, fixture.cache, { config: 'full', vectorThreshold: Number(threshold.toFixed(2)) }); devSweep.push({ threshold: Number(threshold.toFixed(2)), recall_at_4: result.metrics.recall_at_4.value, no_answer_accuracy: result.metrics.no_answer_accuracy.value }); }
  const optimal = [...devSweep].sort((a, b) => b.recall_at_4 - a.recall_at_4 || b.no_answer_accuracy - a.no_answer_accuracy || Math.abs(a.threshold - .35) - Math.abs(b.threshold - .35))[0];
  const testProduction = evaluate(test, fixture.corpus, fixture.cache, { config: 'full', vectorThreshold: 0.35 }).metrics;
  const testSelected = evaluate(test, fixture.corpus, fixture.cache, { config: 'full', vectorThreshold: optimal.threshold }).metrics;
  const results = { benchmark: 'aura-offline-retrieval', fixed_now: new Date(NOW).toISOString(), git_sha: gitSha(), dataset_hash: fixture.dataset_hash, embedding: { model: MODEL, dimensions: DIMENSIONS }, dataset: { memories: fixture.corpus.length, queries: fixture.queries.length, dev_queries: dev.length, test_queries: test.length, candidate_cap: 200 }, configs: Object.fromEntries(CONFIGS.map(config => [config, { metrics: configs[config].metrics, categories: configs[config].categories }])), paired: { full_vs_vector_only: pairedRows }, threshold_sweep: { production_memory_store_threshold: 0.35, scorer_default_threshold: 0.32, dev: devSweep, optimal_threshold: optimal.threshold, test_production: { recall_at_4: testProduction.recall_at_4.value, no_answer_accuracy: testProduction.no_answer_accuracy.value }, test_selected: { recall_at_4: testSelected.recall_at_4.value, no_answer_accuracy: testSelected.no_answer_accuracy.value } } };
  fs.mkdirSync(RESULTS, { recursive: true }); fs.writeFileSync(path.join(RESULTS, 'latest.json'), `${JSON.stringify(results, null, 2)}\n`); fs.writeFileSync(path.join(RESULTS, 'REPORT.md'), report(results)); writeSvg(results); return results;
}
if (require.main === module) { try { const result = runBenchmark(); console.log(`Wrote retrieval benchmark for ${result.dataset.test_queries} test queries.`); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { CONFIGS, LIMIT, NOW, ci, cosine, evaluate, loadFixture, measures, pairedCi, rankQuery, runBenchmark, scoreCandidate, validateCache };
