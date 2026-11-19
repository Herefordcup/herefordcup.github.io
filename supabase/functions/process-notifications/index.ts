import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

export function timingSafeEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let mismatch = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

Deno.serve(async request => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const workerSecret = Deno.env.get('NOTIFICATION_WORKER_SECRET') ?? '';
  const suppliedSecret = request.headers.get('x-notification-secret') ?? '';
  if (!workerSecret || !timingSafeEqual(workerSecret, suppliedSecret)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) return json({ error: 'Server configuration incomplete' }, 500);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let input: Record<string, unknown>;
  try {
    input = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (input.action === 'claim') {
    const requestedLimit = Number(input.limit ?? 20);
    const limit = Number.isInteger(requestedLimit) ? Math.min(50, Math.max(1, requestedLimit)) : 20;
    const { data: deliveries, error: claimError } = await supabase.rpc('claim_notification_deliveries', {
      target_limit: limit,
    });
    if (claimError) return json({ error: 'Unable to claim notifications' }, 500);

    const messages = [];
    const rejected = [];
    for (const delivery of deliveries ?? []) {
      const { data, error } = await supabase.auth.admin.getUserById(delivery.recipient_user_id);
      const recipient = data?.user?.email?.trim();
      if (error || !recipient) {
        rejected.push({
          delivery_id: delivery.delivery_id,
          status: 'failed',
          error: 'Recipient account has no deliverable email address',
        });
        continue;
      }
      messages.push({
        delivery_id: delivery.delivery_id,
        to: recipient,
        subject: delivery.subject,
        body: delivery.body,
      });
    }

    if (rejected.length) {
      const { error: rejectError } = await supabase.rpc('complete_notification_deliveries', {
        delivery_results: rejected,
      });
      if (rejectError) return json({ error: 'Unable to record rejected notifications' }, 500);
    }
    return json({ messages });
  }

  if (input.action === 'complete') {
    const results = input.results;
    if (!Array.isArray(results) || results.length > 50) {
      return json({ error: 'Results must be an array of at most 50 items' }, 400);
    }
    if (results.some(result =>
      !result || typeof result !== 'object'
      || !UUID_PATTERN.test(String(result.delivery_id ?? ''))
      || !['sent', 'failed'].includes(String(result.status ?? ''))
    )) {
      return json({ error: 'Each result requires a valid delivery ID and status' }, 400);
    }
    const sanitizedResults = results.map(result => ({
      delivery_id: String(result?.delivery_id ?? ''),
      status: String(result?.status),
      error: String(result?.error ?? '').slice(0, 500),
    }));
    const { error } = await supabase.rpc('complete_notification_deliveries', {
      delivery_results: sanitizedResults,
    });
    if (error) return json({ error: 'Unable to complete notifications' }, 500);
    return json({ completed: sanitizedResults.length });
  }

  return json({ error: 'Unsupported action' }, 400);
});
