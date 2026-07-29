const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const path = require('path');
const cron = require('node-cron');
const fs = require('fs');
const compression = require('compression');
const multer = require('multer');
const crypto = require('crypto');
const os = require('os');
const scraper = require('./scraper');
const mac = require('./mac_integration');
const ccc = require('./ccc_database');

const upload = multer({ dest: 'uploads/' });

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite Database
const db = new Database('aura.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS finances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL NOT NULL,
    category TEXT NOT NULL,
    description TEXT,
    date DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS alert_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
// Migration for databases created before goals.created_at existed
// SQLite disallows a non-constant (CURRENT_TIMESTAMP) default in ALTER TABLE ADD COLUMN,
// so the column is added bare here and backfilled separately.
try { db.exec("ALTER TABLE goals ADD COLUMN created_at DATETIME"); } catch (e) { /* column already exists */ }
db.exec("UPDATE goals SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL");

// AI Setup
const aiProvider = process.env.AI_PROVIDER || 'openai';

let openai;
let chatModel;

if (aiProvider === 'deepseek') {
  openai = new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY || 'dummy_key'
  });
  chatModel = 'deepseek-chat';
} else {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'dummy_key'
  });
  chatModel = 'gpt-4o-mini';
}

const openaiEmbeddings = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'dummy_openai_key'
});

const MEMORY_FILE = 'semantic_memory.json';
if (!fs.existsSync(MEMORY_FILE)) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify([]));
}

function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function getEmbedding(text) {
  const response = await openaiEmbeddings.embeddings.create({
    model: 'text-embedding-3-small',
    input: text
  });
  return response.data[0].embedding;
}

async function saveSemanticMemory(content) {
  const embedding = await getEmbedding(content);
  const memories = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  memories.push({ content, embedding, timestamp: new Date().toISOString() });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memories));
  return 'Memory saved semantically.';
}

async function querySemanticMemory(query, topK = 3) {
  const queryEmbedding = await getEmbedding(query);
  const memories = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  
  if (memories.length === 0) return [];
  
  const scoredMemories = memories.map(mem => ({
    content: mem.content,
    score: cosineSimilarity(queryEmbedding, mem.embedding)
  }));
  
  scoredMemories.sort((a, b) => b.score - a.score);
  return scoredMemories.slice(0, topK).map(m => m.content);
}

// --- Proactive Agency: state tracking + alert dispatch --- //

function getAlertState(key) {
  const row = db.prepare('SELECT value FROM alert_state WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

function setAlertState(key, value) {
  db.prepare(`
    INSERT INTO alert_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, JSON.stringify(value));
}

function sendProactiveAlert(text) {
  console.log('[Proactive Alert]', text);
  io.emit('proactive-alert', { text });
}

// Define Tools for DeepSeek
const tools = [
  {
    type: 'function',
    function: {
      name: 'list_database_tables',
      description: 'Lists all available tables and views in the Supabase database.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_table_schema',
      description: 'Gets the column names and data types for a specific database table.',
      parameters: {
        type: 'object',
        properties: {
          table_name: { type: 'string', description: 'The name of the table to inspect' }
        },
        required: ['table_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_database_table',
      description: 'Queries a specific database table and returns the raw JSON data. You can optionally filter the data by providing an array of filter objects (e.g. [{"column": "status", "value": "active"}]).',
      parameters: {
        type: 'object',
        properties: {
          table_name: { type: 'string', description: 'The name of the table to query' },
          limit: { type: 'number', description: 'The maximum number of rows to return (default 50)' },
          filters: { 
            type: 'array', 
            description: 'Optional filters to apply to the query',
            items: {
              type: 'object',
              properties: {
                column: { type: 'string' },
                value: { type: 'string' }
              }
            }
          }
        },
        required: ['table_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_email',
      description: 'Reads the most recent unread emails from the users Apple Mail app (which includes iCloud, Gmail, etc. if synced). Returns the sender, subject, and a short snippet.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_calendar',
      description: 'Reads the users scheduled events for today and tomorrow from the native Apple Calendar app.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_goal',
      description: 'Add a new goal to the users goal tracker.',
      parameters: {
        type: 'object',
        properties: { description: { type: 'string', description: 'The goal description' } },
        required: ['description']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_goal_status',
      description: 'Update the status of an existing goal.',
      parameters: {
        type: 'object',
        properties: { 
          id: { type: 'number', description: 'The goal ID' },
          status: { type: 'string', description: 'The new status (e.g., completed, pending)' }
        },
        required: ['id', 'status']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_goals',
      description: 'Retrieve the users current goals.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'log_finance',
      description: 'Log an expense or income.',
      parameters: {
        type: 'object',
        properties: { 
          amount: { type: 'number', description: 'The amount (negative for expense, positive for income)' },
          category: { type: 'string', description: 'Category (e.g. food, rent)' },
          description: { type: 'string', description: 'Optional detail' }
        },
        required: ['amount', 'category']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_finances',
      description: 'Get a summary of recent finances.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of recent logs to fetch' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_blackboard',
      description: 'Scrape Blackboard to find upcoming assignments and deadlines.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Search the internet for real-time information, news, weather, or facts.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query to look up on the internet.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calculate_financial_metrics',
      description: 'Calculates the real-time financial metrics for the business including MRR, Outstanding Balance, 30-Day Collected, and Lifetime Revenue.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_semantic_memory',
      description: 'Save an important fact, preference, or event about the user for long-term recall using semantic search.',
      parameters: {
        type: 'object',
        properties: { fact: { type: 'string', description: 'The fact or memory to save' } },
        required: ['fact']
      }
    }
  }
];

// Tool Executors
async function handleToolCall(toolCall) {
  const args = JSON.parse(toolCall.function.arguments);
  switch (toolCall.function.name) {
    case 'add_goal':
      db.prepare("INSERT INTO goals (description, created_at) VALUES (?, CURRENT_TIMESTAMP)").run(args.description);
      return `Goal added: ${args.description}`;
    case 'update_goal_status':
      db.prepare('UPDATE goals SET status = ? WHERE id = ?').run(args.status, args.id);
      return `Goal ${args.id} updated to ${args.status}`;
    case 'get_goals':
      const goals = db.prepare("SELECT * FROM goals WHERE status != 'completed'").all();
      return JSON.stringify(goals);
    case 'log_finance':
      db.prepare('INSERT INTO finances (amount, category, description) VALUES (?, ?, ?)')
        .run(args.amount, args.category, args.description || '');
      return `Logged finance: $${args.amount} for ${args.category}`;
    case 'query_finances':
      const logs = db.prepare('SELECT * FROM finances ORDER BY id DESC LIMIT ?').all(args.limit || 5);
      return JSON.stringify(logs);
    case 'check_blackboard':
      const assignments = await scraper.checkBlackboardAssignments();
      return `I checked Blackboard and found the following: ${JSON.stringify(assignments)}`;
    case 'check_email':
      const emails = await mac.getUnreadEmails();
      return `I checked your Apple Mail inbox. Here are the unread emails:\n${emails}`;
    case 'check_calendar':
      const events = await mac.getTodaysCalendar();
      return `I checked your Apple Calendar. Here are the events:\n${events}`;
    case 'list_database_tables':
      const tables = await ccc.listTables();
      return `Here are the tables in the database:\n${tables}`;
    case 'get_table_schema':
      const schema = await ccc.getTableSchema(args.table_name);
      return `Schema for ${args.table_name}:\n${schema}`;
    case 'query_database_table':
      const data = await ccc.queryTable(args.table_name, args.limit, args.filters);
      return `Data from ${args.table_name}:\n${data}`;
    case 'calculate_financial_metrics':
      const metrics = await ccc.calculateFinancialMetrics();
      return `Here are the real-time financial metrics for the business:\n${metrics}`;
    case 'search_web':
      const results = await scraper.searchWeb(args.query);
      return `Here are the top search results from the web for "${args.query}":\n\n${results}`;
    case 'save_semantic_memory':
      return await saveSemanticMemory(args.fact);
    default:
      return 'Unknown tool';
  }
}

// --- API Routes --- //

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) throw new Error('No audio file provided.');
    
    // Multer strips file extensions. OpenAI requires an extension to process audio.
    const originalExt = path.extname(req.file.originalname) || '.webm';
    const newPath = req.file.path + originalExt;
    fs.renameSync(req.file.path, newPath);
    
    const audioFile = fs.createReadStream(newPath);
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
    });
    
    fs.unlinkSync(newPath); // cleanup
    res.json({ transcript: transcription.text });
  } catch (error) {
    console.error('Transcription error:', error);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { text } = req.body;
    db.prepare('INSERT INTO memory (role, content) VALUES (?, ?)').run('user', text);
    
    // Perform semantic search on user text to get relevant past memories
    const relevantMemories = await querySemanticMemory(text);
    const semanticContext = relevantMemories.length > 0 
      ? `\nRelevant Past Context:\n${relevantMemories.map(m => `- ${m}`).join('\n')}`
      : '';
    
    // Retrieve recent conversation context
    const messages = db.prepare(`
      SELECT role, content FROM memory 
      WHERE id IN (SELECT id FROM memory WHERE role != 'system' ORDER BY id DESC LIMIT 15)
      ORDER BY id ASC
    `).all();
    
    const systemPrompt = {
      role: 'system',
      content: 'You are AURA, a highly intelligent, proactive, and concise personal AI operating system. You have tools to manage finances, goals, save core memories, and search the live internet. If asked for real-time info, you MUST use your search_web tool. \n\nCRITICAL: You have access to semantic memory. You must proactively reason against past memories. If a user tells you something that conflicts or interacts with a past memory (e.g. canceling a gym session when they previously said the gym destresses them), you MUST bring it up and act as a proactive, reasoning partner. Keep voice responses conversational. Do not output markdown, as it will be spoken.' + semanticContext
    };

    const chatHistory = [systemPrompt, ...messages];

    let response = await openai.chat.completions.create({
      model: chatModel,
      messages: chatHistory,
      tools: tools,
      tool_choice: 'auto'
    });

    const responseMessage = response.choices[0].message;

    // Handle Tool Calls
    if (responseMessage.tool_calls) {
      chatHistory.push(responseMessage);
      for (const toolCall of responseMessage.tool_calls) {
        const functionResult = await handleToolCall(toolCall);
        chatHistory.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: functionResult,
        });
      }
      
      // Get final response after tools
      response = await openai.chat.completions.create({
        model: chatModel,
        messages: chatHistory
      });
    }
    
    const reply = response.choices[0].message.content;
    db.prepare('INSERT INTO memory (role, content) VALUES (?, ?)').run('assistant', reply);
    
    res.json({ reply });
  } catch (error) {
    console.error('Error in /api/chat:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/tts', async (req, res) => {
  try {
    const { text } = req.body;
    const response = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        'Cartesia-Version': '2024-06-10',
        'X-API-Key': process.env.CARTESIA_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model_id: 'sonic-3.5',
        transcript: text,
        voice: { mode: 'id', id: 'e8e5fffb-252c-436d-b842-8879b84445b6' },
        output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 }
      })
    });
    
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Cartesia API error: ${response.status} - ${errText}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    res.set('Content-Type', 'audio/wav');
    res.send(Buffer.from(arrayBuffer));
  } catch (error) {
    console.error('Error in /api/tts:', error);
    res.status(500).json({ error: error.message });
  }
});

// WebSockets & Proactive Agency
io.on('connection', (socket) => {
  console.log('Frontend connected for proactive alerts.');
});

// --- Proactive Agency: Cron Jobs --- //
// These run unattended and push spoken alerts to any connected frontend via
// the 'proactive-alert' socket event, without the user having to ask first.

// Business health check, twice daily: newly-overdue clients + meaningful
// swings in outstanding balance / MRR since the last check.
cron.schedule('0 8,16 * * *', async () => {
  console.log('[Cron] Running business health check...');
  try {
    const overdue = await ccc.getOverdueClients(3);
    if (Array.isArray(overdue)) {
      const previousNames = new Set(getAlertState('overdue_clients') || []);
      const currentNames = overdue.map(o => o.client);
      const newlyOverdue = overdue.filter(o => !previousNames.has(o.client));

      if (newlyOverdue.length > 0) {
        const list = newlyOverdue.map(o => `${o.client} ($${o.amount}, ${o.daysOverdue} days overdue)`).join(', ');
        sendProactiveAlert(
          newlyOverdue.length === 1
            ? `Heads up — ${list} just crossed into overdue status.`
            : `Heads up — ${newlyOverdue.length} clients just crossed into overdue status: ${list}.`
        );
      }
      setAlertState('overdue_clients', currentNames);
    }

    const metricsJson = await ccc.calculateFinancialMetrics();
    if (typeof metricsJson === 'string' && !metricsJson.startsWith('Error')) {
      const parsed = JSON.parse(metricsJson);
      const previous = getAlertState('financial_metrics');

      if (previous) {
        const toNumber = (v) => parseFloat(String(v).replace(/[^0-9.-]/g, '')) || 0;
        const prevOutstanding = toNumber(previous.outstanding);
        const currOutstanding = toNumber(parsed.outstanding);
        const prevMRR = toNumber(previous.est_mrr);
        const currMRR = toNumber(parsed.est_mrr);

        if (Math.abs(currOutstanding - prevOutstanding) >= 100) {
          const direction = currOutstanding > prevOutstanding ? 'risen' : 'fallen';
          sendProactiveAlert(`Outstanding balance has ${direction} to ${parsed.outstanding}, from ${previous.outstanding} last check.`);
        }
        if (currMRR < prevMRR) {
          sendProactiveAlert(`Heads up — estimated MRR dropped from ${previous.est_mrr} to ${parsed.est_mrr}.`);
        }
      }
      setAlertState('financial_metrics', parsed);
    }
  } catch (error) {
    console.error('Error in scheduled business check:', error);
  }
});

// Blackboard deadline check, once daily in the morning. Only speaks up if
// the page actually changed since last time and something is due soon.
cron.schedule('0 7 * * *', async () => {
  console.log('[Cron] Running scheduled Blackboard check...');
  try {
    const scraped = await scraper.checkBlackboardAssignments();
    if (!scraped || typeof scraped !== 'string' || scraped.length < 50) return;

    const currentHash = crypto.createHash('sha1').update(scraped).digest('hex');
    if (currentHash === getAlertState('blackboard_hash')) return;
    setAlertState('blackboard_hash', currentHash);

    const summary = await openai.chat.completions.create({
      model: chatModel,
      messages: [
        {
          role: 'system',
          content: 'You monitor a students Blackboard/university portal page for upcoming assignment deadlines. Given the raw scraped page text, respond with ONE short spoken sentence naming only deadlines due within the next 3 days. Do not use markdown. If nothing is due within 3 days, respond with exactly: NONE'
        },
        { role: 'user', content: scraped }
      ]
    });

    const text = summary.choices[0].message.content.trim();
    if (text && text.toUpperCase() !== 'NONE') {
      sendProactiveAlert(text);
    }
  } catch (error) {
    console.error('Error in scheduled Blackboard check:', error);
  }
});

// Stale goals nudge, once a week: anything still open after 14 days gets
// surfaced so it doesn't just quietly rot in the tracker.
cron.schedule('0 9 * * 1', () => {
  console.log('[Cron] Running stale goals check...');
  try {
    const staleGoals = db.prepare(`
      SELECT * FROM goals
      WHERE status != 'completed'
      AND created_at <= datetime('now', '-14 days')
    `).all();

    if (staleGoals.length > 0) {
      const list = staleGoals.map(g => g.description).join('; ');
      sendProactiveAlert(`You have ${staleGoals.length} goal${staleGoals.length > 1 ? 's' : ''} that have been open for over two weeks: ${list}. Want to update or drop any of them?`);
    }
  } catch (error) {
    console.error('Error in stale goals check:', error);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`AURA server running on http://localhost:${PORT}`);

  // Print the LAN address too, so it's easy to open from a phone on the
  // same Wi-Fi without hunting for the machine's IP separately.
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`On your local network:  http://${net.address}:${PORT}`);
      }
    }
  }
});
