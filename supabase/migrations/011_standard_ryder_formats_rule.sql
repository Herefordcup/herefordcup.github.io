update public.tournament_rules rule
set body = 'Singles uses one player per side. Four-ball lets every player play their own ball and uses each side''s lowest score on the hole. Foursomes, or alternate shot, uses one ball per side with partners alternating shots. The scoring mode and handicap allowance displayed for that segment control.',
    updated_at = now()
from public.tournaments tournament
where tournament.id = rule.tournament_id
  and tournament.slug = 'hereford-cup-2027'
  and rule.title = 'Singles and team formats';
