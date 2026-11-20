do $$
begin
  update public.legacy_results
  set cardinal_entry = replace(cardinal_entry, 'Pimental', 'Pimentel'),
      silver_entry = replace(silver_entry, 'Pimental', 'Pimentel')
  where cardinal_entry like '%Pimental%'
     or silver_entry like '%Pimental%';

  if exists (
    select 1
    from public.legacy_results
    where cardinal_entry like '%Pimental%'
       or silver_entry like '%Pimental%'
  ) then
    raise exception 'Legacy participant spelling Pimental still exists';
  end if;
end
$$;
