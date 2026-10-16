create extension if not exists pgcrypto;

create table if not exists public.generations (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid not null,
  person_path text not null,
  garment_path text not null,
  prompt text not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed')),
  runpod_job_id text,
  result_path text,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists generations_guest_created_idx
  on public.generations (guest_id, created_at desc);

alter table public.generations enable row level security;

-- Deliberately add no anon/authenticated policies. The server uses the
-- service-role key and scopes every query to the guest UUID supplied by the app.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('try on', 'try on', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
