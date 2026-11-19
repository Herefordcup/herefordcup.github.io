-- Show existing published rules and save their display order atomically.

create or replace function public.save_tournament_rule_ordered(
  target_rule_id uuid,
  target_tournament_id uuid,
  target_title text,
  target_body text,
  target_position integer
)
returns setof public.tournament_rules
language plpgsql
security definer
set search_path = public
as $$
declare
  saved public.tournament_rules;
  remaining_count integer;
  normalized_position integer;
begin
  if not (public.is_admin() or public.is_tournament_admin(target_tournament_id)) then
    raise exception 'Administrator access required';
  end if;
  if target_tournament_id is null
     or char_length(trim(coalesce(target_title, ''))) not between 1 and 160
     or char_length(trim(coalesce(target_body, ''))) not between 1 and 4000 then
    raise exception 'A tournament, title, and rule text are required';
  end if;
  if not exists (select 1 from public.tournaments where id = target_tournament_id) then
    raise exception 'Tournament not found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_tournament_id::text, 0));

  if target_rule_id is not null then
    select * into saved
    from public.tournament_rules
    where id = target_rule_id
      and tournament_id = target_tournament_id
      and active
    for update;
    if saved.id is null then raise exception 'Rule not found'; end if;
  end if;

  select count(*) into remaining_count
  from public.tournament_rules
  where tournament_id = target_tournament_id
    and active
    and id is distinct from target_rule_id;
  normalized_position := greatest(1, least(coalesce(target_position, remaining_count + 1), remaining_count + 1));

  with ordered as (
    select id, row_number() over (order by sort_order, created_at, id)::integer as position
    from public.tournament_rules
    where tournament_id = target_tournament_id
      and active
      and id is distinct from target_rule_id
  )
  update public.tournament_rules rule
  set sort_order = case
      when ordered.position >= normalized_position then ordered.position + 1
      else ordered.position
    end,
    updated_at = now()
  from ordered
  where rule.id = ordered.id;

  if target_rule_id is null then
    insert into public.tournament_rules(tournament_id, title, body, sort_order, active)
    values (target_tournament_id, trim(target_title), trim(target_body), normalized_position, true)
    returning * into saved;
  else
    update public.tournament_rules
    set title = trim(target_title),
        body = trim(target_body),
        sort_order = normalized_position,
        active = true,
        updated_at = now()
    where id = target_rule_id
    returning * into saved;
  end if;

  return query
  select rule.*
  from public.tournament_rules rule
  where rule.tournament_id = target_tournament_id
    and rule.active
  order by rule.sort_order, rule.created_at, rule.id;
end;
$$;

revoke all on function public.save_tournament_rule_ordered(uuid, uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.save_tournament_rule_ordered(uuid, uuid, text, text, integer) to authenticated;
revoke insert, update, delete on table public.tournament_rules from authenticated;
