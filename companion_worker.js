const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const mac = require('./mac_integration');
require('dotenv').config({ quiet: true });

const ownerEmail = process.env.AURA_OWNER_EMAIL || null;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ownerId = process.env.AURA_OWNER_ID;
const targetDevice = process.env.AURA_COMPANION_DEVICE || 'chriss-macbook-pro';
const pollInterval = Math.max(2000, Number(process.env.AURA_COMPANION_POLL_MS) || 5000);
let stopping = false;
let lastMaintenanceAt = 0;

if (!ownerId) {
  throw new Error('AURA_OWNER_ID is required for the Mac companion.');
}

async function executeCapability(capability, request = {}) {
  switch (capability) {
    case 'check_email':
      return await mac.getUnreadEmails();
    case 'check_calendar':
      return await mac.getTodaysCalendar();
    case 'send_email': {
      if (!ownerEmail) throw new Error('AURA_OWNER_EMAIL is not configured on the Mac companion.');
      let attachmentPath = null;
      if (request.attachment_base64) {
        // Written under a random name inside the OS temp dir and removed
        // immediately after Mail has read it - never left sitting on disk.
        const safeName = String(request.attachment_filename || 'attachment.pdf')
          .replace(/[^a-zA-Z0-9_.-]/g, '_')
          .slice(-120);
        attachmentPath = path.join(os.tmpdir(), `aura-${crypto.randomUUID()}-${safeName}`);
        fs.writeFileSync(attachmentPath, Buffer.from(request.attachment_base64, 'base64'));
      }
      try {
        return await mac.sendEmailToOwner(ownerEmail, request.subject, request.body, attachmentPath);
      } finally {
        if (attachmentPath) fs.unlink(attachmentPath, () => {});
      }
    }
    // Distinct from 'send_email' above: this one sends to whatever address
    // the server passes in request.to, for the arbitrary-recipient tool
    // (propose_email/confirm_email). Safety here lives entirely in the
    // server's mandatory propose/confirm gate before this ever gets queued,
    // not in this function - unlike 'send_email' above, which is safe by
    // construction because it never reads a recipient off the request.
    case 'send_email_to_recipient': {
      if (!request.to) throw new Error('send_email_to_recipient requires a "to" address.');
      let attachmentPath = null;
      if (request.attachment_base64) {
        const safeName = String(request.attachment_filename || 'attachment.pdf')
          .replace(/[^a-zA-Z0-9_.-]/g, '_')
          .slice(-120);
        attachmentPath = path.join(os.tmpdir(), `aura-${crypto.randomUUID()}-${safeName}`);
        fs.writeFileSync(attachmentPath, Buffer.from(request.attachment_base64, 'base64'));
      }
      try {
        return await mac.sendEmailToOwner(request.to, request.subject, request.body, attachmentPath);
      } finally {
        if (attachmentPath) fs.unlink(attachmentPath, () => {});
      }
    }
    default:
      throw new Error(`Unsupported Mac companion capability: ${capability}`);
  }
}

async function claimNextJob() {
  const now = Date.now();
  if (now - lastMaintenanceAt >= 60000) {
    lastMaintenanceAt = now;
    const currentTimestamp = new Date(now).toISOString();
    const staleClaimTimestamp = new Date(now - 2 * 60000).toISOString();

    const { error: expireError } = await supabase
      .from('aura_companion_jobs')
      .update({ status: 'expired', completed_at: currentTimestamp })
      .eq('owner_id', ownerId)
      .eq('target_device', targetDevice)
      .in('status', ['queued', 'claimed'])
      .lt('expires_at', currentTimestamp);
    if (expireError) throw expireError;

    const { error: reclaimError } = await supabase
      .from('aura_companion_jobs')
      .update({ status: 'queued', claimed_at: null })
      .eq('owner_id', ownerId)
      .eq('target_device', targetDevice)
      .eq('status', 'claimed')
      .lt('claimed_at', staleClaimTimestamp)
      .gt('expires_at', currentTimestamp);
    if (reclaimError) throw reclaimError;
  }

  const { data: queued, error } = await supabase
    .from('aura_companion_jobs')
    .select('id, capability, request, expires_at')
    .eq('owner_id', ownerId)
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
    .eq('owner_id', ownerId)
    .eq('status', 'queued')
    .select('id, capability, request')
    .maybeSingle();
  if (claimError) throw claimError;
  return claimed;
}

async function processJob(job) {
  try {
    const result = await executeCapability(job.capability, job.request);
    const { error } = await supabase.from('aura_companion_jobs').update({
      status: 'succeeded',
      result: { text: result },
      completed_at: new Date().toISOString()
    }).eq('id', job.id).eq('owner_id', ownerId);
    if (error) throw error;
  } catch (error) {
    await supabase.from('aura_companion_jobs').update({
      status: 'failed',
      error: error.message,
      completed_at: new Date().toISOString()
    }).eq('id', job.id).eq('owner_id', ownerId);
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
