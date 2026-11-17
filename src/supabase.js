import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, hasSupabaseConfig } from './config.js';

let client;

export function validateAuthInput({ mode, displayName = '', email = '', password = '' }) {
  const errors = {};
  if (mode === 'signup' && !displayName.trim()) errors.displayName = 'Enter your name.';
  if (mode !== 'recovery' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = 'Enter a valid email address.';
  if (password.length < 8) errors.password = 'Use at least 8 characters.';
  return errors;
}

export function hasActiveTournamentMembership(memberships = []) {
  return memberships.some(membership => membership.status === 'active');
}

export function canSetNewPassword(mode, recoveryVerified) {
  return mode === 'recovery' && recoveryVerified === true;
}

export function createAuthActions(authClient, {
  emailRedirectTo,
  oauthRedirectTo,
  passwordResetRedirectTo,
} = {}) {
  return {
    async signUpWithEmail({ email, password, displayName }) {
      const normalizedName = displayName.trim();
      const { data, error } = await authClient.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          emailRedirectTo,
          data: { display_name: normalizedName, full_name: normalizedName },
        },
      });
      if (error) throw error;
      return data;
    },
    async signInWithEmail(email, password) {
      const { data, error } = await authClient.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error) throw error;
      return data;
    },
    async signInWithProvider(provider) {
      if (provider !== 'google') {
        throw new Error('Unsupported sign-in provider.');
      }
      const { data, error } = await authClient.auth.signInWithOAuth({
        provider,
        options: { redirectTo: oauthRedirectTo },
      });
      if (error) throw error;
      return data;
    },
    async requestPasswordReset(email) {
      const { data, error } = await authClient.auth.resetPasswordForEmail(
        email.trim().toLowerCase(),
        { redirectTo: passwordResetRedirectTo },
      );
      if (error) throw error;
      return data;
    },
    async setNewPassword(password) {
      const { data, error } = await authClient.auth.updateUser({ password });
      if (error) throw error;
      return data;
    },
    waitForPasswordRecovery(timeoutMs = 8000) {
      return new Promise(resolve => {
        let subscription;
        let timer;
        let finished = false;
        const finish = session => {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          subscription?.unsubscribe();
          resolve(session);
        };
        const response = authClient.auth.onAuthStateChange((event, session) => {
          if (event === 'PASSWORD_RECOVERY') finish(session);
        });
        subscription = response.data.subscription;
        if (finished) {
          subscription.unsubscribe();
          return;
        }
        timer = setTimeout(() => finish(null), timeoutMs);
      });
    },
  };
}

export async function getSupabase() {
  if (!hasSupabaseConfig()) return null;
  if (client) return client;
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' },
  });
  return client;
}

async function configuredAuthActions() {
  const supabase = await getSupabase();
  if (!supabase) throw new Error('Supabase has not been configured yet.');
  const portalUrl = new URL('portal.html', window.location.href);
  const recoveryUrl = new URL(portalUrl.href);
  recoveryUrl.searchParams.set('recovery', '1');
  return createAuthActions(supabase, {
    emailRedirectTo: portalUrl.href,
    oauthRedirectTo: portalUrl.href,
    passwordResetRedirectTo: recoveryUrl.href,
  });
}

export async function signUpWithEmail(details) {
  return (await configuredAuthActions()).signUpWithEmail(details);
}

export async function signInWithEmail(email, password) {
  return (await configuredAuthActions()).signInWithEmail(email, password);
}

export async function requestPasswordReset(email) {
  return (await configuredAuthActions()).requestPasswordReset(email);
}

export async function setNewPassword(password) {
  return (await configuredAuthActions()).setNewPassword(password);
}

export async function waitForPasswordRecovery(timeoutMs) {
  return (await configuredAuthActions()).waitForPasswordRecovery(timeoutMs);
}

export async function signInWithGoogle() {
  return (await configuredAuthActions()).signInWithProvider('google');
}

export async function signOut() {
  const supabase = await getSupabase();
  if (supabase) await supabase.auth.signOut();
}

export async function getCurrentSession() {
  const supabase = await getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function loadPlayerData(userId) {
  const supabase = await getSupabase();
  const [profileResult, membershipsResult, coursesResult, matchesResult] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', userId).single(),
    supabase
      .from('tournament_memberships')
      .select('status, role, team, tournaments(id, name, slug, edition_year, status)')
      .eq('user_id', userId),
    supabase.from('courses').select('*, tees(*, holes(*))').eq('active', true).order('name'),
    supabase.from('match_players').select('team, matches(*, courses(name)), profiles(display_name)').eq('user_id', userId),
  ]);
  for (const result of [profileResult, membershipsResult, coursesResult, matchesResult]) {
    if (result.error) throw result.error;
  }
  return {
    profile: profileResult.data,
    memberships: membershipsResult.data ?? [],
    courses: coursesResult.data ?? [],
    assignments: matchesResult.data ?? [],
  };
}

export async function saveProfile(userId, displayName, handicapIndex) {
  const supabase = await getSupabase();
  const { error } = await supabase.from('profiles').update({
    display_name: displayName,
    handicap_index: Number(handicapIndex),
  }).eq('id', userId);
  if (error) throw error;
}

export async function saveCourseWithTee({ course, tee, holes, userId }) {
  const supabase = await getSupabase();
  const { data: savedCourse, error: courseError } = await supabase.from('courses').insert({
    name: course.name,
    location: course.location || null,
    created_by: userId,
  }).select().single();
  if (courseError) throw courseError;
  const { data: savedTee, error: teeError } = await supabase.from('tees').insert({
    course_id: savedCourse.id,
    name: tee.name,
    rating: Number(tee.rating),
    slope: Number(tee.slope),
    par: Number(tee.par),
    yardage: Number(tee.yardage) || null,
  }).select().single();
  if (teeError) throw teeError;
  const rows = holes.map(hole => ({
    tee_id: savedTee.id,
    hole_number: Number(hole.hole_number),
    par: Number(hole.par),
    stroke_index: Number(hole.stroke_index),
    yardage: Number(hole.yardage) || null,
  }));
  const { error: holesError } = await supabase.from('holes').insert(rows);
  if (holesError) throw holesError;
  return { course: savedCourse, tee: savedTee };
}

export async function saveRound({ userId, matchId, courseId, teeId, courseHandicap, scores }) {
  const supabase = await getSupabase();
  const roundPayload = {
    user_id: userId,
    match_id: matchId || null,
    course_id: courseId,
    tee_id: teeId,
    course_handicap: courseHandicap,
    updated_at: new Date().toISOString(),
  };
  let round;
  if (matchId) {
    const { data: existing, error: lookupError } = await supabase.from('rounds')
      .select('id').eq('user_id', userId).eq('match_id', matchId).maybeSingle();
    if (lookupError) throw lookupError;
    const result = existing
      ? await supabase.from('rounds').update(roundPayload).eq('id', existing.id).select().single()
      : await supabase.from('rounds').insert(roundPayload).select().single();
    if (result.error) throw result.error;
    round = result.data;
  } else {
    const { data, error } = await supabase.from('rounds').insert(roundPayload).select().single();
    if (error) throw error;
    round = data;
  }
  const rows = scores.filter(score => score.gross_score).map(score => ({
    round_id: round.id,
    user_id: userId,
    hole_number: score.hole_number,
    gross_score: Number(score.gross_score),
  }));
  if (!rows.length) return round;
  const { error: scoresError } = await supabase.from('scores').upsert(rows, {
    onConflict: 'round_id,hole_number',
  });
  if (scoresError) throw scoresError;
  return round;
}
