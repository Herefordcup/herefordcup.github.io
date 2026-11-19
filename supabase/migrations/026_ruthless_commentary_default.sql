-- New commentary settings default to the user's preferred Ruthless tone.
-- Existing saved tournament choices are intentionally left unchanged.
alter table public.commentary_settings
  alter column tone set default 'ruthless';
