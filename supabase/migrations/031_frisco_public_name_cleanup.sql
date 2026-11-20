begin;

-- PGA Frisco: preserve recorded names while removing only a standalone
-- unknown participant or a trailing uncertainty mark. Other punctuation and
-- all scoring, source, confidence, and audit metadata remain untouched.
update public.legacy_results
set
  cardinal_entry = replace(
    regexp_replace(
      regexp_replace(cardinal_entry, '(^|[[:space:]/(])\?([[:space:]/,).]|$)', E'\\1TBD\\2', 'g'),
      '\?([[:space:]]*[/,).]|$)', E'\\1', 'g'
    ),
    'names not listed',
    'TBD'
  ),
  silver_entry = replace(
    regexp_replace(
      regexp_replace(silver_entry, '(^|[[:space:]/(])\?([[:space:]/,).]|$)', E'\\1TBD\\2', 'g'),
      '\?([[:space:]]*[/,).]|$)', E'\\1', 'g'
    ),
    'names not listed',
    'TBD'
  )
where edition_id = (
  select edition.id
  from public.legacy_editions edition
  where edition.edition_year = 2025
)
  and (
    coalesce(cardinal_entry, '') ~ '(^|[[:space:]/(])\?([[:space:]/,).]|$)|\?([[:space:]]*[/,).]|$)'
    or coalesce(silver_entry, '') ~ '(^|[[:space:]/(])\?([[:space:]/,).]|$)|\?([[:space:]]*[/,).]|$)'
  );

do $$
begin
  if exists (
    select 1
    from public.legacy_results result
    join public.legacy_editions edition on edition.id = result.edition_id
    where edition.edition_year = 2025
      and result.public_visible is true
      and (
        coalesce(result.cardinal_entry, '') ~ '(^|[[:space:]/(])\?([[:space:]/,).]|$)|\?([[:space:]]*[/,).]|$)'
        or coalesce(result.silver_entry, '') ~ '(^|[[:space:]/(])\?([[:space:]/,).]|$)|\?([[:space:]]*[/,).]|$)'
      )
  ) then
    raise exception 'PGA Frisco public participant names still contain question marks';
  end if;
end;
$$;

commit;
