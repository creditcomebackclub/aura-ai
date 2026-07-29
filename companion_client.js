const { createClient } = require('@supabase/supabase-js');

class CompanionClient {
  constructor({ url, serviceKey, ownerId = null, targetDevice = 'chriss-macbook-pro' }) {
    this.supabase = createClient(url, serviceKey);
    this.ownerId = ownerId;
    this.targetDevice = targetDevice;
  }

  async execute(capability, request = {}, timeoutMs = 75000) {
    const { data: job, error } = await this.supabase
      .from('aura_companion_jobs')
      .insert({
        owner_id: this.ownerId,
        target_device: this.targetDevice,
        capability,
        request,
        expires_at: new Date(Date.now() + timeoutMs + 15000).toISOString()
      })
      .select('id')
      .single();
    if (error) throw new Error(`Could not queue Mac job: ${error.message}`);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const { data, error: pollError } = await this.supabase
        .from('aura_companion_jobs')
        .select('status, result, error')
        .eq('id', job.id)
        .single();
      if (pollError) throw pollError;
      if (data.status === 'succeeded') return data.result?.text || '';
      if (['failed', 'expired', 'cancelled'].includes(data.status)) {
        throw new Error(data.error || `Mac job ${data.status}`);
      }
    }
    throw new Error('The Mac companion did not answer before the timeout.');
  }
}

module.exports = { CompanionClient };
