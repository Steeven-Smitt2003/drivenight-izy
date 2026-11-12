-- DriveNight : profil modifiable, contacts entre participants, véhicule par catégorie,
-- annulation avec auteur, photos de profil de tout format.

-- 1. Véhicule : une moto n'a plus de matricule.
alter table public.driver_profiles alter column vehicle_registration drop not null;

-- 2. Qui a annulé la course (passager ou chauffeur).
alter table public.rides
  add column if not exists cancelled_by uuid references public.profiles(id) on delete set null;

-- 3. Inscription chauffeur : couleur (moto) ou marque, matricule et couleur (voiture).
create or replace function public.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  metadata jsonb := new.raw_user_meta_data;
  auth_phone text := coalesce(
    nullif(trim(new.phone), ''),
    nullif(trim(metadata ->> 'phone'), '')
  );
  selected_role public.account_role;
  selected_category text := case
    when metadata ->> 'vehicle_category' = 'voiture' then 'voiture' else 'moto' end;
  selected_color text := nullif(trim(metadata ->> 'vehicle_color'), '');
  selected_make text := nullif(trim(metadata ->> 'vehicle_make'), '');
  selected_registration text := nullif(trim(metadata ->> 'vehicle_registration'), '');
begin
  if metadata ->> 'terms_accepted' is distinct from 'true' then
    raise exception 'TERMS_NOT_ACCEPTED' using errcode = '22023';
  end if;
  if auth_phone is null or nullif(trim(metadata ->> 'name'), '') is null then
    raise exception 'ACCOUNT_DETAILS_REQUIRED' using errcode = '22023';
  end if;
  if auth_phone !~ '^\+2613[0-9]{8}$' then
    raise exception 'PHONE_INVALID' using errcode = '22023';
  end if;
  if new.phone is null and new.email is distinct from
    regexp_replace(auth_phone, '[^0-9]', '', 'g') || '@auth.drivenight.invalid' then
    raise exception 'AUTH_IDENTITY_INVALID' using errcode = '22023';
  end if;

  selected_role := case
    when metadata ->> 'role' = 'driver' then 'driver'::public.account_role
    else 'passenger'::public.account_role
  end;

  if selected_role = 'driver' then
    if selected_color is null then
      raise exception 'DRIVER_VEHICLE_REQUIRED' using errcode = '22023';
    end if;
    if selected_category = 'voiture' and (
      selected_make is null
      or selected_registration is null
      or length(selected_registration) not between 3 and 20
    ) then
      raise exception 'DRIVER_VEHICLE_REQUIRED' using errcode = '22023';
    end if;
    if selected_category = 'moto' then
      selected_registration := null;
    end if;
  end if;

  insert into public.profiles (id, role, name, email, phone, terms_version)
  values (
    new.id,
    selected_role,
    trim(metadata ->> 'name'),
    case
      when new.email like '%@auth.drivenight.invalid' then null
      else nullif(lower(trim(new.email)), '')
    end,
    auth_phone,
    coalesce(nullif(metadata ->> 'terms_version', ''), '2026-11-05')
  );
  if selected_role = 'driver' then
    insert into public.driver_profiles (
      user_id, vehicle_category, vehicle_make, vehicle_color, vehicle_registration
    )
    values (new.id, selected_category, selected_make, selected_color, selected_registration);
  end if;
  return new;
end;
$$;

-- 4. Le chauffeur modifie les détails de son véhicule (la catégorie reste fixe).
create or replace function public.update_my_vehicle(
  p_make text, p_model text, p_color text, p_registration text
)
returns public.driver_profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := public.require_active_account();
  saved public.driver_profiles;
  next_make text := nullif(trim(p_make), '');
  next_model text := nullif(trim(p_model), '');
  next_color text := nullif(trim(p_color), '');
  next_registration text := nullif(trim(p_registration), '');
begin
  select * into saved from public.driver_profiles
  where user_id = current_user_id for update;
  if not found then
    raise exception 'DRIVER_REQUIRED' using errcode = '42501';
  end if;
  if next_color is null then
    raise exception 'DRIVER_VEHICLE_REQUIRED' using errcode = '22023';
  end if;
  if saved.vehicle_category = 'voiture' then
    if next_make is null or next_registration is null
      or length(next_registration) not between 3 and 20 then
      raise exception 'DRIVER_VEHICLE_REQUIRED' using errcode = '22023';
    end if;
  else
    next_registration := saved.vehicle_registration;
  end if;
  begin
    update public.driver_profiles
    set vehicle_make = next_make,
        vehicle_model = next_model,
        vehicle_color = next_color,
        vehicle_registration = next_registration,
        updated_at = now()
    where user_id = current_user_id
    returning * into saved;
  exception when unique_violation then
    raise exception 'VEHICLE_ALREADY_EXISTS' using errcode = '23505';
  end;
  return saved;
end;
$$;

-- 5. Changement de numéro de téléphone (identifiant de connexion) avec le mot de passe actuel.
create or replace function public.change_my_phone(p_new_phone text, p_password text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := public.require_active_account();
  normalized text := regexp_replace(trim(coalesce(p_new_phone, '')), '[\s().-]', '', 'g');
  new_email text;
begin
  if normalized ~ '^03[0-9]{8}$' then
    normalized := '+261' || substr(normalized, 2);
  end if;
  if normalized !~ '^\+2613[0-9]{8}$' then
    raise exception 'PHONE_INVALID' using errcode = '22023';
  end if;
  if not exists (
    select 1 from auth.users u
    where u.id = current_user_id
      and u.encrypted_password = extensions.crypt(coalesce(p_password, ''), u.encrypted_password)
  ) then
    perform pg_sleep(0.5);
    raise exception 'CURRENT_PASSWORD_INVALID' using errcode = '28P01';
  end if;
  if exists (
    select 1 from public.profiles where phone = normalized and id <> current_user_id
  ) then
    raise exception 'PHONE_ALREADY_IN_USE' using errcode = '23505';
  end if;

  new_email := regexp_replace(normalized, '[^0-9]', '', 'g') || '@auth.drivenight.invalid';
  update auth.users
  set email = new_email,
      email_confirmed_at = coalesce(email_confirmed_at, now()),
      phone = case when phone is not null then substr(normalized, 2) else phone end,
      raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
        || jsonb_build_object('phone', normalized),
      updated_at = now()
  where id = current_user_id;
  update auth.identities
  set provider_id = new_email,
      identity_data = identity_data || jsonb_build_object('email', new_email),
      updated_at = now()
  where user_id = current_user_id and provider = 'email';
  update public.profiles
  set phone = normalized, updated_at = now()
  where id = current_user_id;
  return normalized;
end;
$$;

-- 6. Changement de mot de passe avec vérification du mot de passe actuel.
create or replace function public.change_my_password(p_current text, p_new text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := public.require_active_account();
begin
  if p_new is null or length(p_new) not between 10 and 128 then
    raise exception 'PASSWORD_TOO_SHORT' using errcode = '22023';
  end if;
  if not exists (
    select 1 from auth.users u
    where u.id = current_user_id
      and u.encrypted_password = extensions.crypt(coalesce(p_current, ''), u.encrypted_password)
  ) then
    perform pg_sleep(0.5);
    raise exception 'CURRENT_PASSWORD_INVALID' using errcode = '28P01';
  end if;
  update auth.users
  set encrypted_password = extensions.crypt(p_new, extensions.gen_salt('bf')),
      updated_at = now()
  where id = current_user_id;
  return true;
end;
$$;

-- 7. Numéros visibles uniquement entre personnes liées par une demande ou une course.
create or replace function public.contact_phones(p_user_ids uuid[])
returns table (user_id uuid, phone text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.phone
  from public.profiles p
  where p.id = any (p_user_ids)
    and p.is_active
    and exists (
      select 1 from public.profiles me
      where me.id = (select auth.uid()) and me.is_active
    )
    and (
      p.id = (select auth.uid())
      or exists (
        select 1 from public.rides r
        where r.passenger_id = (select auth.uid())
          and (
            r.driver_id = p.id
            or exists (
              select 1 from public.ride_offers o
              where o.ride_id = r.id and o.proposer_id = p.id
            )
          )
      )
      or exists (
        select 1 from public.rides r
        where r.passenger_id = p.id
          and (
            r.driver_id = (select auth.uid())
            or exists (
              select 1 from public.ride_offers o
              where o.ride_id = r.id and o.proposer_id = (select auth.uid())
            )
            or (
              r.status in ('searching', 'negotiating')
              and exists (
                select 1 from public.driver_profiles d
                where d.user_id = (select auth.uid())
                  and d.is_online and d.vehicle_category = r.category
              )
            )
          )
      )
    );
$$;

-- 8. Annulation par le passager ou le chauffeur, avec l'auteur enregistré.
create or replace function public.cancel_ride(p_ride_id uuid)
returns public.rides
language plpgsql
security definer
set search_path = ''
as $$
declare target_ride public.rides;
begin
  select * into target_ride from public.rides where id = p_ride_id for update;
  if not found or (
    target_ride.passenger_id <> (select auth.uid())
    and target_ride.driver_id is distinct from (select auth.uid())
  ) then
    raise exception 'RIDE_NOT_FOUND' using errcode = '42501';
  end if;
  if target_ride.status not in ('searching', 'negotiating', 'driver_en_route', 'driver_arrived') then
    raise exception 'RIDE_CANNOT_BE_CANCELLED' using errcode = '22023';
  end if;
  update public.rides
  set status = 'cancelled', cancelled_at = now(), cancelled_by = (select auth.uid()), updated_at = now()
  where id = p_ride_id returning * into target_ride;
  update public.ride_offers set status = 'withdrawn', responded_at = now()
  where ride_id = p_ride_id and status = 'pending';
  delete from public.ride_locations where ride_id = p_ride_id;
  return target_ride;
end;
$$;

-- 9. Le matricule d'une voiture aide le passager à reconnaître son chauffeur.
create or replace view public.public_driver_profiles
with (security_invoker = false)
as
select
  d.user_id, p.name, p.photo_path, p.average_rating, p.rating_count,
  d.vehicle_category, d.vehicle_make, d.vehicle_model, d.vehicle_color, d.is_online,
  d.vehicle_registration
from public.driver_profiles d
join public.profiles p on p.id = d.user_id
where p.is_active;
revoke all on table public.public_driver_profiles from public, anon, authenticated;
grant select on table public.public_driver_profiles to authenticated;

-- 10. Photos de profil : toute image, jusqu'à 20 Mo.
update storage.buckets
set file_size_limit = 20971520,
    allowed_mime_types = array['image/*']
where id = 'profile-photos';

revoke all on function public.update_my_vehicle(text, text, text, text) from public, anon;
revoke all on function public.change_my_phone(text, text) from public, anon;
revoke all on function public.change_my_password(text, text) from public, anon;
revoke all on function public.contact_phones(uuid[]) from public, anon;
revoke all on function public.cancel_ride(uuid) from public, anon;
grant execute on function public.update_my_vehicle(text, text, text, text) to authenticated;
grant execute on function public.change_my_phone(text, text) to authenticated;
grant execute on function public.change_my_password(text, text) to authenticated;
grant execute on function public.contact_phones(uuid[]) to authenticated;
grant execute on function public.cancel_ride(uuid) to authenticated;
revoke all on function public.create_profile_for_auth_user() from public, anon, authenticated;
