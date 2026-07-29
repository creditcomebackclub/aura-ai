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

async function findClientsByName(name) {
  const db = initSupabase();
  if (!db) return { error: 'Database connection not configured.' };
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  let query = db.from('clients').select('id, name, status, billing_status, billing_tier, ledger');
  for (const word of words) query = query.ilike('name', `%${word}%`);
  const { data, error } = await query.limit(10);
  return error ? { error: error.message } : { data: data || [] };
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
    const clients = await findClientsByName(name);
    if (clients.error) throw new Error(clients.error);
    if (clients.data.length === 0) return JSON.stringify({ found: false, query: name });
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
    const clients = await findClientsByName(name);
    if (clients.error) throw new Error(clients.error);
    if (clients.data.length === 0) return JSON.stringify({ found: false, query: name });
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

module.exports = {
  listTables,
  getTableSchema,
  queryTable,
  countRows,
  getOutstandingBalances,
  calculateFinancialMetrics,
  getOverdueClients,
  getClientSnapshot,
  getClientCurrentPhase,
  normalizePhaseLabel,
  isOutstanding,
  getLedgerTransactionDate
};
