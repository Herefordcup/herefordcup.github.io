import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, hasSupabaseConfig } from './config.js';
import { selectActiveTournament } from './member.js';

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
  const [profileResult, membershipsResult, coursesResult] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', userId).single(),
    supabase
      .from('tournament_memberships')
      .select('status, role, team, tournaments(id, name, slug, edition_year, status, starts_on)')
      .eq('user_id', userId),
    supabase.from('courses').select('*, tees(*, holes(*))').eq('active', true).order('name'),
  ]);
  for (const result of [profileResult, membershipsResult, coursesResult]) {
    if (result.error) throw result.error;
  }

  const memberships = membershipsResult.data ?? [];
  const tournament = selectActiveTournament(memberships);
  if (!tournament) {
    return {
      profile: profileResult.data,
      memberships: [],
      tournament: null,
      courses: coursesResult.data ?? [],
      assignments: [],
      matches: [],
      events: [],
      segments: [],
      rules: [],
      statistics: [],
      commentaries: [],
      rounds: [],
    };
  }

  const [assignmentsResult, tournamentMatchesResult, eventsResult, segmentsResult, rulesResult, statisticsResult, commentaryResult, roundsResult] = await Promise.all([
    supabase.from('match_players')
      .select('team, matches!inner(*, courses(name)), profiles(display_name)')
      .eq('user_id', userId)
      .eq('matches.tournament_id', tournament.id),
    supabase.from('matches')
      .select('*, courses(name), match_players(*, profiles(display_name))')
      .eq('tournament_id', tournament.id)
      .order('starts_at'),
    supabase.from('tournament_events').select('*, courses(name)')
      .eq('tournament_id', tournament.id)
      .order('starts_at'),
    supabase.from('match_segments')
      .select('*, matches!inner(tournament_id), match_segment_players(*, profiles(display_name))')
      .eq('matches.tournament_id', tournament.id)
      .order('segment_number'),
    supabase.from('tournament_rules').select('*')
      .eq('tournament_id', tournament.id)
      .eq('active', true)
      .order('sort_order'),
    supabase.from('official_round_statistics').select('*')
      .eq('tournament_id', tournament.id),
    supabase.from('match_commentaries').select('*, matches!inner(name, tournament_id)')
      .eq('matches.tournament_id', tournament.id)
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .limit(5),
    supabase.from('rounds').select('*, scores!scores_round_id_fkey(*)')
      .eq('user_id', userId),
  ]);
  for (const result of [assignmentsResult, tournamentMatchesResult, eventsResult, segmentsResult, rulesResult, statisticsResult, commentaryResult, roundsResult]) {
    if (result.error) throw result.error;
  }
  return {
    profile: profileResult.data,
    memberships: memberships.filter(membership => membership.tournaments?.id === tournament.id),
    tournament,
    courses: coursesResult.data ?? [],
    assignments: assignmentsResult.data ?? [],
    matches: tournamentMatchesResult.data ?? [],
    events: eventsResult.data ?? [],
    segments: segmentsResult.data ?? [],
    rules: rulesResult.data ?? [],
    statistics: statisticsResult.data ?? [],
    commentaries: commentaryResult.data ?? [],
    rounds: roundsResult.data ?? [],
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
    rating: tee.rating === null ? null : Number(tee.rating),
    slope: tee.slope === null ? null : Number(tee.slope),
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

export async function saveMatchPlan({ match, segments }) {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('save_match_plan', {
    match_payload: match,
    segment_payload: segments,
  });
  if (error) throw error;
  return data;
}

export async function saveTournamentRule({ tournamentId, title, body, sortOrder = 0 }) {
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('tournament_rules').upsert({
    tournament_id: tournamentId,
    title: title.trim(),
    body: body.trim(),
    sort_order: Number(sortOrder),
    active: true,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'tournament_id,title' }).select().single();
  if (error) throw error;
  return data;
}

export async function saveCommentarySettings(settings) {
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('commentary_settings').upsert({
    tournament_id: settings.tournamentId,
    enabled: Boolean(settings.enabled),
    tone: settings.tone,
    timing: settings.timing,
    require_approval: false,
    max_characters: Number(settings.maxCharacters),
    updated_by: settings.userId,
    updated_at: new Date().toISOString(),
  }).select().single();
  if (error) throw error;
  return data;
}

export async function generateMatchCommentary(matchId) {
  const supabase = await getSupabase();
  const { data, error } = await supabase.functions.invoke('generate-match-commentary', {
    body: { matchId, commentaryType: 'post_match' },
  });
  if (error) throw error;
  return data.commentary;
}

export async function updateCommentaryText({ commentaryId, commentary }) {
  const text = commentary.trim();
  if (!text || text.length > 2000) throw new Error('Commentary must be 1 through 2,000 characters.');
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('edit_commentary_draft', {
    target_commentary_id: commentaryId,
    target_commentary: text,
  });
  if (error) throw error;
  return data;
}

export async function updateCommentaryStatus({ commentaryId, status }) {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('set_commentary_status', {
    target_commentary_id: commentaryId,
    target_status: status,
  });
  if (error) throw error;
  return data;
}

export async function finalizeMatchResults({ matchId, segmentResults }) {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('finalize_match_results', {
    target_match_id: matchId,
    segment_results: segmentResults,
  });
  if (error) throw error;
  return data;
}

export async function correctHoleScore({ roundId, holeNumber, grossScore = null, deleteScore = false, reason }) {
  const correctionReason = reason?.trim();
  if (!correctionReason) throw new Error('A correction reason is required.');
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('correct_hole_score', {
    target_round_id: roundId,
    target_hole_number: Number(holeNumber),
    target_reason: correctionReason,
    target_gross_score: grossScore === null ? null : Number(grossScore),
    delete_score: Boolean(deleteScore),
  });
  if (error) throw error;
  const { data: audit, error: auditError } = await supabase.from('score_correction_audit')
    .select('*')
    .eq('round_id', roundId)
    .eq('hole_number', Number(holeNumber))
    .order('corrected_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (auditError) throw auditError;
  return { score: data, audit };
}

export async function loadAdminData() {
  const supabase = await getSupabase();
  const [tournaments, memberships, courses, matches, settings, commentaries, rounds] = await Promise.all([
    supabase.from('tournaments').select('*').order('edition_year', { ascending: false }),
    supabase.from('tournament_memberships').select('*, profiles!tournament_memberships_user_id_fkey(id, display_name, handicap_index)').eq('status', 'active'),
    supabase.from('courses').select('id, name').eq('active', true).order('name'),
    supabase.from('matches').select('*, match_segments(*, match_segment_players(*))').order('starts_at'),
    supabase.from('commentary_settings').select('*'),
    supabase.from('match_commentaries').select('*, matches(name)').order('created_at', { ascending: false }),
    supabase.from('rounds').select('*, profiles(display_name), courses(name), tees(name), scores!scores_round_id_fkey(*)').order('created_at', { ascending: false }),
  ]);
  for (const result of [tournaments, memberships, courses, matches, settings, commentaries, rounds]) {
    if (result.error) throw result.error;
  }
  return {
    tournaments: tournaments.data ?? [],
    memberships: memberships.data ?? [],
    courses: courses.data ?? [],
    matches: matches.data ?? [],
    settings: settings.data ?? [],
    commentaries: commentaries.data ?? [],
    rounds: rounds.data ?? [],
  };
}

export async function saveRound({ userId, matchId, courseId, teeId, courseHandicap, scores, existingRound = null }) {
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
      .select('*, scores!scores_round_id_fkey(*)').eq('user_id', userId).eq('match_id', matchId).maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) {
      if (existingRound && existing.id !== existingRound.id) throw new Error('The saved round changed. Reload before submitting scores.');
      if (existing.course_id !== courseId || existing.tee_id !== teeId) {
        throw new Error('This round must keep its persisted course and tee. Reload the assigned match and try again.');
      }
      round = existing;
    } else {
      const { data, error } = await supabase.from('rounds').insert(roundPayload).select().single();
      if (error) throw error;
      round = data;
    }
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
  if (rows.length) {
    const { error: scoresError } = await supabase.from('scores').insert(rows);
    if (scoresError) {
      if (scoresError.code === '23505') {
        throw new Error('Submitted scores are locked. Contact an administrator for a correction.');
      }
      throw scoresError;
    }
  }
  const { data: refreshed, error: refreshError } = await supabase.from('rounds')
    .select('*, scores!scores_round_id_fkey(*)').eq('id', round.id).single();
  if (refreshError) throw refreshError;
  return refreshed;
}
