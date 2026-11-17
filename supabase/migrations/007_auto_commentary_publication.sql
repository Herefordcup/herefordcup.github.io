-- Publish generated match commentary immediately when tournament settings disable approval.

alter table public.commentary_settings
  drop constraint if exists commentary_settings_require_approval_check;

alter table public.commentary_settings
  alter column require_approval set default false;

update public.commentary_settings
set require_approval = false,
    updated_at = now();

create or replace function public.prepare_commentary_publication()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  approval_required boolean := true;
begin
  select settings.require_approval
    into approval_required
  from public.commentary_settings settings
  join public.matches match_record on match_record.tournament_id = settings.tournament_id
  where match_record.id = new.match_id;

  if new.ai_generated and coalesce(approval_required, true) = false then
    new.status := 'approved';
    new.approved_by := new.generated_by;
    new.approved_at := now();
  end if;

  return new;
end;
$$;

revoke all on function public.prepare_commentary_publication() from public;

drop trigger if exists publish_generated_commentary on public.match_commentaries;
create trigger publish_generated_commentary
before insert on public.match_commentaries
for each row execute function public.prepare_commentary_publication();
