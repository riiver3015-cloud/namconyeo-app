-- 헤어·메이크업 선생님 업로드 기능 (Supabase SQL Editor에서 실행)

-- 1) 고객별 업로드 링크 (대표님이 준비판에서 만듦)
create table if not exists public.stylist_links (
  token text primary key,
  survey_id uuid not null references public.surveys(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);

-- 2) 선생님이 올린 파일 기록
create table if not exists public.stylist_uploads (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  role text not null check (role in ('hair','makeup')),
  kind text not null check (kind in ('video','before','after')),
  path text not null,
  content_type text,
  uploader text,
  note text,
  created_at timestamptz not null default now(),
  constraint makeup_no_video check (not (role = 'makeup' and kind = 'video'))
);

alter table public.stylist_links enable row level security;
alter table public.stylist_uploads enable row level security;

grant select, insert, update, delete on public.stylist_links, public.stylist_uploads to authenticated;
grant all on public.stylist_links, public.stylist_uploads to service_role;

drop policy if exists "admin stylist links" on public.stylist_links;
create policy "admin stylist links" on public.stylist_links for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin stylist uploads" on public.stylist_uploads;
create policy "admin stylist uploads" on public.stylist_uploads for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 3) 링크가 유효한지 확인 (선생님은 표를 직접 볼 수 없고 이 함수로만 확인)
create or replace function public.stylist_token_ok(t text) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.stylist_links where token = t and expires_at > now()) $$;

-- 선생님 화면에 보여줄 최소 정보 (이름 가운데 가림, 날짜, 서비스)
create or replace function public.stylist_link_info(t text) returns json
language sql stable security definer set search_path = public as
$$
  select json_build_object(
    'customer', case when char_length(s.name) >= 3 then left(s.name, 1) || repeat('*', char_length(s.name) - 2) || right(s.name, 1)
                     when char_length(s.name) = 2 then left(s.name, 1) || '*' else s.name end,
    'date', s.consult_date, 'time', s.consult_time, 'service', s.service,
    'counts', (select json_object_agg(k, c) from (select role || '_' || kind as k, count(*) as c from public.stylist_uploads u where u.survey_id = s.id group by 1) x)
  )
  from public.stylist_links l join public.surveys s on s.id = l.survey_id
  where l.token = t and l.expires_at > now()
$$;

-- 업로드한 파일 기록 (링크 확인 후 저장)
create or replace function public.stylist_register_upload(t text, p_role text, p_kind text, p_path text, p_type text, p_uploader text, p_note text)
returns boolean language plpgsql security definer set search_path = public as
$$
declare sid uuid;
begin
  select survey_id into sid from public.stylist_links where token = t and expires_at > now();
  if sid is null then raise exception '링크가 만료되었거나 올바르지 않아요'; end if;
  if split_part(p_path, '/', 1) <> t then raise exception '잘못된 파일 경로'; end if;
  insert into public.stylist_uploads (survey_id, role, kind, path, content_type, uploader, note)
  values (sid, p_role, p_kind, p_path, p_type, left(p_uploader, 40), left(p_note, 500));
  return true;
end
$$;

grant execute on function public.stylist_token_ok(text), public.stylist_link_info(text), public.stylist_register_upload(text, text, text, text, text, text, text) to anon, authenticated;

-- 4) 파일 저장소 (비공개, 파일당 50MB, 사진·영상만)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('stylist-uploads', 'stylist-uploads', false, 52428800,
        array['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime','video/webm','video/3gpp'])
on conflict (id) do update set public = false, file_size_limit = 52428800,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime','video/webm','video/3gpp'];

drop policy if exists "stylist upload with valid link" on storage.objects;
create policy "stylist upload with valid link" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'stylist-uploads' and public.stylist_token_ok((storage.foldername(name))[1]));
drop policy if exists "admin read stylist files" on storage.objects;
create policy "admin read stylist files" on storage.objects for select to authenticated
  using (bucket_id = 'stylist-uploads' and public.is_admin());

-- 5) 준비판 실시간 반영
do $$ begin
  begin alter publication supabase_realtime add table public.stylist_uploads; exception when duplicate_object then null; end;
end $$;
