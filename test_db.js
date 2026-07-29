require('dotenv').config();
const ccc = require('./ccc_database');

async function test() {
  console.log("--- Tables ---");
  const tables = await ccc.listTables();
  console.log(tables);
  
  // Try to parse tables and find billing
  let parsed = [];
  try { parsed = JSON.parse(tables); } catch(e) {}
  
  const billingTable = parsed.find(t => t.table_name.includes('bill') || t.table_name.includes('invoice') || t.table_name.includes('client'));
  if (billingTable) {
    console.log(`\n--- Schema for ${billingTable.table_name} ---`);
    const schema = await ccc.getTableSchema(billingTable.table_name);
    console.log(schema);
    
    console.log(`\n--- Query ${billingTable.table_name} ---`);
    const data = await ccc.queryTable(billingTable.table_name, 1, []);
    console.log(data);
  }
}

test();
