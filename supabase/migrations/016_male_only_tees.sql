-- Remove women's rating-category tee rows for the all-male Hereford Cup roster.
-- Fail closed if any historical round references one of these rows.

do $$
declare
  referenced_female_tees integer;
begin
  select count(*)
    into referenced_female_tees
  from public.rounds round_record
  join public.tees tee on tee.id = round_record.tee_id
  where tee.rating_category = 'F';

  if referenced_female_tees > 0 then
    raise exception 'Cannot remove female tee ratings: % historical round(s) reference them', referenced_female_tees;
  end if;

  delete from public.tees
  where rating_category = 'F';
end
$$;

alter table public.tees
  drop constraint if exists tees_rating_category_male_only_check;

alter table public.tees
  add constraint tees_rating_category_male_only_check
  check (rating_category in ('M', 'U'));
