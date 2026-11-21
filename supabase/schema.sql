-- 남코녀 사전설문 · 준비판 데이터베이스 (Supabase SQL Editor에 통째로 붙여 넣어 실행)
-- 실행 전에 맨 아래 함수 주소 자리표시자를 실제 Edge Function 주소(https://<프로젝트>.supabase.co/functions/v1/analyze)로 바꿉니다.

create extension if not exists pg_net;

-- 1) 고객 사전설문 -------------------------------------------------------
create table if not exists public.surveys (
  id uuid primary key,
  created_at timestamptz not null default now(),
  name text not null,
  phone text not null,
  age int,
  job text,
  region text,
  height_weight text,
  sizes text,
  body_concerns text[] default '{}',
  budget text,
  fashion_level text,
  expectation text,
  prior_services text[] default '{}',
  prior_result text,
  shoes text,
  pants text,
  photos jsonb not null default '{"body":[],"style":[],"face":[]}',
  consent_privacy boolean not null default false,
  consent_ai boolean not null default false,
  -- 대표님이 준비판에서 채우는 칸
  consult_date date,
  consult_time text,
  service text,
  admin_memo text,
  constraint consent_required check (consent_privacy and consent_ai)
);

-- 2) AI 계획서 ------------------------------------------------------------
create table if not exists public.plans (
  survey_id uuid primary key references public.surveys(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','processing','done','error')),
  plan jsonb,
  model text,
  error text,
  usage jsonb,
  updated_at timestamptz not null default now()
);

-- 3) 현장 기록 ------------------------------------------------------------
create table if not exists public.onsite (
  survey_id uuid primary key references public.surveys(id) on delete cascade,
  shoulder numeric, waist numeric, hip numeric,
  body_type text, bone text, color text, style text,
  color_chroma text, color_value text, color_clarity text, color_temp text, exception text,
  checks text[] default '{}',
  memo text,
  updated_at timestamptz not null default now()
);

-- 4) 관리자(대표님 계정) · 설정 -------------------------------------------
create table if not exists public.admins (user_id uuid primary key references auth.users(id) on delete cascade);
create table if not exists public.settings (key text primary key, value text not null, updated_at timestamptz default now());

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.admins where user_id = auth.uid()) $$;

-- 5) 접근 권한 ---------------------------------------------------------------
-- (프로젝트의 '새 표 자동 공개' 설정과 상관없이 동작하도록 명시적으로 허용, 실제 범위는 아래 RLS가 정함)
grant usage on schema public to anon, authenticated;
grant insert on public.surveys to anon;
grant select, insert, update, delete on public.surveys, public.plans, public.onsite, public.settings to authenticated;
grant select on public.admins to authenticated;
grant execute on function public.is_admin() to anon, authenticated;
grant usage on schema public to service_role;
grant all on public.surveys, public.plans, public.onsite, public.admins, public.settings to service_role;

alter table public.surveys enable row level security;
alter table public.plans enable row level security;
alter table public.onsite enable row level security;
alter table public.admins enable row level security;
alter table public.settings enable row level security;

drop policy if exists "customer submit" on public.surveys;
create policy "customer submit" on public.surveys for insert to anon, authenticated with check (consent_privacy and consent_ai);
drop policy if exists "admin all surveys" on public.surveys;
create policy "admin all surveys" on public.surveys for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin all plans" on public.plans;
create policy "admin all plans" on public.plans for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin all onsite" on public.onsite;
create policy "admin all onsite" on public.onsite for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin read admins" on public.admins;
create policy "admin read admins" on public.admins for select to authenticated using (user_id = auth.uid());
drop policy if exists "admin settings" on public.settings;
create policy "admin settings" on public.settings for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- 6) 사진 저장소 (비공개, 10MB, 이미지만) ------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('survey-photos', 'survey-photos', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists "customer upload photos" on storage.objects;
create policy "customer upload photos" on storage.objects for insert to anon, authenticated with check (bucket_id = 'survey-photos');
drop policy if exists "admin read photos" on storage.objects;
create policy "admin read photos" on storage.objects for select to authenticated using (bucket_id = 'survey-photos' and public.is_admin());

-- 7) 실시간 반영 (준비판이 계획서 완성을 바로 알도록) -------------------------
do $$ begin
  begin alter publication supabase_realtime add table public.plans; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.surveys; exception when duplicate_object then null; end;
end $$;

-- 8) 설문이 들어오면 계획서 작업을 예약하고 AI 함수를 호출 ---------------------
create or replace function public.queue_plan() returns trigger
language plpgsql security definer set search_path = public as
$$
begin
  insert into public.plans (survey_id, status) values (new.id, 'queued')
  on conflict (survey_id) do update set status = 'queued', updated_at = now();
  perform net.http_post(
    url := '__FUNCTION_URL__',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('survey_id', new.id)
  );
  return new;
end
$$;

drop trigger if exists on_survey_insert on public.surveys;
create trigger on_survey_insert after insert on public.surveys
for each row execute function public.queue_plan();

-- 현장 확정값: 퍼스널컬러 4가지 축 + 예외사항 (기존 DB에 추가)
alter table public.onsite add column if not exists color_chroma text, add column if not exists color_value text,
  add column if not exists color_clarity text, add column if not exists color_temp text, add column if not exists exception text;

-- 고객 리포트용 현장 기록 (이미지·스타일 방향·안경 순위·헤어 진단·구매 리스트·공식·동행쇼핑 사진 경로)
alter table public.onsite add column if not exists report jsonb;
