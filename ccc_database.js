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
    const { data, error } = await db.from('information_schema.tables')
      .select('table_name, table_type')
      .eq('table_schema', 'public');
    
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
    const { data, error } = await db.from('information_schema.columns')
      .select('column_name, data_type')
      .eq('table_schema', 'public')
      .eq('table_name', tableName);
      
    if (error) throw error;
    return JSON.stringify(data);
  } catch (error) {
    return `Error fetching schema for ${tableName}: ${error.message}`;
  }
}

async function queryTable(tableName, limit = 50, filters = []) {
  const db = initSupabase();
  if (!db) return "Error: Database connection not configured.";

  try {
    let query = db.from(tableName).select('*');
    
    // Apply optional simple eq filters (e.g. [{column: "status", value: "active"}])
    for (const filter of filters) {
      if (filter.column && filter.value) {
        query = query.eq(filter.column, filter.value);
      }
    }
    
    query = query.limit(limit);
    
    const { data, error } = await query;
    if (error) throw error;
    
    return JSON.stringify(data);
  } catch (error) {
    return `Error querying ${tableName}: ${error.message}`;
  }
}

async function calculateFinancialMetrics() {
  const db = initSupabase();
  if (!db) return "Error: Database connection not configured.";

  try {
    const { data: clients, error } = await db.from('clients').select('billing_status, billing_tier, ledger, referral_fee, commission_paid');
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
       if (client.billing_status === 'Active') {
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
               if (entry.status === 'Unpaid' || entry.status === 'Pending') outstanding += amt;
               
               if (entry.status === 'Paid') {
                   lifetimeRevenue += amt;
                   const entryDate = new Date(entry.paid_at || entry.created_at || entry.date);
                   if (entryDate >= thirtyDaysAgo) collected30Days += amt;
               }
           }
       }
       
       // Calculate commissions
       const referralFee = client.referral_fee || 0;
       const commissionPaid = client.commission_paid || 0;
       if (referralFee > commissionPaid) commissionOwed += (referralFee - commissionPaid);
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
        if (entry.status !== 'Unpaid' && entry.status !== 'Pending') continue;
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

module.exports = { listTables, getTableSchema, queryTable, calculateFinancialMetrics, getOverdueClients };
