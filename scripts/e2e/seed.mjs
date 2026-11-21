import { assertDisposableSupabaseUrl } from './safety.mjs';

const apiUrl = assertDisposableSupabaseUrl(process.env.E2E_SUPABASE_URL);
const serviceRoleKey = process.env.E2E_SERVICE_ROLE_KEY;
const email = process.env.E2E_USER_EMAIL;
const password = process.env.E2E_USER_PASSWORD;

if (!serviceRoleKey) throw new Error('Missing local E2E service-role key.');
if (!email?.endsWith('@local.test')) throw new Error('E2E account must use the reserved @local.test domain.');
if (!password || password.length < 16) throw new Error('E2E password must be generated at runtime.');

async function request(path, { method = 'GET', body, prefer } = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

const user = await request('/auth/v1/admin/users', {
  method: 'POST',
  body: {
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: 'Disposable E2E Admin', full_name: 'Disposable E2E Admin' },
  },
});

await request(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, {
  method: 'PATCH',
  body: { display_name: 'Disposable E2E Admin', handicap_index: 9.2, role: 'admin' },
  prefer: 'return=representation',
});

const tournaments = await request('/rest/v1/tournaments', {
  method: 'POST',
  body: {
    name: 'Disposable Hereford Cup E2E',
    slug: 'disposable-hereford-cup-e2e',
    edition_year: 2099,
    starts_on: '2099-03-18',
    ends_on: '2099-03-21',
    status: 'open',
    created_by: user.id,
  },
  prefer: 'return=representation',
});
const tournament = tournaments[0];
if (!tournament?.id) throw new Error('Disposable tournament was not created.');

await request('/rest/v1/tournament_memberships?on_conflict=tournament_id,user_id', {
  method: 'POST',
  body: {
    tournament_id: tournament.id,
    user_id: user.id,
    status: 'active',
    role: 'admin',
    team: 'cardinal',
    joined_at: new Date().toISOString(),
  },
  prefer: 'resolution=merge-duplicates,return=representation',
});

console.log('Seeded one disposable administrator and tournament.');
