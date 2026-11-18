-- Fill every previously unrated active tee with the current USGA NCRDB rating/slope.
-- Existing scorecard hole geometry is retained. Each tee records the USGA tee name and
-- registered length used for the rating so small scorecard/NCRDB differences stay explicit.

create or replace function public.apply_current_course_ratings(payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  row_record jsonb;
  course_id_value uuid;
  template_tee_id uuid;
  target_tee_id uuid;
  new_tee_id uuid;
  stroke_record record;
begin
  for row_record in select value from jsonb_array_elements(payload)
  loop
    select id into course_id_value
    from public.courses
    where lower(name) = lower(row_record ->> 'course')
    order by created_at
    limit 1;

    if course_id_value is null then
      raise exception 'Course not found: %', row_record ->> 'course';
    end if;

    select id into target_tee_id
    from public.tees
    where course_id = course_id_value
      and lower(name) = lower(row_record ->> 'tee')
      and rating_category = row_record ->> 'category'
    limit 1;

    if target_tee_id is null then
      select id into template_tee_id
      from public.tees
      where course_id = course_id_value
        and lower(name) = lower(row_record ->> 'tee')
      order by case when rating_category = 'U' then 0 else 1 end, created_at
      limit 1;

      if template_tee_id is null then
        raise exception 'Tee not found: % / %', row_record ->> 'course', row_record ->> 'tee';
      end if;

      if exists (select 1 from public.tees where id = template_tee_id and rating_category = 'U') then
        update public.tees
        set rating_category = row_record ->> 'category',
            rating = (row_record ->> 'rating')::numeric,
            slope = (row_record ->> 'slope')::integer,
            rating_par = (row_record ->> 'rating_par')::integer,
            source_url = row_record ->> 'source_url',
            source_notes = format(
              'Current USGA NCRDB row: %s, %s yards. Existing scorecard geometry retained; rating linked by official tee designation.',
              row_record ->> 'source_tee', row_record ->> 'source_yardage'
            )
        where id = template_tee_id;
        target_tee_id := template_tee_id;
      else
        insert into public.tees(
          course_id, name, rating_category, rating, slope, par, rating_par,
          yardage, source_url, source_notes
        )
        select course_id, name, row_record ->> 'category',
          (row_record ->> 'rating')::numeric, (row_record ->> 'slope')::integer,
          par, (row_record ->> 'rating_par')::integer, yardage,
          row_record ->> 'source_url',
          format(
            'Current USGA NCRDB row: %s, %s yards. Existing scorecard geometry retained; rating linked by official tee designation.',
            row_record ->> 'source_tee', row_record ->> 'source_yardage'
          )
        from public.tees
        where id = template_tee_id
        returning id into new_tee_id;

        insert into public.holes(tee_id, hole_number, par, stroke_index, yardage)
        select new_tee_id, hole_number, par, stroke_index, yardage
        from public.holes
        where tee_id = template_tee_id;
        target_tee_id := new_tee_id;
      end if;
    else
      update public.tees
      set rating = (row_record ->> 'rating')::numeric,
          slope = (row_record ->> 'slope')::integer,
          rating_par = (row_record ->> 'rating_par')::integer,
          source_url = row_record ->> 'source_url',
          source_notes = format(
            'Current USGA NCRDB row: %s, %s yards. Existing scorecard geometry retained; rating linked by official tee designation.',
            row_record ->> 'source_tee', row_record ->> 'source_yardage'
          )
      where id = target_tee_id;
    end if;

    if row_record ? 'stroke_indexes' then
      for stroke_record in
        select ordinality::integer as hole_number, value::integer as stroke_index
        from jsonb_array_elements_text(row_record -> 'stroke_indexes') with ordinality
      loop
        update public.holes
        set stroke_index = stroke_record.stroke_index
        where tee_id = target_tee_id and hole_number = stroke_record.hole_number;
      end loop;
    end if;
  end loop;
end;
$$;

select public.apply_current_course_ratings($ratings$
[
  {"course":"Pinehurst No. 2","tee":"U.S. Open","category":"M","rating":77.9,"slope":149,"rating_par":72,"source_tee":"U. S. Open Tees","source_yardage":7551,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23725"},
  {"course":"Pinehurst No. 2","tee":"Blue","category":"M","rating":75.4,"slope":143,"rating_par":72,"source_tee":"Blue Tees","source_yardage":6966,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23725"},
  {"course":"Pinehurst No. 2","tee":"Ross","category":"M","rating":73.6,"slope":141,"rating_par":72,"source_tee":"Blue/White Hybrid","source_yardage":6659,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23725"},
  {"course":"Pinehurst No. 2","tee":"White","category":"M","rating":72.0,"slope":139,"rating_par":72,"source_tee":"White Tees","source_yardage":6324,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23725"},
  {"course":"Pinehurst No. 2","tee":"White","category":"F","rating":78.1,"slope":144,"rating_par":72,"source_tee":"White Tees","source_yardage":6324,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23725"},
  {"course":"Pinehurst No. 2","tee":"Tufts","category":"M","rating":70.3,"slope":136,"rating_par":72,"source_tee":"White/Green Hybrid","source_yardage":5979,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23725"},
  {"course":"Pinehurst No. 2","tee":"Tufts","category":"F","rating":76.0,"slope":140,"rating_par":72,"source_tee":"White/Green Hybrid","source_yardage":5979,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23725"},
  {"course":"Pinehurst No. 2","tee":"Green","category":"M","rating":69.1,"slope":135,"rating_par":72,"source_tee":"Green Tees","source_yardage":5782,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23725"},
  {"course":"Pinehurst No. 2","tee":"Green","category":"F","rating":74.9,"slope":137,"rating_par":72,"source_tee":"Green Tees","source_yardage":5782,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23725"},
  {"course":"Pinehurst No. 2","tee":"Red","category":"M","rating":66.8,"slope":128,"rating_par":72,"source_tee":"Red Tees","source_yardage":5321,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23725"},
  {"course":"Pinehurst No. 2","tee":"Red","category":"F","rating":72.1,"slope":133,"rating_par":72,"source_tee":"Red Tees","source_yardage":5321,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23725"},

  {"course":"Pinehurst No. 3","tee":"White","category":"M","rating":66.1,"slope":123,"rating_par":68,"source_tee":"White Tees","source_yardage":5159,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23726"},
  {"course":"Pinehurst No. 3","tee":"White","category":"F","rating":71.2,"slope":125,"rating_par":68,"source_tee":"White Tees","source_yardage":5159,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23726"},
  {"course":"Pinehurst No. 3","tee":"Green","category":"M","rating":64.8,"slope":118,"rating_par":68,"source_tee":"Green Tees","source_yardage":4813,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23726"},
  {"course":"Pinehurst No. 3","tee":"Green","category":"F","rating":69.2,"slope":121,"rating_par":68,"source_tee":"Green Tees","source_yardage":4813,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23726"},
  {"course":"Pinehurst No. 3","tee":"Red","category":"M","rating":63.0,"slope":109,"rating_par":68,"source_tee":"Red Tees","source_yardage":4372,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23726"},
  {"course":"Pinehurst No. 3","tee":"Red","category":"F","rating":66.4,"slope":118,"rating_par":68,"source_tee":"Red Tees","source_yardage":4372,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23726"},
  {"course":"Pinehurst No. 3","tee":"Yellow","category":"M","rating":60.4,"slope":105,"rating_par":64,"source_tee":"Yellow Tees","source_yardage":3723,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23726"},
  {"course":"Pinehurst No. 3","tee":"Yellow","category":"F","rating":63.0,"slope":110,"rating_par":68,"source_tee":"Yellow Tees","source_yardage":3723,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23726"},

  {"course":"Pinehurst No. 4","tee":"Lad","category":"M","rating":69.5,"slope":126,"rating_par":72,"source_tee":"White/Green Hybrid","source_yardage":6129,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23727"},
  {"course":"Pinehurst No. 4","tee":"Lad","category":"F","rating":75.2,"slope":136,"rating_par":72,"source_tee":"White/Green Hybrid","source_yardage":6129,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23727"},

  {"course":"Pinehurst No. 5","tee":"Gold","category":"M","rating":72.7,"slope":136,"rating_par":72,"source_tee":"Gold Tees","source_yardage":6771,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23728"},

  {"course":"Pinehurst No. 6","tee":"Cardinal","category":"M","rating":67.0,"slope":122,"rating_par":72,"source_tee":"Green/Red Hybrid","source_yardage":5378,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23730"},
  {"course":"Pinehurst No. 6","tee":"Cardinal","category":"F","rating":72.1,"slope":130,"rating_par":72,"source_tee":"Green/Red Hybrid","source_yardage":5378,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23730","stroke_indexes":[3,7,15,17,1,13,11,9,5,16,12,2,14,6,10,18,4,8]},

  {"course":"Pinehurst No. 9","tee":"Gold","category":"M","rating":75.2,"slope":143,"rating_par":72,"source_tee":"Gold Tees","source_yardage":7097,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23739"},
  {"course":"Pinehurst No. 9","tee":"Blue","category":"M","rating":73.1,"slope":139,"rating_par":72,"source_tee":"Blue Tees","source_yardage":6653,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23739"},
  {"course":"Pinehurst No. 9","tee":"White","category":"M","rating":70.5,"slope":135,"rating_par":72,"source_tee":"White Tees","source_yardage":6172,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23739"},
  {"course":"Pinehurst No. 9","tee":"White","category":"F","rating":76.6,"slope":140,"rating_par":72,"source_tee":"White Tees","source_yardage":6172,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23739"},
  {"course":"Pinehurst No. 9","tee":"National","category":"M","rating":69.3,"slope":130,"rating_par":72,"source_tee":"National Hybrid","source_yardage":5897,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23739"},
  {"course":"Pinehurst No. 9","tee":"National","category":"F","rating":75.1,"slope":137,"rating_par":72,"source_tee":"National Hybrid","source_yardage":5897,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23739"},
  {"course":"Pinehurst No. 9","tee":"Green","category":"M","rating":68.5,"slope":124,"rating_par":72,"source_tee":"Green Tees","source_yardage":5619,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23739"},
  {"course":"Pinehurst No. 9","tee":"Green","category":"F","rating":73.5,"slope":133,"rating_par":72,"source_tee":"Green Tees","source_yardage":5619,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23739"},
  {"course":"Pinehurst No. 9","tee":"Red","category":"M","rating":65.0,"slope":110,"rating_par":72,"source_tee":"Red Tees","source_yardage":4774,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23739"},
  {"course":"Pinehurst No. 9","tee":"Red","category":"F","rating":69.0,"slope":121,"rating_par":72,"source_tee":"Red Tees","source_yardage":4774,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23739"},
  {"course":"Pinehurst No. 9","tee":"Golden Bear","category":"M","rating":62.7,"slope":106,"rating_par":68,"source_tee":"Red/Yellow Hybrid","source_yardage":4193,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23739"},
  {"course":"Pinehurst No. 9","tee":"Golden Bear","category":"F","rating":65.9,"slope":114,"rating_par":72,"source_tee":"Red/Yellow Hybrid","source_yardage":4193,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23739"},
  {"course":"Pinehurst No. 9","tee":"Yellow","category":"M","rating":60.4,"slope":102,"rating_par":67,"source_tee":"Yellow Tees","source_yardage":3741,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23739"},
  {"course":"Pinehurst No. 9","tee":"Yellow","category":"F","rating":63.2,"slope":109,"rating_par":72,"source_tee":"Yellow Tees","source_yardage":3741,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=23739"},

  {"course":"The Cradle","tee":"Current course tee","category":"M","rating":25.0,"slope":74,"rating_par":27,"source_tee":"Cradle - Men","source_yardage":766,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=33642"},
  {"course":"The Cradle","tee":"Current course tee","category":"F","rating":26.3,"slope":75,"rating_par":27,"source_tee":"Cradle - Women","source_yardage":766,"source_url":"https://ncrdb.usga.org/courseTeeInfo?CourseID=33642"}
]
$ratings$::jsonb);

update public.courses
set source_notes = 'Current scorecard geometry retained. Ratings and slopes are linked to current USGA NCRDB tee designations; the registered NCRDB length/par is preserved in each tee note when it differs.'
where name in (
  'Pinehurst No. 2', 'Pinehurst No. 3', 'Pinehurst No. 4',
  'Pinehurst No. 5', 'Pinehurst No. 6', 'Pinehurst No. 9', 'The Cradle'
);

drop function public.apply_current_course_ratings(jsonb);
