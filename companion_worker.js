const { createClient } = require('@supabase/supabase-js');
const mac = require('./mac_integration');
require('dotenv').config({ quiet: true });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const targetDevice = process.env.AURA_COMPANION_DEVICE || 'chriss-macbook-pro';
const pollInterval = Math.max(2000, Number(process.env.AURA_COMPANION_POLL_MS) || 5000);
let stopping = false;

async function executeCapability(capability) {
  switch (capability) {
    case 'check_email':
      return await mac.getUnreadEmails();
    case 'check_calendar':
      return await mac.getTodaysCalendar();
    default:
      throw new Error(`Unsupported Mac companion capability: ${capability}`);
  }
}

async function claimNextJob() {
  const { data: queued, error } = await supabase
    .from('aura_companion_jobs')
    .select('id, capability, request, expires_at')
    .eq('target_device', targetDevice)
    .eq('status', 'queued')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  if (!queued?.length) return null;

  const job = queued[0];
  const { data: claimed, error: claimError } = await supabase
    .from('aura_companion_jobs')
    .update({ status: 'claimed', claimed_at: new Date().toISOString() })
    .eq('id', job.id)
    .eq('status', 'queued')
    .select('id, capability, request')
    .maybeSingle();
  if (claimError) throw claimError;
  return claimed;
}

async function processJob(job) {
  try {
    const result = await executeCapability(job.capability);
    const { error } = await supabase.from('aura_companion_jobs').update({
      status: 'succeeded',
      result: { text: result },
      completed_at: new Date().toISOString()
    }).eq('id', job.id);
    if (error) throw error;
  } catch (error) {
    await supabase.from('aura_companion_jobs').update({
      status: 'failed',
      error: error.message,
      completed_at: new Date().toISOString()
    }).eq('id', job.id);
  }
}

async function loop() {
  console.log(`[Companion] Listening as ${targetDevice}`);
  while (!stopping) {
    try {
      const job = await claimNextJob();
      if (job) {
        console.log(`[Companion] Running ${job.capability} (${job.id})`);
        await processJob(job);
      }
    } catch (error) {
      console.error('[Companion] Poll failed:', error.message);
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
}

process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
loop().catch(error => {
  console.error('[Companion] Fatal error:', error);
  process.exit(1);
});
