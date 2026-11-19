-- Deny only membership requests that are still pending.
-- This separate RPC prevents a concurrent approval from being deleted as a denial.

create or replace function public.deny_tournament_membership(
  target_tournament_id uuid,
  target_user_id uuid,
  change_reason text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_membership public.tournament_memberships%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(target_tournament_id::text, 0));

  if not public.is_tournament_admin(target_tournament_id) then
    raise exception 'Tournament administrator access required';
  end if;
  if char_length(trim(coalesce(change_reason, ''))) < 2 then
    raise exception 'A reason is required';
  end if;

  select membership.* into current_membership
  from public.tournament_memberships membership
  where membership.tournament_id = target_tournament_id
    and membership.user_id = target_user_id
  for update;

  if not found then
    raise exception 'Tournament membership not found';
  end if;
  if current_membership.status <> 'pending' then
    raise exception 'Membership request is no longer pending';
  end if;
  if exists (
    select 1
    from public.profiles profile
    where profile.id = target_user_id
      and profile.role = 'admin'
  ) then
    raise exception 'You cannot deny a global administrator tournament membership';
  end if;

  delete from public.membership_status_audit audit
  where audit.tournament_id = target_tournament_id
    and audit.user_id = target_user_id;

  delete from public.tournament_memberships membership
  where membership.tournament_id = target_tournament_id
    and membership.user_id = target_user_id
    and membership.status = 'pending';

  if not found then
    raise exception 'Membership request is no longer pending';
  end if;

  return true;
end;
$$;

revoke all on function public.deny_tournament_membership(uuid, uuid, text) from public, anon;
grant execute on function public.deny_tournament_membership(uuid, uuid, text) to authenticated;
