-- Normalize existing Malagasy numbers before enforcing one canonical identity.
do $$
begin
  if exists (
    select 1
    from public.profiles
    group by case
      when regexp_replace(trim(phone), '[[:space:]().-]', '', 'g') ~ '^03[0-9]{8}$'
        then '+261' || substr(regexp_replace(trim(phone), '[[:space:]().-]', '', 'g'), 2)
      when regexp_replace(trim(phone), '[[:space:]().-]', '', 'g') ~ '^2613[0-9]{8}$'
        then '+' || regexp_replace(trim(phone), '[[:space:]().-]', '', 'g')
      else regexp_replace(trim(phone), '[[:space:]().-]', '', 'g')
    end
    having count(*) > 1
  ) then
    raise exception 'PHONE_NORMALIZATION_COLLISION: resolve duplicate phone numbers before migration';
  end if;
end;
$$;

update public.profiles
set phone = case
  when regexp_replace(trim(phone), '[[:space:]().-]', '', 'g') ~ '^03[0-9]{8}$'
    then '+261' || substr(regexp_replace(trim(phone), '[[:space:]().-]', '', 'g'), 2)
  when regexp_replace(trim(phone), '[[:space:]().-]', '', 'g') ~ '^2613[0-9]{8}$'
    then '+' || regexp_replace(trim(phone), '[[:space:]().-]', '', 'g')
  else regexp_replace(trim(phone), '[[:space:]().-]', '', 'g')
end
where phone <> regexp_replace(trim(phone), '[[:space:]().-]', '', 'g')
   or phone ~ '^03[0-9]{8}$'
   or phone ~ '^2613[0-9]{8}$';

alter table public.profiles alter column email drop not null;
alter table public.profiles
  add constraint profiles_malagasy_phone_format
  check (phone ~ '^\+2613[0-9]{8}$');

create or replace function public.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  metadata jsonb := new.raw_user_meta_data;
  selected_role public.account_role;
begin
  if metadata ->> 'terms_accepted' is distinct from 'true' then
    raise exception 'TERMS_NOT_ACCEPTED' using errcode = '22023';
  end if;
  if new.phone is null or nullif(trim(metadata ->> 'name'), '') is null then
    raise exception 'ACCOUNT_DETAILS_REQUIRED' using errcode = '22023';
  end if;
  if new.phone !~ '^\+2613[0-9]{8}$' then
    raise exception 'PHONE_INVALID' using errcode = '22023';
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
    nullif(lower(trim(new.email)), ''),
    new.phone,
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
