import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const PHRASE_ALLOWLIST: Record<string, Record<string, string>> = {
  clean: {
    clean_steady: 'A composed finish settled the contest.',
    clean_clinical: 'The result was secured with a disciplined close.',
    clean_complete: 'The scorecard confirms a complete performance.',
    clean_decisive: 'A decisive finish put the result beyond doubt.',
    clean_halved_even: 'The scorecard confirms an evenly shared match.',
    clean_halved_complete: 'The full card ended with the point shared.',
  },
  playful: {
    playful_excuses: 'The winners get bragging rights; the losers get first crack at the excuses.',
    playful_group_chat: 'Bragging rights secured. The scorecard has entered the group chat.',
    playful_recount: 'The card is signed; recount requests have been denied by the scorecard.',
    playful_character: 'One side gets the win. The other gets a little character development.',
    playful_receipts: 'The scorecard kept the receipts, and it is not accepting revisions.',
    playful_cart_ride: 'The result is on the card. The wheels are officially loose.',
    playful_halved_claims: 'Nobody gets the win, so the scorecard gets the last laugh.',
    playful_halved_brags: 'The match was halved; the scorecard declined to pick a favorite.',
  },
  ruthless: {
    ruthless_no_appeal: 'The scorecard leaves no appeal and even less sympathy.',
    ruthless_character: 'One side earned the win. The other earned character development.',
    ruthless_receipts: 'The scorecard kept every receipt. None of them favor the losing side.',
    ruthless_verdict: 'The verdict arrived, and the excuses were ruled inadmissible.',
    ruthless_resume: 'Put it on the winners’ résumé and file the other copy under hard lessons.',
    ruthless_silence: 'The result is official. The scorecard has closed comments.',
    ruthless_halved_stalemate: 'The full card produced no winner and no appeal.',
    ruthless_halved_brags: 'No winner, no loser, and no room for creative scorekeeping.',
  },
  savage: {
    savage_competition_left: 'The losing side was still on the scorecard, but the competition had already left.',
    savage_apology: 'An answer was required. An apology would have been more realistic.',
    savage_rental: 'The losing side spent the finish renting space on someone else’s scoreboard.',
    savage_evidence: 'There was hope. Then the scorecard introduced evidence.',
    savage_itemized: 'The scorecard kept the receipts and itemized the damage.',
    savage_closed_case: 'The result needs no explanation. The scorecard already closed the case.',
    savage_halved_afternoon: 'Nobody lost, nobody won, and the scorecard would like its afternoon back.',
    savage_halved_explanations: 'The full match produced no winner—just two sides preparing very confident explanations.',
  },
};

function phraseIdsForResult(tone: string, outcomeClass: string) {
  const phraseIds = Object.keys(PHRASE_ALLOWLIST[tone] ?? {});
  const isHalved = outcomeClass === 'halved';
  return phraseIds.filter(phraseId => isHalved === phraseId.includes('_halved_'));
}

function buildPrompt(tone: string, outcomeClass: string, allowedPhraseIds: string[]) {
  return [
    'Select exactly one banter phrase identifier from the supplied allowlist.',
    `Tone: ${tone}.`,
    `Anonymous outcome class: ${outcomeClass}.`,
    `Allowed identifiers: ${allowedPhraseIds.join(', ')}`,
    'Return one identifier only, with no punctuation, prose, names, facts, or explanation.',
    'Do not name or quote people. Do not mention injuries, weather, shots, emotions, or events.',
  ].join('\n');
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const authorization = request.headers.get('Authorization');
    if (!authorization) return json({ error: 'Authentication required' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const apiKey = Deno.env.get('AI_API_KEY');
    if (!supabaseUrl || !supabaseAnonKey || !apiKey) return json({ error: 'Commentary service is not configured' }, 503);

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    });
    const { data: userData, error: userError } = await supabase.auth.getUser(authorization.replace(/^Bearer\s+/i, ''));
    if (userError || !userData.user) return json({ error: 'Administrator access required' }, 403);

    const body = await request.json();
    const { matchId, commentaryType = 'post_match', segmentId = null } = body;
    const regenerate = body.regenerate === true;
    if (!matchId) return json({ error: 'matchId is required' }, 400);
    if (commentaryType !== 'post_match' || segmentId !== null) return json({ error: 'Only post-match recaps are supported' }, 400);

    const { data: match, error: matchError } = await supabase
      .from('matches')
      .select('id, status, tournament_id, match_segments(id, format, differential, status)')
      .eq('id', matchId)
      .single();
    if (matchError || !match) return json({ error: 'Match not found' }, 404);
    if (match.status !== 'final') return json({ error: 'Post-match commentary requires a finalized match' }, 409);
    const [{ data: isAdmin, error: adminError }, { data: isTournamentAdmin, error: tournamentAdminError }] = await Promise.all([
      supabase.rpc('is_admin'),
      supabase.rpc('is_tournament_admin', { target_tournament_id: match.tournament_id }),
    ]);
    if (adminError || tournamentAdminError) return json({ error: 'Authorization check failed' }, 403);
    const administrator = Boolean(isAdmin || isTournamentAdmin);
    if (regenerate && !administrator) {
      return json({ error: 'Administrator access required to regenerate commentary' }, 403);
    }
    if (!administrator) {
      const { data: assignments, error: assignmentError } = await supabase
        .from('match_segment_players')
        .select('segment_id, match_segments!inner(match_id)')
        .eq('user_id', userData.user.id)
        .eq('match_segments.match_id', match.id)
        .limit(1);
      if (assignmentError || !assignments?.length) {
        return json({ error: 'Assigned match participant or administrator access required' }, 403);
      }
    }

    const { data: settings, error: settingsError } = await supabase
      .from('commentary_settings')
      .select('*')
      .eq('tournament_id', match.tournament_id)
      .single();
    if (settingsError || !settings?.enabled) return json({ error: 'AI commentary is disabled for this tournament' }, 409);
    const selectedSegments = match.match_segments;
    if (selectedSegments.length === 0) return json({ error: 'Match has no commentary segments' }, 409);
    if (selectedSegments.length !== 1) return json({ error: 'Short recaps require a one-segment match' }, 409);
    if (!['singles', 'fourball'].includes(selectedSegments[0].format)) {
      return json({ error: 'Short recaps support only Singles and Four-Ball' }, 409);
    }
    if (selectedSegments.some((segment: { status: string }) => segment.status !== 'final')) {
      return json({ error: 'Commentary requires finalized segments' }, 409);
    }

    const findActiveCommentary = async () => {
      let query = supabase
        .from('match_commentaries')
        .select('*')
        .eq('match_id', match.id)
        .eq('commentary_type', commentaryType)
        .neq('status', 'hidden');
      query = segmentId
        ? query.eq('segment_id', segmentId)
        : query.is('segment_id', null);
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      return data;
    };
    if (!regenerate) {
      const existingCommentary = await findActiveCommentary();
      if (existingCommentary) return json({ commentary: existingCommentary, reused: true });
    }

    const baseUrl = (Deno.env.get('AI_API_BASE_URL') ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const model = Deno.env.get('AI_MODEL') ?? 'gpt-4o-mini';
    const outcomeClass = Number(selectedSegments[0].differential) === 0 ? 'halved' : 'decisive';
    const allowedPhraseIds = phraseIdsForResult(settings.tone, outcomeClass);
    if (allowedPhraseIds.length === 0) return json({ error: 'Invalid commentary tone configuration' }, 409);
    const aiResponse = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [{ role: 'user', content: buildPrompt(settings.tone, outcomeClass, allowedPhraseIds) }],
      }),
    });
    if (!aiResponse.ok) return json({ error: 'AI provider request failed' }, 502);
    const aiPayload = await aiResponse.json();
    const phraseId = String(aiPayload.choices?.[0]?.message?.content ?? '').trim();
    if (!PHRASE_ALLOWLIST[settings.tone]?.[phraseId] || !allowedPhraseIds.includes(phraseId)) {
      return json({ error: 'AI provider returned an invalid phrase identifier' }, 422);
    }

    const { data: saved, error: saveError } = await supabase.rpc('create_commentary_draft', {
      target_match_id: match.id,
      target_segment_id: segmentId,
      target_commentary_type: commentaryType,
      target_phrase_id: phraseId,
      target_model: model,
      target_regenerate: regenerate,
    });
    if (saveError?.code === '23505') {
      const concurrentCommentary = await findActiveCommentary();
      if (concurrentCommentary) return json({ commentary: concurrentCommentary, reused: true });
    }
    if (saveError) throw saveError;
    return json({ commentary: saved });
  } catch (error) {
    console.error('generate-match-commentary failed', error instanceof Error ? error.message : 'unknown error');
    return json({ error: 'Unable to generate commentary' }, 500);
  }
});
