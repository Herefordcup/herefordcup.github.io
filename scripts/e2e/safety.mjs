export function assertDisposableSupabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('E2E requires a disposable loopback Supabase URL.');
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  if (parsed.protocol !== 'http:' || !loopback || parsed.port !== '54321') {
    throw new Error('E2E requires a disposable loopback Supabase URL on port 54321.');
  }
  return parsed.origin;
}

export function runtimeConfigSource(supabaseUrl, publishableKey) {
  const safeUrl = assertDisposableSupabaseUrl(supabaseUrl);
  if (!publishableKey) throw new Error('E2E requires the local Supabase publishable key.');
  return `export const SUPABASE_URL = ${JSON.stringify(safeUrl)};
export const SUPABASE_PUBLISHABLE_KEY = ${JSON.stringify(publishableKey)};

export function hasSupabaseConfig() {
  return SUPABASE_URL.startsWith('http://127.0.0.1:') || SUPABASE_URL.startsWith('http://localhost:');
}
`;
}
