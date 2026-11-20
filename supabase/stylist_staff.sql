-- 헤메 선생님 고정 링크 (선생님별 1개, 링크 안에서 고객 선택)

create table if not exists public.stylist_staff (
  token text primary key,
  role text not null check (role in ('hair','makeup')),
  name text not null,
  salon text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.stylist_staff enable row level security;
grant select, insert, update, delete on public.stylist_staff to authenticated;
grant all on public.stylist_staff to service_role;
drop policy if exists "admin stylist staff" on public.stylist_staff;
create policy "admin stylist staff" on public.stylist_staff for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 선생님이 볼 수 있는 고객: 서비스에 '헤메'가 있고, 컨설팅 날짜가 최근 30일 ~ 앞으로 7일
create or replace function public.stylist_customer_ok(sid uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.surveys s where s.id = sid and s.service like '%헤메%'
                  and s.consult_date between (now() at time zone 'Asia/Seoul')::date - 30 and (now() at time zone 'Asia/Seoul')::date + 7) $$;

-- 고정 링크도 사진 저장소에 올릴 수 있도록 (기존 고객별 링크도 계속 허용)
create or replace function public.stylist_token_ok(t text) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.stylist_links where token = t and expires_at > now())
       or exists (select 1 from public.stylist_staff where token = t and active) $$;

-- 선생님 화면 정보: 선생님 이름·역할 + 고를 수 있는 고객 목록(이름 가림)
create or replace function public.staff_info(t text) returns json
language sql stable security definer set search_path = public as
$$
  select json_build_object(
    'name', st.name, 'salon', st.salon, 'role', st.role,
    'customers', coalesce((
      select json_agg(json_build_object(
        'id', s.id,
        'label', case when char_length(s.name) >= 3 then left(s.name, 1) || repeat('*', char_length(s.name) - 2) || right(s.name, 1)
                      when char_length(s.name) = 2 then left(s.name, 1) || '*' else s.name end,
        'date', s.consult_date, 'time', s.consult_time, 'service', s.service,
        'sent', (select count(*) from public.stylist_uploads u where u.survey_id = s.id and u.role = st.role)
      ) order by s.consult_date desc, s.consult_time desc)
      from public.surveys s
      where public.stylist_customer_ok(s.id)
    ), '[]'::json)
  )
  from public.stylist_staff st where st.token = t and st.active
$$;

-- 선생님이 올린 사진 기록 (링크·고객 확인 후 저장, 역할·이름은 링크에서 자동)
create or replace function public.staff_register_upload(t text, p_survey uuid, p_kind text, p_path text, p_type text, p_note text)
returns boolean language plpgsql security definer set search_path = public as
$$
declare st public.stylist_staff;
begin
  select * into st from public.stylist_staff where token = t and active;
  if st.token is null then raise exception '링크가 올바르지 않아요'; end if;
  if not public.stylist_customer_ok(p_survey) then raise exception '선택할 수 없는 고객이에요'; end if;
  if p_kind not in ('before','after') then raise exception '사진 종류가 올바르지 않아요'; end if;
  if split_part(p_path, '/', 1) <> t then raise exception '잘못된 파일 경로'; end if;
  insert into public.stylist_uploads (survey_id, role, kind, path, content_type, uploader, note)
  values (p_survey, st.role, p_kind, p_path, p_type, coalesce(st.salon || ' ', '') || st.name, left(p_note, 500));
  return true;
end
$$;

grant execute on function public.stylist_customer_ok(uuid), public.staff_info(text), public.staff_register_upload(text, uuid, text, text, text, text) to anon, authenticated;
