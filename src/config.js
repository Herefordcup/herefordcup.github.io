export const SUPABASE_URL = 'https://mqulycovrogurvmjcimt.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_NBfdYAh6H_oTiYaRKixIbA_J7msoRjk';

export function hasSupabaseConfig() {
  return /^https:\/\/.+\.supabase\.co$/.test(SUPABASE_URL)
    && SUPABASE_PUBLISHABLE_KEY.length > 20;
}
