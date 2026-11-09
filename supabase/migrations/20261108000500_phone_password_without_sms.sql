alter table public.profiles alter column email drop not null;

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
    insert into public.driver_profiles (user_id, vehicle_category, vehicle_registration)
    values (
      new.id,
      case when metadata ->> 'vehicle_category' in ('moto', 'taxi', 'voiture')
        then metadata ->> 'vehicle_category' else 'moto' end,
      trim(metadata ->> 'vehicle_registration')
    );
  end if;
  return new;
end;
$$;
