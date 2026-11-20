create table if not exists public.lookbook (
  key text primary key, name text, style text, season text, items text, colors text, bone text, path text not null,
  active boolean not null default true, created_at timestamptz not null default now());
alter table public.lookbook enable row level security;
grant select, insert, update, delete on public.lookbook to authenticated;
grant all on public.lookbook to service_role;
drop policy if exists "admin lookbook" on public.lookbook;
create policy "admin lookbook" on public.lookbook for all to authenticated using (public.is_admin()) with check (public.is_admin());
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('lookbook', 'lookbook', false, 5242880, array['image/jpeg','image/png','image/webp']) on conflict (id) do nothing;
drop policy if exists "admin lookbook files" on storage.objects;
create policy "admin lookbook files" on storage.objects for all to authenticated using (bucket_id = 'lookbook' and public.is_admin()) with check (bucket_id = 'lookbook' and public.is_admin());
