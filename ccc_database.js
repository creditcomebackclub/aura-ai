const { createClient } = require('@supabase/supabase-js');

let supabase = null;

function initSupabase() {
  if (!supabase) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    if (supabaseUrl && supabaseKey) {
      supabase = createClient(supabaseUrl, supabaseKey);
    }
  }
  return supabase;
}

async function listTables() {
  const db = initSupabase();
  if (!db) return "Error: Database connection not configured.";

  try {
    const { data, error } = await db.rpc('aura_list_tables');
    if (error) throw error;
    return JSON.stringify(data);
  } catch (error) {
    return `Error fetching tables: ${error.message}`;
  }
}

async function getTableSchema(tableName) {
  const db = initSupabase();
  if (!db) return "Error: Database connection not configured.";

  try {
    const { data, error } = await db.rpc('aura_table_schema', { p_table_name: tableName.toLowerCase() });
    if (error) throw error;
    return JSON.stringify(data);
  } catch (error) {
    return `Error fetching schema for ${tableName}: ${error.message}`;
  }
}

// Applies a filter list to a query builder.
// op: "match" = partial, case-insensitive, word-order-independent (e.g. "Karl Elliot" -> "Karl J Elliott")
//     "is_null" / "not_null" = presence checks (need no value)
//     "gt" / "gte" / "lt" / "lte" = comparisons, useful for dates
//     default "eq" = exact match
function applyFilters(query, filters = []) {
  for (const filter of filters) {
    if (!filter || !filter.column) continue;
    const op = filter.op || 'eq';

    if (op === 'is_null') { query = query.is(filter.column, null); continue; }
    if (op === 'not_null') { query = query.not(filter.column, 'is', null); continue; }

    if (filter.value === undefined || filter.value === null || filter.value === '') continue;

    switch (op) {
      case 'match':
        for (const word of String(filter.value).trim().split(/\s+/)) {
          query = query.ilike(filter.column, `%${word}%`);
        }
        break;
      case 'gt': query = query.gt(filter.column, filter.value); break;
      case 'gte': query = query.gte(filter.column, filter.value); break;
      case 'lt': query = query.lt(filter.column, filter.value); break;
      case 'lte': query = query.lte(filter.column, filter.value); break;
      default: query = query.eq(filter.column, filter.value);
    }
  }
  return query;
}

// A ledger entry counts as money still owed unless it is explicitly marked paid.
// The app writes "Due" for open invoices, so matching on a fixed list of words
// (Unpaid/Pending) silently reported $0 outstanding and never fired overdue alerts.
function isOutstanding(status) {
  if (!status) return false;
  return ['due', 'unpaid', 'pending', 'overdue', 'past due']
    .includes(String(status).trim().toLowerCase());
}

function getLedgerTransactionDate(entry) {
  const value = entry?.paid_at || entry?.date || entry?.created_at;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function getRecentBusinessActivity({ hours = 48, now = new Date() } = {}) {
  const db = initSupabase();
  if (!db) throw new Error('Database connection not configured.');
  const safeHours = Math.max(1, Math.min(168, Number(hours) || 48));
  const sinceMs = now.getTime() - safeHours * 60 * 60 * 1000;
  const recent = value => {
    const timestamp = new Date(value || '').getTime();
    return Number.isFinite(timestamp) && timestamp >= sinceMs && timestamp <= now.getTime();
  };

  const [clientResult, leadResult, letterResult] = await Promise.all([
    db.from('clients').select('name, ledger'),
    db.from('leads').select('*').limit(500),
    db.from('letters')
      .select('client_name, furnisher, phase, mailed_date')
      .gte('mailed_date', new Date(sinceMs).toISOString())
  ]);

  const errors = [];
  if (clientResult.error) errors.push(`invoices:${clientResult.error.message}`);
  if (leadResult.error) errors.push(`leads:${leadResult.error.message}`);
  if (letterResult.error) errors.push(`letters:${letterResult.error.message}`);

  const invoices = [];
  for (const client of clientResult.data || []) {
    for (const entry of Array.isArray(client.ledger) ? client.ledger : []) {
      const created = entry.created_at || entry.date;
      if (!isOutstanding(entry.status) || !recent(created)) continue;
      invoices.push({
        client: client.name,
        amount: Number(entry.amount) || 0,
        description: entry.description || null,
        created_at: created
      });
    }
  }

  const leads = (leadResult.data || [])
    .filter(lead => recent(lead.created_at || lead.date || lead.submitted_at))
    .map(lead => ({
      name: lead.name || lead.full_name || lead.client_name || lead.email || 'Unnamed lead',
      created_at: lead.created_at || lead.date || lead.submitted_at
    }));

  const letters = (letterResult.data || []).map(letter => ({
    client_name: letter.client_name,
    furnisher: letter.furnisher,
    phase: letter.phase,
    mailed_date: letter.mailed_date
  }));

  return { hours: safeHours, invoices, leads, letters, errors };
}

// Lists every client with money still owed, reading inside the ledger JSON.
// Needed because the ledger is a nested array that plain column filters can't reach.
async function getOutstandingBalances() {
  const db = initSupabase();
  if (!db) return "Error: Database connection not configured.";

  try {
    const { data, error } = await db.from('clients').select('name, billing_status, ledger');
    if (error) throw error;

    const results = [];
    for (const client of data || []) {
      if (!Array.isArray(client.ledger)) continue;

      const open = client.ledger
        .filter(e => isOutstanding(e.status) && (e.amount || 0) > 0)
        .map(e => ({
          amount: e.amount,
          status: e.status,
          description: e.description,
          date: e.due_date || e.date || e.created_at
        }));

      if (open.length > 0) {
        results.push({
          client: client.name,
          total_owed: open.reduce((sum, e) => sum + e.amount, 0),
          entries: open
        });
      }
    }

    if (results.length === 0) return JSON.stringify({ outstanding_clients: [], note: 'Every client ledger is fully paid.' });
    return JSON.stringify({ outstanding_clients: results });
  } catch (error) {
    return `Error fetching outstanding balances: ${error.message}`;
  }
}

// Returns an exact row count without pulling the rows, so "how many..." questions
// can be answered precisely instead of by counting a truncated page of results.
async function countRows(tableName, filters = []) {
  const db = initSupabase();
  if (!db) return "Error: Database connection not configured.";

  try {
    let query = db.from(tableName.toLowerCase()).select('*', { count: 'exact', head: true });
    query = applyFilters(query, filters);

    const { count, error } = await query;
    if (error) throw error;

    return JSON.stringify({ table: tableName.toLowerCase(), matching_rows: count });
  } catch (error) {
    return `Error counting ${tableName}: ${error.message}`;
  }
}

async function queryTable(tableName, limit = 200, filters = [], orderBy = null, orderDirection = 'desc') {
  const db = initSupabase();
  if (!db) return "Error: Database connection not configured.";

  try {
    // Ask for the total match count too, so truncation can be reported rather than hidden.
    let query = db.from(tableName.toLowerCase()).select('*', { count: 'exact' });
    query = applyFilters(query, filters);

    if (orderBy) {
      query = query.order(orderBy, { ascending: orderDirection !== 'desc' });
    }

    query = query.limit(limit);

    const { data, error, count } = await query;
    if (error) throw error;

    // Never let her silently believe a partial page is the whole result set.
    if (typeof count === 'number' && count > data.length) {
      return JSON.stringify({
        warning: `TRUNCATED: ${count} rows match this query but only ${data.length} are shown. Do NOT state totals from these rows - use count_database_rows for an exact count, or narrow the filters.`,
        total_matching_rows: count,
        returned_rows: data.length,
        rows: data
      });
    }

    return JSON.stringify(data);
  } catch (error) {
    return `Error querying ${tableName}: ${error.message}`;
  }
}

const NAME_NOISE_WORDS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr',
  'client', 'customer'
]);

// Ordinary English words that must never be rewritten into a client name.
// Transcript correction used to treat any 4+ letter token as a candidate
// surname, so "call him back" became "call him Jack", "park the car" became
// "Mark the car", and "I love you back" became "I love you Jack" - which the
// model then reasonably read as a statement about a personal relationship.
// A score threshold cannot catch these: a client genuinely named Mark, Dawn,
// or Grant scores a perfect 1.0 against the identical English word, so the
// word itself has to be disqualified up front.
const COMMON_WORD_STOPLIST = new Set([
  'able', 'about', 'above', 'after', 'again', 'against', 'ahead', 'align',
  'alike', 'alone', 'along', 'already', 'also', 'always', 'among', 'another',
  'answer', 'anyone', 'anything', 'apart', 'around', 'aside', 'asked', 'away',
  'back', 'bank', 'base', 'because', 'become', 'been', 'before', 'begin',
  'behind', 'being', 'believe', 'below', 'best', 'better', 'between', 'beyond',
  'bill', 'blank', 'block', 'board', 'both', 'bring', 'brought', 'build',
  'business', 'call', 'called', 'came', 'cancel', 'cannot', 'card', 'care',
  'carry', 'case', 'cash', 'catch', 'chance', 'change', 'charge', 'check',
  'city', 'claim', 'class', 'clean', 'clear', 'close', 'come', 'coming',
  'common', 'company', 'complete', 'confirm', 'could', 'count', 'course',
  'cover', 'credit', 'current', 'dark', 'date', 'dawn', 'deal', 'dear',
  'decide', 'deep', 'detail', 'different', 'does', 'doing', 'done', 'down',
  'draft', 'drive', 'drop', 'during', 'each', 'earlier', 'early', 'easy',
  'either', 'else', 'email', 'enough', 'enter', 'even', 'evening', 'ever',
  'every', 'everything', 'exact', 'expect', 'fact', 'fair', 'fall', 'family',
  'fast', 'feel', 'fell', 'file', 'fill', 'final', 'find', 'fine', 'finish',
  'first', 'follow', 'forget', 'form', 'forward', 'found', 'frank', 'free',
  'friend', 'from', 'front', 'full', 'game', 'gave', 'general', 'gets',
  'give', 'given', 'goes', 'going', 'gone', 'good', 'grace', 'grand', 'grant',
  'great', 'green', 'group', 'grow', 'guess', 'half', 'hand', 'happen',
  'hard', 'hart', 'have', 'having', 'head', 'hear', 'heard', 'held', 'help',
  'here', 'high', 'hold', 'home', 'hope', 'hour', 'house', 'however', 'hunt',
  'idea', 'important', 'inside', 'instead', 'issue', 'item', 'jack', 'jump',
  'just', 'keep', 'kind', 'knew', 'know', 'known', 'land', 'large',
  'last', 'late', 'later', 'lead', 'learn', 'least', 'leave', 'left', 'less',
  'letter', 'level', 'life', 'light', 'like', 'line', 'list', 'little',
  'live', 'long', 'look', 'lost', 'love', 'made', 'mail', 'main', 'make',
  'many', 'mark', 'match', 'matter', 'maybe', 'mean', 'meet', 'might',
  'mind', 'minute', 'miss', 'money', 'month', 'more', 'morning', 'most',
  'move', 'much', 'must', 'name', 'near', 'need', 'never', 'next', 'nice',
  'night', 'none', 'noon', 'north', 'note', 'nothing', 'notice', 'number',
  'offer', 'office', 'often', 'once', 'only', 'open', 'order', 'other',
  'over', 'page', 'paid', 'park', 'part', 'party', 'pass', 'past', 'pay',
  'people', 'perhaps', 'phone', 'pick', 'place', 'plan', 'play', 'please',
  'point', 'poor', 'post', 'power', 'price', 'probably', 'problem', 'pull',
  'push', 'quick', 'quite', 'rate', 'rather', 'reach', 'read', 'ready',
  'real', 'really', 'reason', 'recent', 'record', 'reed', 'rest', 'return',
  'review', 'rich', 'ride', 'right', 'ring', 'rise', 'road', 'rock', 'room',
  'round', 'rule', 'same', 'save', 'schedule', 'second', 'seem', 'seen',
  'sell', 'send', 'sent', 'service', 'seven', 'several', 'shall', 'share',
  'shop', 'short', 'should', 'show', 'side', 'sign', 'since', 'single',
  'sitting', 'small', 'some', 'someone', 'something', 'soon', 'sort',
  'sound', 'south', 'speak', 'spend', 'stand', 'star', 'start', 'state',
  'stay', 'step', 'still', 'stone', 'stop', 'story', 'street', 'strong',
  'such', 'sure', 'take', 'talk', 'tell', 'than', 'thank', 'that', 'their',
  'them', 'then', 'there', 'these', 'they', 'thing', 'think', 'this',
  'those', 'though', 'thought', 'three', 'through', 'time', 'today',
  'together', 'told', 'tomorrow', 'took', 'total', 'town', 'track', 'trade',
  'true', 'trust', 'turn', 'under', 'until', 'upon', 'used', 'very', 'view',
  'wait', 'wade', 'walk', 'want', 'ward', 'warm', 'wash', 'watch', 'water',
  'week', 'well', 'went', 'were', 'west', 'what', 'when', 'where', 'which',
  'while', 'white', 'whole', 'will', 'wish', 'with', 'within', 'without',
  'wood', 'word', 'work', 'world', 'worth', 'would', 'write', 'wrong',
  'year', 'your'
]);

// Single-token rewrites are the dangerous case: a lone word has no
// surrounding name evidence, and one wrong letter in a short token already
// clears the similarity bar (normalized edit distance puts "back" vs "Jack"
// at exactly 0.75). Real mangled surnames that need correction are long -
// "pissavage" is nine characters and scores 0.7778 against "Pesavage" - so
// requiring six characters keeps every case this feature exists for while
// removing the entire class of four- and five-letter English words.
const MIN_SINGLE_TOKEN_REWRITE_LENGTH = 6;
const MIN_SINGLE_TOKEN_REWRITE_SCORE = 0.76;

function isCommonEnglishWord(value) {
  return COMMON_WORD_STOPLIST.has(String(value || '').toLowerCase());
}

function normalizeClientName(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(word => word && !NAME_NOISE_WORDS.has(word));
}

function levenshteinDistance(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function wordSimilarity(left, right) {
  if (left === right) return 1;
  const longest = Math.max(left.length, right.length);
  if (!longest) return 1;
  return 1 - (levenshteinDistance(left, right) / longest);
}

function directionalNameSimilarity(sourceTokens, targetTokens) {
  if (!sourceTokens.length || !targetTokens.length) return 0;
  const available = [...targetTokens];
  let total = 0;
  for (const source of sourceTokens) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let index = 0; index < available.length; index++) {
      const score = wordSimilarity(source, available[index]);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    // A weak resemblance between unrelated words should not inflate a name
    // match, and must not consume the real matching token either — otherwise
    // "Pesavage" vs "Mike Pesavage" can lose the last-name hit to a weak
    // first-name pair and score artificially low.
    if (bestScore >= 0.6) {
      total += bestScore;
      if (bestIndex >= 0) available.splice(bestIndex, 1);
    }
  }
  return total / sourceTokens.length;
}

function scoreClientName(query, candidate) {
  const queryTokens = normalizeClientName(query);
  const candidateTokens = normalizeClientName(candidate);
  if (!queryTokens.length || !candidateTokens.length) return 0;
  if (queryTokens.join(' ') === candidateTokens.join(' ')) return 1;

  const queryCoverage = directionalNameSimilarity(queryTokens, candidateTokens);
  const candidateCoverage = directionalNameSimilarity(candidateTokens, queryTokens);
  const average = (queryCoverage + candidateCoverage) / 2;
  // Spoken queries are often last-name-only or a Whisper-garbled last name
  // ("pissavage", "Karl") against a stored "First Last". Averaging in the
  // unmatched first name pulls a good last-name hit below the admit
  // threshold — prefer query coverage when the owner said fewer tokens.
  const score = queryTokens.length < candidateTokens.length
    ? Math.max(queryCoverage, average)
    : average;
  return Number(score.toFixed(4));
}

function bestTokenOverlap(query, candidate) {
  const queryTokens = normalizeClientName(query);
  const candidateTokens = normalizeClientName(candidate);
  let best = 0;
  for (const queryToken of queryTokens) {
    for (const candidateToken of candidateTokens) {
      best = Math.max(best, wordSimilarity(queryToken, candidateToken));
    }
  }
  return best;
}

function rankScoredClients(scored, { minScore = 0.68, clearWinnerGap = 0.1, ambiguityWindow = 0.04 } = {}) {
  const ranked = (scored || [])
    .filter(client => client._match_score >= minScore)
    .sort((left, right) =>
      right._match_score - left._match_score ||
      String(left.name).localeCompare(String(right.name))
    );

  if (ranked.length <= 1) return ranked;
  // A clearly superior match is safe to use. Close candidates must remain
  // ambiguous so AURA asks the owner instead of guessing a client identity.
  if (ranked[0]._match_score - ranked[1]._match_score >= clearWinnerGap) return [ranked[0]];
  return ranked.filter(client => ranked[0]._match_score - client._match_score <= ambiguityWindow);
}

// A lookup whose whole query is one ordinary English word is not a name.
// Without this, "back" resolved to a client called Jack as a CONFIDENT match
// (0.75 against a 0.68 admit threshold), so the tool layer reproduced the
// same misidentification the transcript rewriter used to make.
function isUnnameableQuery(name) {
  const tokens = normalizeClientName(name);
  if (!tokens.length) return true;
  return tokens.every(token => isCommonEnglishWord(token));
}

function rankClientMatches(name, clients) {
  if (isUnnameableQuery(name)) return [];
  const scored = (clients || []).map(client => ({
    ...client,
    _match_score: scoreClientName(name, client.name)
  }));
  return rankScoredClients(scored);
}

// Lower-confidence neighbors for "did you mean?" when nothing clears the
// admit threshold — Whisper often mangling a last name should still surface
// the real client instead of a hard not-found.
function suggestClientMatches(name, clients, { minScore = 0.45, limit = 3 } = {}) {
  return (clients || [])
    .map(client => {
      const full = scoreClientName(name, client.name);
      const token = bestTokenOverlap(name, client.name);
      // Wrong first name + close last name averages too low to admit, but the
      // strong token hit is enough to ask "did you mean Jonathan Pesavage?"
      const score = Math.max(full, token >= 0.72 ? Number((token * 0.92).toFixed(4)) : 0);
      return { ...client, _match_score: score };
    })
    .filter(client => client._match_score >= minScore)
    .sort((left, right) =>
      right._match_score - left._match_score ||
      String(left.name).localeCompare(String(right.name))
    )
    .slice(0, limit);
}

function windowAnchoredToClientName(cleaned, clientName) {
  const queryTokens = normalizeClientName(cleaned);
  const candidateTokens = normalizeClientName(clientName);
  if (!queryTokens.length || !candidateTokens.length) return false;
  // Reject windows that start/end on filler ("is jonathan pissavage") so
  // correction only rewrites the name span itself.
  const firstOk = candidateTokens.some(token => wordSimilarity(queryTokens[0], token) >= 0.6);
  const lastOk = candidateTokens.some(
    token => wordSimilarity(queryTokens[queryTokens.length - 1], token) >= 0.6
  );
  return firstOk && lastOk;
}

function bestCanonicalNameToken(cleaned, clientName) {
  const queryToken = normalizeClientName(cleaned)[0];
  if (!queryToken) return null;
  let best = null;
  for (const rawToken of String(clientName).split(/\s+/)) {
    const normalized = normalizeClientName(rawToken)[0];
    if (!normalized) continue;
    const score = wordSimilarity(queryToken, normalized);
    if (!best || score > best.score) best = { score, rawToken };
  }
  return best?.score >= 0.6 ? best.rawToken : null;
}

// Rewrite Whisper-mangled client names in owner text to the canonical
// directory spelling before the model (and tool layer) see them. Only
// clear single winners are rewritten — ambiguous first names stay as-is.
function correctTranscriptClientNames(text, clients, { minScore = 0.72 } = {}) {
  if (!text || !clients?.length) return text;
  const parts = String(text).split(/(\s+)/);
  const wordIndexes = [];
  for (let index = 0; index < parts.length; index++) {
    if (parts[index] && !/^\s+$/.test(parts[index])) wordIndexes.push(index);
  }

  let cursor = 0;
  while (cursor < wordIndexes.length) {
    let best = null;
    for (let len = Math.min(3, wordIndexes.length - cursor); len >= 1; len--) {
      const indexes = wordIndexes.slice(cursor, cursor + len);
      const rawPhrase = indexes.map(index => parts[index]).join(' ');
      const cleaned = rawPhrase.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      const cleanedTokens = normalizeClientName(cleaned);
      if (!cleanedTokens.length) continue;
      // A window made entirely of ordinary English words is speech, not a
      // name, however closely it resembles one.
      if (cleanedTokens.every(isCommonEnglishWord)) continue;
      if (len === 1) {
        // Real surnames worth correcting are long; short tokens are where
        // English words collide with client names.
        if (cleaned.length < MIN_SINGLE_TOKEN_REWRITE_LENGTH) continue;
        if (isCommonEnglishWord(cleaned)) continue;
      }

      const singleTokenMinScore = Math.max(minScore, MIN_SINGLE_TOKEN_REWRITE_SCORE);
      const ranked = rankScoredClients(
        clients.map(client => ({
          ...client,
          _match_score: scoreClientName(cleaned, client.name)
        })),
        { minScore: len === 1 ? singleTokenMinScore : minScore }
      ).filter(client => windowAnchoredToClientName(cleaned, client.name));
      if (ranked.length !== 1) continue;
      // Single-token hits correct only that token's spelling (pissavage→
      // Pesavage). Multi-token hits expand to the full directory name.
      const replacement = len === 1
        ? (bestCanonicalNameToken(cleaned, ranked[0].name) || ranked[0].name)
        : ranked[0].name;
      const candidate = {
        len,
        score: ranked[0]._match_score,
        replacement,
        indexes
      };
      // Prefer the longest name window so "jonathan pissavage" becomes one
      // full name instead of two independent single-token rewrites.
      if (
        !best ||
        candidate.len > best.len ||
        (candidate.len === best.len && candidate.score > best.score)
      ) {
        best = candidate;
      }
    }

    if (!best) {
      cursor += 1;
      continue;
    }

    const first = best.indexes[0];
    const last = best.indexes[best.indexes.length - 1];
    const leading = parts[first].match(/^[^\p{L}\p{N}]*/u)?.[0] || '';
    const trailing = parts[last].match(/[^\p{L}\p{N}]*$/u)?.[0] || '';
    parts[first] = `${leading}${best.replacement}${trailing}`;
    for (let index = first + 1; index <= last; index++) parts[index] = '';
    cursor += best.len;
  }

  return parts.join('').replace(/[^\S\n]{2,}/g, ' ').trim();
}

async function correctOwnerTextClientNames(text) {
  const directory = await loadClientDirectory();
  if (directory.error || !directory.data?.length) return text;
  return correctTranscriptClientNames(text, directory.data);
}

// Client directory barely changes turn-to-turn; cache it so every voice turn
// doesn't pay a serial Supabase RTT before the model can even start.
let cachedClientDirectory = null;
let cachedClientDirectoryAtMs = 0;
const CLIENT_DIRECTORY_TTL_MS = 60_000;

async function loadClientDirectory() {
  const now = Date.now();
  if (
    cachedClientDirectory &&
    now - cachedClientDirectoryAtMs < CLIENT_DIRECTORY_TTL_MS
  ) {
    return cachedClientDirectory;
  }
  const db = initSupabase();
  if (!db) return { error: 'Database connection not configured.' };
  const { data, error } = await db
    .from('clients')
    .select('id, name, status, billing_status, billing_tier, ledger')
    .limit(1000);
  if (error) return { error: error.message };
  cachedClientDirectory = { data: data || [] };
  cachedClientDirectoryAtMs = now;
  return cachedClientDirectory;
}

function clearClientDirectoryCache() {
  cachedClientDirectory = null;
  cachedClientDirectoryAtMs = 0;
}

async function findClientsByName(name) {
  const directory = await loadClientDirectory();
  if (directory.error) return directory;
  return { data: rankClientMatches(name, directory.data) };
}

function clientNotFoundResult(name, directory = []) {
  const suggestions = suggestClientMatches(name, directory)
    .map(client => ({
      id: client.id,
      name: client.name,
      confidence: client._match_score
    }));
  return JSON.stringify({
    found: false,
    query: name,
    ...(suggestions.length ? { suggestions } : {})
  });
}

function normalizePhaseLabel(phase) {
  const value = String(phase || '').trim();
  const phaseMatch = value.match(/^phase\s*(\d+)/i);
  if (phaseMatch) return `Phase ${phaseMatch[1]}`;
  const roundMatch = value.match(/^round\s*(\d+)/i);
  if (roundMatch) return `Round ${roundMatch[1]}`;
  return value || null;
}

async function getClientCurrentPhase(name) {
  const db = initSupabase();
  if (!db) return "Error: Database connection not configured.";
  try {
    const directory = await loadClientDirectory();
    if (directory.error) throw new Error(directory.error);
    const clients = { data: rankClientMatches(name, directory.data) };
    if (clients.data.length === 0) return clientNotFoundResult(name, directory.data);
    if (clients.data.length > 1) {
      return JSON.stringify({
        found: false,
        ambiguous: true,
        query: name,
        matches: clients.data.map(client => ({ id: client.id, name: client.name }))
      });
    }

    const client = clients.data[0];
    const { data: letters, error } = await db.from('letters')
      .select('id, client_id, client_name, phase, furnisher, mailed_date, saved_at')
      .eq('client_id', client.id)
      .order('saved_at', { ascending: false })
      .limit(25);
    if (error) throw error;

    const latest = letters?.[0] || null;
    const currentPhase = normalizePhaseLabel(latest?.phase);
    const latestSavedAt = latest?.saved_at ? new Date(latest.saved_at).getTime() : null;
    const latestBatch = latestSavedAt === null
      ? (latest ? [latest] : [])
      : letters.filter(letter => {
          const savedAt = new Date(letter.saved_at).getTime();
          return Number.isFinite(savedAt) && Math.abs(latestSavedAt - savedAt) <= 10 * 60 * 1000;
        });

    return JSON.stringify({
      found: true,
      client: { id: client.id, name: client.name },
      name_match_confidence: client._match_score,
      current_phase: currentPhase,
      detailed_phase: latest?.phase ?? null,
      latest_batch_saved_at: latest?.saved_at ?? null,
      latest_batch_furnishers: [...new Set(latestBatch.map(letter => letter.furnisher).filter(Boolean))],
      evidence: latest
    });
  } catch (error) {
    return `Error finding current phase for ${name}: ${error.message}`;
  }
}

async function getClientSnapshot(name) {
  const db = initSupabase();
  if (!db) return "Error: Database connection not configured.";
  try {
    const directory = await loadClientDirectory();
    if (directory.error) throw new Error(directory.error);
    const clients = { data: rankClientMatches(name, directory.data) };
    if (clients.data.length === 0) return clientNotFoundResult(name, directory.data);
    if (clients.data.length > 1) {
      return JSON.stringify({
        found: false,
        ambiguous: true,
        query: name,
        matches: clients.data.map(client => ({ id: client.id, name: client.name }))
      });
    }

    const client = clients.data[0];
    const { data: letters, error } = await db.from('letters')
      .select('id, phase, furnisher, mailed_date, saved_at')
      .eq('client_id', client.id)
      .order('saved_at', { ascending: false })
      .limit(10);
    if (error) throw error;

    const openLedger = Array.isArray(client.ledger)
      ? client.ledger.filter(entry => isOutstanding(entry.status) && Number(entry.amount) > 0)
      : [];
    return JSON.stringify({
      found: true,
      client: {
        id: client.id,
        name: client.name,
        status: client.status,
        billing_status: client.billing_status,
        billing_tier: client.billing_tier
      },
      name_match_confidence: client._match_score,
      current_phase: normalizePhaseLabel(letters?.[0]?.phase),
      detailed_phase: letters?.[0]?.phase ?? null,
      latest_letter: letters?.[0] || null,
      recent_letters: letters || [],
      outstanding_total: openLedger.reduce((sum, entry) => sum + Number(entry.amount || 0), 0),
      outstanding_entries: openLedger
    });
  } catch (error) {
    return `Error building client snapshot for ${name}: ${error.message}`;
  }
}

async function calculateFinancialMetrics() {
  const db = initSupabase();
  if (!db) return "Error: Database connection not configured.";

  try {
    const { data: clients, error } = await db.from('clients')
      .select('billing_status, billing_type, billing_tier, ledger, referral_fee, commission_paid');
    if (error) throw error;
    
    let outstanding = 0;
    let collected30Days = 0;
    let estMRR = 0;
    let lifetimeRevenue = 0;
    let commissionOwed = 0;
    
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    for (const client of clients) {
       // Estimate MRR based on active clients
       if (client.billing_status === 'Active' && client.billing_type === 'Automated Recurring') {
          let mrrContribution = 0;
          if (client.ledger && Array.isArray(client.ledger)) {
             const monthlyPayments = client.ledger.filter(l => l.status === 'Paid' && l.amount > 0 && 
                (l.description.toLowerCase().includes('monthly') || l.description.toLowerCase().includes('membership')));
             if (monthlyPayments.length > 0) {
                 const sorted = monthlyPayments.sort((a,b) => new Date(b.date) - new Date(a.date));
                 mrrContribution = sorted[0].amount;
             }
          }
          estMRR += mrrContribution;
       }
       
       // Calculate ledger metrics
       if (client.ledger && Array.isArray(client.ledger)) {
           for (const entry of client.ledger) {
               const amt = entry.amount || 0;
               if (isOutstanding(entry.status)) outstanding += amt;
               
               if (entry.status === 'Paid') {
                   lifetimeRevenue += amt;
                   const entryDate = getLedgerTransactionDate(entry);
                   if (entryDate && entryDate >= thirtyDaysAgo) collected30Days += amt;
               }
           }
       }
       
       // Calculate commissions
       const referralFee = client.referral_fee || 0;
       if (referralFee > 0 && client.commission_paid !== true) commissionOwed += referralFee;
    }
    
    return JSON.stringify({
       outstanding: `$${outstanding.toFixed(2)}`,
       collected_30_days: `$${collected30Days.toFixed(2)}`,
       est_mrr: `$${estMRR.toFixed(2)}`,
       lifetime_revenue: `$${lifetimeRevenue.toFixed(2)}`,
       commission_owed: `$${commissionOwed.toFixed(2)}`
    }, null, 2);
  } catch(error) {
     return `Error calculating financials: ${error.message}`;
  }
}

async function getOverdueClients(daysThreshold = 3) {
  const db = initSupabase();
  if (!db) return [];

  try {
    const { data: clients, error } = await db.from('clients')
      .select('id, name, billing_status, ledger');
    if (error) throw error;

    const now = new Date();
    const overdue = [];

    for (const client of clients || []) {
      if (!client.ledger || !Array.isArray(client.ledger)) continue;

      for (const entry of client.ledger) {
        if (!isOutstanding(entry.status)) continue;
        if (!(entry.amount > 0)) continue;

        const dueDate = new Date(entry.due_date || entry.date || entry.created_at);
        if (isNaN(dueDate.getTime())) continue;

        const daysOverdue = Math.floor((now - dueDate) / 86400000);
        if (daysOverdue >= daysThreshold) {
          overdue.push({
            client: client.name || `Client #${client.id}`,
            amount: entry.amount,
            daysOverdue
          });
        }
      }
    }

    return overdue;
  } catch (error) {
    console.error('Error fetching overdue clients:', error.message);
    return [];
  }
}

// Only rows that are unmistakably scratch data may ever be deleted. Both the
// client name and the furnisher must look like test records, and the letter
// must never have been mailed - a mailed letter is a real artifact of a real
// dispute, whatever it happens to be named.
const TEST_RECORD_PATTERN = /\b(test|delete me|dummy|sample)\b/i;

function describeLetter(letter) {
  return {
    id: letter.id,
    client_name: letter.client_name,
    furnisher: letter.furnisher,
    phase: letter.phase,
    date: letter.date,
    mailed_date: letter.mailed_date
  };
}

// Explains, in full, why a letter may or may not be deleted. Returns
// { ok: true, letter } or { ok: false, reason } - never throws for a
// non-deletable row, because the caller needs to tell the user why.
async function inspectDeletableTestLetter(letterId) {
  const db = initSupabase();
  if (!db) return { ok: false, reason: 'Database connection not configured.' };

  if (typeof letterId !== 'string' || !letterId.trim()) {
    return { ok: false, reason: 'A specific letter id is required.' };
  }

  const { data, error } = await db.from('letters').select('*').eq('id', letterId.trim());
  if (error) return { ok: false, reason: `Could not read letter: ${error.message}` };
  if (!data || data.length === 0) {
    return { ok: false, reason: `No letter exists with id "${letterId}".` };
  }
  if (data.length > 1) {
    return { ok: false, reason: 'That id matched more than one letter; refusing to act.' };
  }

  const letter = data[0];

  if (letter.mailed_date) {
    return {
      ok: false,
      reason: `Letter "${letter.id}" was mailed on ${letter.mailed_date}. Mailed letters are real dispute records and cannot be deleted.`
    };
  }
  if (!TEST_RECORD_PATTERN.test(letter.client_name || '')) {
    return {
      ok: false,
      reason: `Client "${letter.client_name}" is not a test record. Only test letters can be deleted.`
    };
  }
  if (!TEST_RECORD_PATTERN.test(letter.furnisher || '')) {
    return {
      ok: false,
      reason: `Furnisher "${letter.furnisher}" is not a test record. Only test letters can be deleted.`
    };
  }

  return { ok: true, letter };
}

// Lists the test letters that are currently eligible for deletion.
async function listDeletableTestLetters() {
  const db = initSupabase();
  if (!db) return "Error: Database connection not configured.";

  try {
    const { data, error } = await db.from('letters').select('*').is('mailed_date', null);
    if (error) throw error;

    const eligible = (data || [])
      .filter(letter =>
        TEST_RECORD_PATTERN.test(letter.client_name || '') &&
        TEST_RECORD_PATTERN.test(letter.furnisher || ''))
      .map(describeLetter);

    return JSON.stringify({ deletable_test_letters: eligible, count: eligible.length });
  } catch (error) {
    return `Error listing test letters: ${error.message}`;
  }
}

// Records a proposed deletion in aura_actions. Stored in the database rather
// than in process memory so a staged deletion survives a restart - Render's free
// tier sleeps after inactivity, which silently discarded in-memory proposals
// between the owner being asked and the owner answering.
async function stageTestLetterDeletion(letterId, proposedAtMs, { agentId = 'aura_core' } = {}) {
  const db = initSupabase();
  if (!db) return { ok: false, reason: 'Database connection not configured.' };

  const inspection = await inspectDeletableTestLetter(letterId);
  if (!inspection.ok) return inspection;

  const { error } = await db.from('aura_actions').insert({
    owner_id: process.env.AURA_OWNER_ID || null,
    agent_id: agentId,
    tool_name: 'confirm_test_letter_deletion',
    arguments: { table: 'letters', letter_id: inspection.letter.id, proposed_at_ms: proposedAtMs },
    risk_level: 'destructive_write',
    requires_approval: true,
    status: 'proposed'
  });

  if (error) return { ok: false, reason: `Could not stage the deletion: ${error.message}` };
  return { ok: true, letter: inspection.letter };
}

// Finds the newest still-open proposal for a letter.
async function findStagedDeletion(letterId) {
  const db = initSupabase();
  if (!db) return null;

  const { data } = await db.from('aura_actions').select('id, arguments, created_at')
    .eq('tool_name', 'confirm_test_letter_deletion')
    .eq('status', 'proposed')
    .order('created_at', { ascending: false })
    .limit(25);

  return (data || []).find(row => row.arguments?.letter_id === letterId) || null;
}

async function listStagedDeletionIds() {
  const db = initSupabase();
  if (!db) return [];

  const { data } = await db.from('aura_actions').select('arguments')
    .eq('tool_name', 'confirm_test_letter_deletion')
    .eq('status', 'proposed')
    .order('created_at', { ascending: false })
    .limit(25);

  return [...new Set((data || []).map(row => row.arguments?.letter_id).filter(Boolean))];
}

async function discardStagedDeletion(actionId) {
  const db = initSupabase();
  if (!db) return;
  await db.from('aura_actions').update({ status: 'rejected' }).eq('id', actionId);
}

// Deletes a single test letter, recording a full snapshot first so the row can
// be reconstructed. Re-checks eligibility here rather than trusting the caller.
async function deleteTestLetter(letterId, {
  actor,
  actorModel,
  userInstruction,
  actionId,
  agentId = 'aura_core'
} = {}) {
  const db = initSupabase();
  if (!db) return { ok: false, reason: 'Database connection not configured.' };

  const inspection = await inspectDeletableTestLetter(letterId);
  if (!inspection.ok) return inspection;

  const { letter } = inspection;
  const ownerId = process.env.AURA_OWNER_ID || null;
  const approvedAt = new Date().toISOString();

  // Mark the existing proposal approved, or fall back to writing a fresh audit
  // row. Either way there is an audit record before anything is destroyed.
  let action;
  if (actionId) {
    const { data, error } = await db.from('aura_actions')
      .update({ status: 'executing', approved_by: ownerId, approved_at: approvedAt })
      .eq('id', actionId).eq('status', 'proposed')
      .select('id').maybeSingle();
    if (error || !data) {
      return { ok: false, reason: 'The staged deletion was already used or withdrawn, so nothing was deleted.' };
    }
    action = data;
  } else {
    const { data, error } = await db.from('aura_actions').insert({
      owner_id: ownerId,
      agent_id: agentId,
      tool_name: 'confirm_test_letter_deletion',
      arguments: { table: 'letters', letter_id: letter.id, instruction: userInstruction || null },
      risk_level: 'destructive_write',
      requires_approval: true,
      status: 'executing',
      approved_by: ownerId,
      approved_at: approvedAt
    }).select('id').single();
    if (error) {
      return { ok: false, reason: `Could not write the deletion audit record, so nothing was deleted: ${error.message}` };
    }
    action = data;
  }

  const { error: deleteError } = await db.from('letters').delete().eq('id', letter.id);

  if (deleteError) {
    await db.from('aura_actions')
      .update({ status: 'failed', error: deleteError.message, executed_at: new Date().toISOString() })
      .eq('id', action.id);
    return { ok: false, reason: `Nothing was deleted: ${deleteError.message}` };
  }

  // Keep the full row in the audit record so the letter can be reconstructed.
  const executedAt = new Date().toISOString();
  await db.from('aura_actions')
    .update({
      status: 'succeeded',
      executed_at: executedAt,
      result: { deleted_by: actor || 'AURA', actor_model: actorModel || null, record_snapshot: letter }
    })
    .eq('id', action.id);

  return { ok: true, deleted: describeLetter(letter), auditId: action.id, deletedAt: executedAt };
}

module.exports = {
  listTables,
  getTableSchema,
  queryTable,
  countRows,
  inspectDeletableTestLetter,
  listDeletableTestLetters,
  stageTestLetterDeletion,
  findStagedDeletion,
  listStagedDeletionIds,
  discardStagedDeletion,
  deleteTestLetter,
  TEST_RECORD_PATTERN,
  getOutstandingBalances,
  calculateFinancialMetrics,
  getOverdueClients,
  getClientSnapshot,
  normalizeClientName,
  scoreClientName,
  rankClientMatches,
  suggestClientMatches,
  correctTranscriptClientNames,
  correctOwnerTextClientNames,
  isCommonEnglishWord,
  loadClientDirectory,
  clearClientDirectoryCache,
  getClientCurrentPhase,
  normalizePhaseLabel,
  isOutstanding,
  getLedgerTransactionDate,
  getRecentBusinessActivity
};
