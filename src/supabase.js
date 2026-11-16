import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, hasSupabaseConfig } from './config.js';

let client;

export async function getSupabase() {
  if (!hasSupabaseConfig()) return null;
  if (client) return client;
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, detectSessionInUrl: true, flowType: 'implicit' },
  });
  return client;
}

export async function signInWithGoogle() {
  const supabase = await getSupabase();
  if (!supabase) throw new Error('Supabase has not been configured yet.');
  const redirectTo = new URL('portal.html', window.location.href).href;
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo },
  });
  if (error) throw error;
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
  const [profileResult, coursesResult, matchesResult] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', userId).single(),
    supabase.from('courses').select('*, tees(*, holes(*))').eq('active', true).order('name'),
    supabase.from('match_players').select('team, matches(*, courses(name)), profiles(display_name)').eq('user_id', userId),
  ]);
  for (const result of [profileResult, coursesResult, matchesResult]) {
    if (result.error) throw result.error;
  }
  return {
    profile: profileResult.data,
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
