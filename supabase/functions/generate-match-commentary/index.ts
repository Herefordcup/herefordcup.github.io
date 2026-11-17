import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
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
  },
  playful: {
    playful_pressure: 'The pressure stayed on until the result was settled.',
    playful_scoreboard: 'The scoreboard gets the final word.',
  },
  ruthless: {
    ruthless_closed: 'The door closed, and the scoreboard did not blink.',
    ruthless_final: 'No spin needed; the result stands on its own.',
  },
};

function deterministicResult(segment: Record<string, unknown>) {
  const differential = Number(segment.differential);
  const holesPlayed = Number(segment.holes_played);
  const totalHoles = Number(segment.end_hole) - Number(segment.start_hole) + 1;
  if (differential === 0) return 'Match halved';
  const winner = differential > 0 ? 'Blue' : 'White';
  const lead = Math.abs(differential);
  const holesRemaining = Math.max(0, totalHoles - holesPlayed);
  return holesRemaining === 0 ? `${winner} wins ${lead} Up` : `${winner} wins ${lead} & ${holesRemaining}`;
}

function deterministicMatchResult(segments: Array<Record<string, unknown>>) {
  const totals = segments.reduce<{ cardinal: number; silver: number }>((result, segment) => {
    const value = Number(segment.point_value);
    const differential = Number(segment.differential);
    if (differential === 0) {
      result.cardinal += value / 2;
      result.silver += value / 2;
    } else if (differential > 0) {
      result.cardinal += value;
    } else {
      result.silver += value;
    }
    return result;
  }, { cardinal: 0, silver: 0 });
  if (totals.cardinal === totals.silver) return `Match halved ${totals.cardinal}-${totals.silver}`;
  const winner = totals.cardinal > totals.silver ? 'Blue' : 'White';
  return `${winner} wins ${totals.cardinal}-${totals.silver}`;
}

function buildPrompt(tone: string, allowedPhraseIds: string[]) {
  return [
    'Select exactly one phrase identifier from the supplied allowlist.',
    `Tone: ${tone}.`,
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
    const [{ data: isAdmin, error: adminError }, { data: userData, error: userError }] = await Promise.all([
      supabase.rpc('is_admin'),
      supabase.auth.getUser(authorization.replace(/^Bearer\s+/i, '')),
    ]);
    if (adminError || userError || !isAdmin || !userData.user) return json({ error: 'Administrator access required' }, 403);

    const { matchId, commentaryType = 'post_match', segmentId = null } = await request.json();
    if (!matchId) return json({ error: 'matchId is required' }, 400);
    if (!['post_match', 'segment'].includes(commentaryType)) return json({ error: 'Invalid commentary type' }, 400);

    const { data: match, error: matchError } = await supabase
      .from('matches')
      .select('id, status, format, scoring_mode, tournament_id, match_segments(id, segment_number, start_hole, end_hole, format, scoring_mode, point_value, differential, holes_played, status, match_segment_players(team, side))')
      .eq('id', matchId)
      .single();
    if (matchError || !match) return json({ error: 'Match not found' }, 404);
    if (commentaryType === 'post_match' && match.status !== 'final') return json({ error: 'Post-match commentary requires a finalized match' }, 409);

    const { data: settings, error: settingsError } = await supabase
      .from('commentary_settings')
      .select('*')
      .eq('tournament_id', match.tournament_id)
      .single();
    if (settingsError || !settings?.enabled) return json({ error: 'AI commentary is disabled for this tournament' }, 409);
    if (commentaryType === 'segment' && settings.timing !== 'segment_and_match') {
      return json({ error: 'Segment commentary is disabled for this tournament' }, 409);
    }

    const selectedSegments = segmentId
      ? match.match_segments.filter((segment: { id: string }) => segment.id === segmentId)
      : match.match_segments;
    if (segmentId && selectedSegments.length !== 1) return json({ error: 'Segment does not belong to this match' }, 400);
    if (selectedSegments.length === 0) return json({ error: 'Match has no commentary segments' }, 409);
    if (commentaryType === 'segment' && !segmentId) return json({ error: 'segmentId is required for segment commentary' }, 400);
    if (commentaryType === 'post_match' && segmentId) return json({ error: 'Post-match commentary cannot target a segment' }, 400);
    if (selectedSegments.some((segment: { status: string }) => segment.status !== 'final')) {
      return json({ error: 'Commentary requires finalized segments' }, 409);
    }

    let existingQuery = supabase
      .from('match_commentaries')
      .select('*')
      .eq('match_id', match.id)
      .eq('commentary_type', commentaryType)
      .neq('status', 'rejected');
    existingQuery = segmentId
      ? existingQuery.eq('segment_id', segmentId)
      : existingQuery.is('segment_id', null);
    const { data: existingCommentary, error: existingError } = await existingQuery.maybeSingle();
    if (existingError) throw existingError;
    if (existingCommentary) return json({ commentary: existingCommentary, reused: true });

    const facts = {
      status: match.status,
      format: match.format,
      scoringMode: match.scoring_mode,
      result: commentaryType === 'segment'
        ? deterministicResult(selectedSegments[0])
        : deterministicMatchResult(selectedSegments),
      segments: selectedSegments.map((segment: Record<string, unknown>) => ({
        number: segment.segment_number,
        holes: `${segment.start_hole}-${segment.end_hole}`,
        format: segment.format,
        scoringMode: segment.scoring_mode,
        pointValue: segment.point_value,
        differential: segment.differential,
        holesPlayed: segment.holes_played,
        status: segment.status,
        players: (segment.match_segment_players as Array<Record<string, unknown>>).map(player => ({
          team: player.team,
          side: player.side,
        })),
      })),
    };

    const baseUrl = (Deno.env.get('AI_API_BASE_URL') ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const model = Deno.env.get('AI_MODEL') ?? 'gpt-4o-mini';
    const allowedPhraseIds = Object.keys(PHRASE_ALLOWLIST[settings.tone] ?? {});
    if (allowedPhraseIds.length === 0) return json({ error: 'Invalid commentary tone configuration' }, 409);
    const aiResponse = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [{ role: 'user', content: buildPrompt(settings.tone, allowedPhraseIds) }],
      }),
    });
    if (!aiResponse.ok) return json({ error: 'AI provider request failed' }, 502);
    const aiPayload = await aiResponse.json();
    const phraseId = String(aiPayload.choices?.[0]?.message?.content ?? '').trim();
    const closingPhrase = PHRASE_ALLOWLIST[settings.tone]?.[phraseId];
    if (!closingPhrase) return json({ error: 'AI provider returned an invalid phrase identifier' }, 422);
    const commentary = `${facts.result}. ${closingPhrase}`;
    if (commentary.length > settings.max_characters) return json({ error: 'Composed commentary exceeds the configured length' }, 422);

    const { data: saved, error: saveError } = await supabase.rpc('create_commentary_draft', {
      target_match_id: match.id,
      target_segment_id: segmentId,
      target_commentary_type: commentaryType,
      target_phrase_id: phraseId,
      target_model: model,
    });
    if (saveError) throw saveError;
    return json({ commentary: saved });
  } catch (error) {
    console.error('generate-match-commentary failed', error instanceof Error ? error.message : 'unknown error');
    return json({ error: 'Unable to generate commentary' }, 500);
  }
});
