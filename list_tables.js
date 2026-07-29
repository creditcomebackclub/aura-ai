require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

console.log("URL:", process.env.SUPABASE_URL);
console.log("Key:", process.env.SUPABASE_SERVICE_KEY ? process.env.SUPABASE_SERVICE_KEY.substring(0, 10) + '...' : 'MISSING');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function listTables() {
  const { data, error } = await supabase.rpc('get_tables_rpc'); // Just testing a generic request

  const { data: data2, error: error2 } = await supabase.from('information_schema.tables').select('*').limit(1);

  if (error2) {
    console.error("Error2:", error2);
  } else {
    console.log("Success2!");
  }
}

listTables();
