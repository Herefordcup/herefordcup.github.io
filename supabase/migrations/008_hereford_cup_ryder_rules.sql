-- Publish only the Ryder-style rules that apply to the Hereford Cup format.

insert into public.tournament_rules(tournament_id, title, body, sort_order, active, updated_at)
select tournament.id, rule.title, rule.body, rule.sort_order, true, now()
from public.tournaments tournament
cross join (values
  (
    'Match play scoring',
    'Each configured segment is decided hole by hole. In a gross segment, the lower gross score wins the hole. In a net segment, the lower net score wins the hole after allocated handicap strokes. Equal scores halve the hole. The side leading by more holes than remain wins the segment; otherwise the result is the final holes-up margin or a halve.',
    10
  ),
  (
    'Handicap strokes',
    'For a net segment, course handicaps come from each player''s handicap index and the selected course and tee rating. The allowance shown in the match plan is applied before play. Players compete relative to the lowest course handicap in the match, and strokes fall on the lowest stroke-index holes in the segment. Gross segments use no handicap strokes.',
    20
  ),
  (
    'Singles and team formats',
    'Singles uses one player per side. Four-ball lets every player play their own ball and uses each side''s lowest score on the hole. Foursomes uses one ball per side with partners alternating shots. Scramble, shamble, and Chapman segments follow the format and lineup published in the match plan. The scoring mode and handicap allowance displayed for that segment control.',
    30
  ),
  (
    'Points and halved segments',
    'Each segment is worth the point value published in the match plan. The winning side receives the full value. A halved segment splits the value equally between Cardinal and Silver. The Cup standing is the total of all finalized segment points; the side with more points after the scheduled matches wins.',
    40
  ),
  (
    'Concessions and pickups',
    'A player or side may concede the next stroke, a hole, or the match under match-play Rule 3.2b. A concession is final and cannot be declined or withdrawn. Once a hole or segment is decided, players may pick up when no remaining score is needed for an assigned individual round.',
    50
  ),
  (
    'Finalizing results',
    'Enter scores on the assigned card and verify the hole results with the group. An administrator finalizes every official segment result. Finalization locks the match, awards Cup points, and makes eligible individual statistics official. Do not finalize until the recorded result agrees with both sides.',
    60
  ),
  (
    'Corrections and disputes',
    'Player submissions are immutable after they are saved for tournament play. Report any incorrect score or result to an administrator. Every administrator correction or deletion requires a written reason and is recorded in the audit history. The finalized administrator result is the authoritative Cup result.',
    70
  )
) as rule(title, body, sort_order)
where tournament.slug = 'hereford-cup-2027'
on conflict (tournament_id, title) do update
set body = excluded.body,
    sort_order = excluded.sort_order,
    active = true,
    updated_at = now();
