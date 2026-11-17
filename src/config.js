export const SUPABASE_URL = '';
export const SUPABASE_PUBLISHABLE_KEY = '';

export function hasSupabaseConfig() {
  return /^https:\/\/.+\.supabase\.co$/.test(SUPABASE_URL)
    && SUPABASE_PUBLISHABLE_KEY.length > 20;
}
