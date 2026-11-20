begin;

-- Normalize Kiawah punctuation to ASCII so every browser renders the same labels.
update public.legacy_editions
set final_score = 'Blue 18 - White 23'
where edition_year = 2026
  and final_score is distinct from 'Blue 18 - White 23';

update public.legacy_results
set
  event_group = replace(
    replace(
      replace(
        replace(event_group, chr(915) || chr(199) || chr(246), '-'),
        chr(915) || chr(199) || chr(244), '-'
      ),
      chr(8212), '-'
    ),
    chr(8211), '-'
  ),
  format_label = replace(
    replace(
      replace(
        replace(
          replace(
            replace(format_label, chr(9516) || chr(9558), '-'),
            chr(915) || chr(199) || chr(246), '-'
          ),
          chr(915) || chr(199) || chr(244), '-'
        ),
        chr(183), '-'
      ),
      chr(8212), '-'
    ),
    chr(8211), '-'
  ),
  label = replace(
    replace(
      replace(
        replace(
          replace(
            replace(label, chr(915) || chr(199) || chr(246), '-'),
            chr(915) || chr(199) || chr(244), '-'
          ),
          chr(9516) || chr(9558), '-'
        ),
        chr(183), '-'
      ),
      chr(8212), '-'
    ),
    chr(8211), '-'
  )
where edition_id = (select id from public.legacy_editions where edition_year = 2026);

-- Innisbrook: Troy? becomes Troy; an unknown standalone name becomes TBD.
update public.legacy_results
set
  cardinal_entry = replace(
    regexp_replace(
      replace(replace(replace(cardinal_entry, 'names not listed', 'TBD'), 'not listed', 'TBD'), 'Troy?', 'Troy'),
      '(^|[ /])\?($|[ /,)])', E'\\1TBD\\2', 'g'
    ),
    '?', ''
  ),
  silver_entry = replace(
    regexp_replace(
      replace(replace(replace(silver_entry, 'names not listed', 'TBD'), 'not listed', 'TBD'), 'Troy?', 'Troy'),
      '(^|[ /])\?($|[ /,)])', E'\\1TBD\\2', 'g'
    ),
    '?', ''
  ),
  label = replace(
    regexp_replace(
      replace(replace(replace(label, 'names not listed', 'TBD'), 'not listed', 'TBD'), 'Troy?', 'Troy'),
      '(^|[ /])\?($|[ /,)])', E'\\1TBD\\2', 'g'
    ),
    '?', ''
  )
where edition_id = (select id from public.legacy_editions where edition_year = 2024);

do $$
begin
  if exists (
    select 1
    from public.legacy_results
    where edition_id = (select id from public.legacy_editions where edition_year = 2026)
      and (
        coalesce(event_group, '') || coalesce(format_label, '') || coalesce(label, '')
          like '%' || chr(915) || chr(199) || chr(246) || '%'
        or coalesce(event_group, '') || coalesce(format_label, '') || coalesce(label, '')
          like '%' || chr(915) || chr(199) || chr(244) || '%'
        or coalesce(event_group, '') || coalesce(format_label, '') || coalesce(label, '')
          like '%' || chr(9516) || chr(9558) || '%'
        or coalesce(event_group, '') || coalesce(format_label, '') || coalesce(label, '')
          like '%' || chr(8212) || '%'
        or coalesce(event_group, '') || coalesce(format_label, '') || coalesce(label, '')
          like '%' || chr(8211) || '%'
        or coalesce(event_group, '') || coalesce(format_label, '') || coalesce(label, '')
          like '%' || chr(183) || '%'
      )
  ) then
    raise exception 'Kiawah mojibake remains after text cleanup';
  end if;

  if exists (
    select 1
    from public.legacy_results
    where edition_id = (select id from public.legacy_editions where edition_year = 2024)
      and public_visible is true
      and (
        coalesce(cardinal_entry, '') like '%?%'
        or coalesce(silver_entry, '') like '%?%'
        or coalesce(label, '') like '%?%'
      )
  ) then
    raise exception 'Innisbrook public participant placeholders still contain question marks';
  end if;
end;
$$;

commit;
