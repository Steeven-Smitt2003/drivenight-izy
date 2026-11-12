-- DriveNight : création et suppression de comptes par admin,
-- expiration des demandes sans offre après 30 minutes,
-- historique limité à 24 heures.

-- 1. Création directe d'un compte administrateur par un administrateur connecté
create or replace function public.admin_create_admin(
  p_name text, p_phone text, p_password text, p_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := public.require_active_account();
  caller_role public.account_role;
  normalized_phone text := regexp_replace(trim(coalesce(p_phone, '')), '[\s().-]', '', 'g');
  new_user_id uuid := extensions.gen_random_uuid();
  clean_name text := nullif(trim(p_name), '');
  auth_email text;
begin
  select role into caller_role from public.profiles where id = caller_id;
  if caller_role is distinct from 'admin' then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  if clean_name is null or length(clean_name) < 2 then
    raise exception 'NAME_INVALID' using errcode = '22023';
  end if;

  if normalized_phone ~ '^03[0-9]{8}$' then
    normalized_phone := '+261' || substr(normalized_phone, 2);
  end if;
  if normalized_phone !~ '^\+2613[0-9]{8}$' then
    raise exception 'PHONE_INVALID' using errcode = '22023';
  end if;

  if p_password is null or length(p_password) < 10 then
    raise exception 'PASSWORD_TOO_SHORT' using errcode = '22023';
  end if;

  if exists (select 1 from public.profiles where phone = normalized_phone) then
    raise exception 'PHONE_ALREADY_IN_USE' using errcode = '23505';
  end if;

  auth_email := regexp_replace(normalized_phone, '[^0-9]', '', 'g') || '@auth.drivenight.invalid';

  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values (
    new_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    auth_email, extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('name', clean_name, 'phone', normalized_phone, 'role', 'admin', 'terms_accepted', true),
    now(), now()
  );

  insert into auth.identities (
    id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
  ) values (
    extensions.gen_random_uuid(), new_user_id,
    jsonb_build_object('sub', new_user_id::text, 'email', auth_email),
    'email', auth_email, now(), now(), now()
  );

  insert into public.profiles (
    id, role, name, phone, email, is_active, terms_version
  ) values (
    new_user_id, 'admin', clean_name, normalized_phone, nullif(lower(trim(p_email)), ''), true, '2026-11-05'
  );

  return jsonb_build_object(
    'id', new_user_id,
    'name', clean_name,
    'phone', normalized_phone,
    'role', 'admin',
    'isActive', true
  );
end;
$$;

-- 2. Suppression définitive d'un compte (passager, chauffeur ou autre admin) par un admin
create or replace function public.admin_delete_account(p_account_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := public.require_active_account();
  caller_role public.account_role;
begin
  select role into caller_role from public.profiles where id = caller_id;
  if caller_role is distinct from 'admin' then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  if p_account_id = caller_id then
    raise exception 'CANNOT_DELETE_SELF' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.rides
    where (passenger_id = p_account_id or driver_id = p_account_id)
      and status in ('driver_en_route', 'driver_arrived', 'in_progress')
  ) then
    raise exception 'ACCOUNT_HAS_ACTIVE_RIDE' using errcode = '22023';
  end if;

  -- Rompre d'abord les auto-références sur les offres
  update public.ride_offers set responds_to_offer_id = null
  where proposer_id = p_account_id
     or ride_id in (select id from public.rides where passenger_id = p_account_id or driver_id = p_account_id);

  delete from public.chat_messages
  where sender_id = p_account_id
     or ride_id in (select id from public.rides where passenger_id = p_account_id or driver_id = p_account_id);

  delete from public.ride_offers
  where proposer_id = p_account_id
     or ride_id in (select id from public.rides where passenger_id = p_account_id or driver_id = p_account_id);

  delete from public.ratings
  where rater_id = p_account_id
     or ratee_id = p_account_id
     or ride_id in (select id from public.rides where passenger_id = p_account_id or driver_id = p_account_id);

  delete from public.ride_locations
  where driver_id = p_account_id
     or ride_id in (select id from public.rides where passenger_id = p_account_id or driver_id = p_account_id);

  delete from public.rides
  where passenger_id = p_account_id or driver_id = p_account_id;

  delete from public.driver_profiles where user_id = p_account_id;
  delete from public.presence where user_id = p_account_id;
  delete from public.profiles where id = p_account_id;

  begin
    delete from auth.refresh_tokens
    where session_id in (select id from auth.sessions where user_id = p_account_id);
    delete from auth.sessions where user_id = p_account_id;
    delete from auth.mfa_challenges
    where factor_id in (select id from auth.mfa_factors where user_id = p_account_id);
    delete from auth.mfa_factors where user_id = p_account_id;
    delete from auth.identities where user_id = p_account_id;
    delete from auth.users where id = p_account_id;
  exception when others then
    update auth.users
    set banned_until = '2999-01-01 00:00:00+00'
    where id = p_account_id;
  end;

  return true;
end;
$$;

-- 3. Expiration automatique des demandes de course après 30 minutes sans acceptation ni offre
create or replace function public.expire_stale_rides()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.rides r
  set status = 'cancelled', cancelled_at = now(), updated_at = now()
  where r.status in ('searching', 'negotiating')
    and r.requested_at < (now() - interval '30 minutes')
    and not exists (
      select 1 from public.ride_offers o
      where o.ride_id = r.id
        and (
          (o.proposer_id <> r.passenger_id and o.status in ('pending', 'accepted'))
          or o.status = 'accepted'
        )
    );
end;
$$;

-- 4. Suppression définitive d'une demande de trajet par un administrateur
create or replace function public.admin_delete_ride(p_ride_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := public.require_active_account();
  caller_role public.account_role;
begin
  select role into caller_role from public.profiles where id = caller_id;
  if caller_role is distinct from 'admin' then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  update public.ride_offers set responds_to_offer_id = null where ride_id = p_ride_id;
  delete from public.chat_messages where ride_id = p_ride_id;
  delete from public.ride_offers where ride_id = p_ride_id;
  delete from public.ratings where ride_id = p_ride_id;
  delete from public.ride_locations where ride_id = p_ride_id;
  delete from public.rides where id = p_ride_id;

  return true;
end;
$$;

revoke all on function public.admin_create_admin(text, text, text, text) from public, anon;
revoke all on function public.admin_delete_account(uuid) from public, anon;
revoke all on function public.admin_delete_ride(uuid) from public, anon;
revoke all on function public.expire_stale_rides() from public, anon;
grant execute on function public.admin_create_admin(text, text, text, text) to authenticated;
grant execute on function public.admin_delete_account(uuid) to authenticated;
grant execute on function public.admin_delete_ride(uuid) to authenticated;
grant execute on function public.expire_stale_rides() to authenticated;
