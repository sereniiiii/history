-- 历史知识库 · Supabase 初始化
-- 在 Supabase Dashboard → SQL Editor 里整段执行一次。
-- 作用：每个登录邮箱一行 JSON 数据；只能读写自己的行。

create table if not exists public.history_user_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.history_user_state enable row level security;

revoke all on public.history_user_state from anon;
grant select, insert, update, delete
on public.history_user_state
to authenticated;

drop policy if exists "read own history state" on public.history_user_state;
create policy "read own history state"
on public.history_user_state
for select to authenticated
using (auth.uid() = user_id);

drop policy if exists "insert own history state" on public.history_user_state;
create policy "insert own history state"
on public.history_user_state
for insert to authenticated
with check (auth.uid() = user_id);

drop policy if exists "update own history state" on public.history_user_state;
create policy "update own history state"
on public.history_user_state
for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "delete own history state" on public.history_user_state;
create policy "delete own history state"
on public.history_user_state
for delete to authenticated
using (auth.uid() = user_id);
