-- Shorten the member-facing 2027 itinerary label without changing the event type or competitive status.

update public.tournament_events event
set title = 'Tobacco Road',
    updated_at = now()
from public.tournaments tournament
where event.tournament_id = tournament.id
  and tournament.edition_year = 2027
  and event.title = 'Tobacco Road fun round';
