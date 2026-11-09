-- Schéma de données DriveNight pour Supabase.
create extension if not exists pgcrypto;

create type public.account_role as enum ('passenger', 'driver', 'admin');
create type public.ride_status as enum (
  'searching', 'negotiating', 'driver_en_route', 'driver_arrived',
  'in_progress', 'completed', 'cancelled'
);
create type public.offer_status as enum ('pending', 'accepted', 'rejected', 'withdrawn');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.account_role not null default 'passenger',
  name text not null check (length(trim(name)) between 1 and 80),
  email text not null unique,
  phone text not null unique check (length(trim(phone)) between 8 and 20),
  photo_path text,
  average_rating double precision not null default 0 check (average_rating between 0 and 5),
  rating_count integer not null default 0 check (rating_count >= 0),
  is_active boolean not null default true,
  terms_accepted_at timestamptz not null default now(),
  terms_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.driver_profiles (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  vehicle_category text not null check (vehicle_category in ('moto', 'taxi', 'voiture')),
  vehicle_make text,
  vehicle_model text,
  vehicle_color text,
  vehicle_registration text not null unique check (length(trim(vehicle_registration)) between 3 and 20),
  is_online boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.rides (
  id uuid primary key default gen_random_uuid(),
  passenger_id uuid not null references public.profiles(id),
  driver_id uuid references public.profiles(id),
  origin_label text not null check (length(trim(origin_label)) between 2 and 200),
  origin_latitude double precision not null check (origin_latitude between -90 and 90),
  origin_longitude double precision not null check (origin_longitude between -180 and 180),
  destination_label text not null check (length(trim(destination_label)) between 2 and 200),
  destination_latitude double precision not null check (destination_latitude between -90 and 90),
  destination_longitude double precision not null check (destination_longitude between -180 and 180),
  category text not null check (category in ('moto', 'taxi', 'voiture')),
  proposed_price_mga integer not null check (proposed_price_mga > 0),
  agreed_price_mga integer check (agreed_price_mga is null or agreed_price_mga > 0),
  status public.ride_status not null default 'searching',
  requested_at timestamptz not null default now(),
  accepted_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (passenger_id <> driver_id)
);

create table public.ride_offers (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides(id) on delete cascade,
  proposer_id uuid not null references public.profiles(id),
  amount_mga integer not null check (amount_mga > 0),
  responds_to_offer_id uuid references public.ride_offers(id),
  status public.offer_status not null default 'pending',
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  expires_at timestamptz not null default (now() + interval '15 minutes')
);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides(id) on delete cascade,
  sender_id uuid not null references public.profiles(id),
  body text not null check (length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);

create table public.ratings (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides(id) on delete cascade,
  rater_id uuid not null references public.profiles(id),
  ratee_id uuid not null references public.profiles(id),
  stars integer not null check (stars between 1 and 5),
  comment text check (comment is null or length(comment) <= 1000),
  created_at timestamptz not null default now(),
  unique (ride_id, rater_id),
  check (rater_id <> ratee_id)
);

create or replace function public.refresh_profile_rating()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles p
  set average_rating = (
        select avg(r.stars)::double precision
        from public.ratings r where r.ratee_id = new.ratee_id
      ),
      rating_count = (
        select count(*)::integer
        from public.ratings r where r.ratee_id = new.ratee_id
      ),
      updated_at = now()
  where p.id = new.ratee_id;
  return new;
end;
$$;

create trigger on_rating_created
after insert on public.ratings
for each row execute function public.refresh_profile_rating();

create table public.ride_locations (
  ride_id uuid primary key references public.rides(id) on delete cascade,
  driver_id uuid not null references public.profiles(id),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  updated_at timestamptz not null default now()
);

create index rides_by_passenger_created on public.rides (passenger_id, created_at desc);
create index rides_by_driver_created on public.rides (driver_id, created_at desc);
create index rides_searchable on public.rides (status, category, requested_at desc);
create unique index rides_one_active_per_driver
on public.rides (driver_id)
where driver_id is not null
  and status in ('driver_en_route', 'driver_arrived', 'in_progress');
create index offers_by_ride_created on public.ride_offers (ride_id, created_at);
create index messages_by_ride_created on public.chat_messages (ride_id, created_at);
create index ratings_by_ratee on public.ratings (ratee_id, created_at);

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
  if new.email is null or nullif(trim(metadata ->> 'phone'), '') is null then
    raise exception 'ACCOUNT_DETAILS_REQUIRED' using errcode = '22023';
  end if;
  selected_role := case
    when metadata ->> 'role' = 'driver' then 'driver'::public.account_role
    else 'passenger'::public.account_role
  end;
  insert into public.profiles (id, role, name, email, phone, terms_version)
  values (
    new.id,
    selected_role,
    coalesce(nullif(trim(metadata ->> 'name'), ''), 'Utilisateur'),
    lower(trim(new.email)),
    trim(metadata ->> 'phone'),
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

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.create_profile_for_auth_user();

alter table public.profiles enable row level security;
alter table public.driver_profiles enable row level security;
alter table public.rides enable row level security;
alter table public.ride_offers enable row level security;
alter table public.chat_messages enable row level security;
alter table public.ratings enable row level security;
alter table public.ride_locations enable row level security;

create policy "Chaque personne consulte son profil"
on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "Chaque personne modifie son nom et sa photo"
on public.profiles for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

create view public.public_profiles
with (security_invoker = false)
as
select id, role, name, photo_path, average_rating, rating_count
from public.profiles
where is_active;

create view public.public_driver_profiles
with (security_invoker = false)
as
select
  d.user_id, p.name, p.photo_path, p.average_rating, p.rating_count,
  d.vehicle_category, d.vehicle_make, d.vehicle_model, d.vehicle_color, d.is_online
from public.driver_profiles d
join public.profiles p on p.id = d.user_id
where p.is_active;

create policy "Chaque chauffeur consulte son véhicule"
on public.driver_profiles for select to authenticated using (user_id = (select auth.uid()));
create policy "Chaque chauffeur modifie son véhicule"
on public.driver_profiles for update to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "Participants consultent leurs courses"
on public.rides for select to authenticated
using (passenger_id = (select auth.uid()) or driver_id = (select auth.uid()));
create policy "Chauffeurs en ligne consultent les demandes compatibles"
on public.rides for select to authenticated
using (
  status in ('searching', 'negotiating')
  and exists (
    select 1 from public.driver_profiles d
    where d.user_id = (select auth.uid()) and d.is_online and d.vehicle_category = category
  )
);
create policy "Passagers créent leurs demandes"
on public.rides for insert to authenticated
with check (passenger_id = (select auth.uid()) and driver_id is null and status = 'searching');
create policy "Participants mettent à jour leurs courses"
on public.rides for update to authenticated
using (passenger_id = (select auth.uid()) or driver_id = (select auth.uid()))
with check (passenger_id = (select auth.uid()) or driver_id = (select auth.uid()));

create policy "Participants consultent les offres"
on public.ride_offers for select to authenticated
using (
  proposer_id = (select auth.uid())
  or exists (
    select 1 from public.rides r where r.id = ride_id
      and (r.passenger_id = (select auth.uid()) or r.driver_id = (select auth.uid()))
  )
  or exists (
    select 1 from public.rides r
    join public.driver_profiles d on d.user_id = (select auth.uid())
    where r.id = ride_id and r.status in ('searching', 'negotiating')
      and d.is_online and d.vehicle_category = r.category
  )
);
create policy "Chauffeurs proposent un prix sur une demande compatible"
on public.ride_offers for insert to authenticated
with check (
  proposer_id = (select auth.uid())
  and exists (
    select 1 from public.rides r
    join public.driver_profiles d on d.user_id = (select auth.uid())
    where r.id = ride_id and r.status in ('searching', 'negotiating')
      and d.is_online and d.vehicle_category = r.category
  )
);
create policy "Participants consultent le chat"
on public.chat_messages for select to authenticated
using (
  exists (
    select 1 from public.rides r where r.id = ride_id
      and (r.passenger_id = (select auth.uid()) or r.driver_id = (select auth.uid()))
  )
);
create policy "Participants actifs envoient des messages"
on public.chat_messages for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and exists (
    select 1 from public.rides r where r.id = ride_id
      and r.status in ('driver_en_route', 'driver_arrived', 'in_progress')
      and (r.passenger_id = (select auth.uid()) or r.driver_id = (select auth.uid()))
  )
);
create policy "Participants consultent les évaluations"
on public.ratings for select to authenticated
using (
  rater_id = (select auth.uid()) or ratee_id = (select auth.uid())
  or exists (
    select 1 from public.rides r where r.id = ride_id
      and (r.passenger_id = (select auth.uid()) or r.driver_id = (select auth.uid()))
  )
);
create policy "Participants évaluent une course terminée"
on public.ratings for insert to authenticated
with check (
  rater_id = (select auth.uid())
  and exists (
    select 1 from public.rides r where r.id = ride_id and r.status = 'completed'
      and (r.passenger_id = (select auth.uid()) or r.driver_id = (select auth.uid()))
      and ratee_id = case when r.passenger_id = (select auth.uid())
        then r.driver_id else r.passenger_id end
  )
);
create policy "Participants consultent les positions"
on public.ride_locations for select to authenticated
using (
  exists (
    select 1 from public.rides r where r.id = ride_id
      and (r.passenger_id = (select auth.uid()) or r.driver_id = (select auth.uid()))
  )
);
create policy "Chauffeurs partagent leur position"
on public.ride_locations for all to authenticated
using (driver_id = (select auth.uid()))
with check (
  driver_id = (select auth.uid())
  and exists (
    select 1 from public.rides r where r.id = ride_id and r.driver_id = (select auth.uid())
      and r.status in ('driver_en_route', 'driver_arrived', 'in_progress')
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-photos', 'profile-photos', true, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
create policy "Photos de profil publiques"
on storage.objects for select to public using (bucket_id = 'profile-photos');
create policy "Chaque personne gère sa photo de profil"
on storage.objects for all to authenticated
using (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = (select auth.uid())::text)
with check (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

alter publication supabase_realtime add table public.rides;
alter publication supabase_realtime add table public.ride_offers;
alter publication supabase_realtime add table public.chat_messages;
alter publication supabase_realtime add table public.ride_locations;

create or replace function public.set_driver_availability(p_online boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.driver_profiles d
    join public.profiles p on p.id = d.user_id
    where d.user_id = (select auth.uid()) and p.role = 'driver' and p.is_active
  ) then
    raise exception 'DRIVER_NOT_AVAILABLE' using errcode = '42501';
  end if;
  update public.driver_profiles
  set is_online = p_online, updated_at = now()
  where user_id = (select auth.uid());
  return p_online;
end;
$$;

create or replace function public.create_ride(
  p_origin_label text,
  p_origin_latitude double precision,
  p_origin_longitude double precision,
  p_destination_label text,
  p_destination_latitude double precision,
  p_destination_longitude double precision,
  p_category text,
  p_proposed_price_mga integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare created_ride_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'passenger' and is_active
  ) then
    raise exception 'PASSENGER_REQUIRED' using errcode = '42501';
  end if;
  if p_origin_latitude = p_destination_latitude
    and p_origin_longitude = p_destination_longitude then
    raise exception 'ROUTE_POINTS_MUST_DIFFER' using errcode = '22023';
  end if;
  insert into public.rides (
    passenger_id, origin_label, origin_latitude, origin_longitude,
    destination_label, destination_latitude, destination_longitude,
    category, proposed_price_mga, status
  ) values (
    (select auth.uid()), trim(p_origin_label), p_origin_latitude, p_origin_longitude,
    trim(p_destination_label), p_destination_latitude, p_destination_longitude,
    p_category, p_proposed_price_mga, 'searching'
  ) returning id into created_ride_id;
  insert into public.ride_offers (ride_id, proposer_id, amount_mga)
  values (created_ride_id, (select auth.uid()), p_proposed_price_mga);
  return created_ride_id;
end;
$$;

create or replace function public.create_ride_offer(
  p_ride_id uuid,
  p_amount_mga integer,
  p_responds_to_offer_id uuid
)
returns public.ride_offers
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_ride public.rides;
  parent_offer public.ride_offers;
  created_offer public.ride_offers;
  actor_role public.account_role;
begin
  select role into actor_role from public.profiles
  where id = current_user_id and is_active;
  if actor_role is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select * into target_ride from public.rides where id = p_ride_id for update;
  if not found or target_ride.status not in ('searching', 'negotiating') then
    raise exception 'RIDE_NOT_OPEN' using errcode = 'P0002';
  end if;
  select * into parent_offer from public.ride_offers
  where id = p_responds_to_offer_id and ride_id = p_ride_id
    and status = 'pending' and expires_at > now() for update;
  if not found or parent_offer.proposer_id = current_user_id then
    raise exception 'OFFER_NOT_RESPONDABLE' using errcode = 'P0002';
  end if;

  if actor_role = 'driver' then
    if not exists (
      select 1 from public.driver_profiles
      where user_id = current_user_id and is_online
        and vehicle_category = target_ride.category
    ) then
      raise exception 'DRIVER_NOT_AVAILABLE' using errcode = '42501';
    end if;
    if exists (
      select 1 from public.rides
      where driver_id = current_user_id
        and status in ('driver_en_route', 'driver_arrived', 'in_progress')
    ) then
      raise exception 'DRIVER_HAS_ACTIVE_RIDE' using errcode = '23505';
    end if;
  elsif actor_role <> 'passenger' or target_ride.passenger_id <> current_user_id then
    raise exception 'RIDE_PARTICIPANT_REQUIRED' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.ride_offers
    where ride_id = p_ride_id and proposer_id = current_user_id
      and responds_to_offer_id = parent_offer.id and status = 'pending'
  ) then
    raise exception 'OFFER_ALREADY_SUBMITTED' using errcode = '23505';
  end if;
  insert into public.ride_offers (
    ride_id, proposer_id, amount_mga, responds_to_offer_id, expires_at
  ) values (
    p_ride_id, current_user_id, p_amount_mga, parent_offer.id,
    case when actor_role = 'driver' then now() + interval '15 seconds'
      else now() + interval '15 minutes' end
  ) returning * into created_offer;
  update public.rides set status = 'negotiating', updated_at = now()
  where id = p_ride_id;
  return created_offer;
end;
$$;

create or replace function public.accept_ride_at_proposed_price(p_ride_id uuid)
returns public.ride_offers
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_ride public.rides;
  initial_offer public.ride_offers;
  created_offer public.ride_offers;
begin
  select * into target_ride from public.rides where id = p_ride_id for update;
  if not found or target_ride.status not in ('searching', 'negotiating') then
    raise exception 'RIDE_NOT_OPEN' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.profiles p
    join public.driver_profiles d on d.user_id = p.id
    where p.id = (select auth.uid()) and p.role = 'driver' and p.is_active
      and d.is_online and d.vehicle_category = target_ride.category
  ) then
    raise exception 'DRIVER_NOT_AVAILABLE' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.rides
    where driver_id = (select auth.uid())
      and status in ('driver_en_route', 'driver_arrived', 'in_progress')
  ) then
    raise exception 'DRIVER_HAS_ACTIVE_RIDE' using errcode = '23505';
  end if;
  select * into initial_offer from public.ride_offers
  where ride_id = p_ride_id and proposer_id = target_ride.passenger_id
    and responds_to_offer_id is null and status = 'pending'
  order by created_at limit 1 for update;
  if not found then
    raise exception 'RIDE_PRICE_UNAVAILABLE' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.ride_offers
    where ride_id = p_ride_id and proposer_id = (select auth.uid())
      and responds_to_offer_id = initial_offer.id and status = 'pending'
      and expires_at > now()
  ) then
    raise exception 'OFFER_ALREADY_SUBMITTED' using errcode = '23505';
  end if;
  insert into public.ride_offers (
    ride_id, proposer_id, amount_mga, responds_to_offer_id, expires_at
  ) values (
    p_ride_id, (select auth.uid()), initial_offer.amount_mga,
    initial_offer.id, now() + interval '15 seconds'
  ) returning * into created_offer;
  return created_offer;
end;
$$;

create or replace function public.accept_ride_offer(p_ride_id uuid, p_offer_id uuid)
returns public.rides
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_ride public.rides;
  target_offer public.ride_offers;
begin
  select * into target_ride from public.rides where id = p_ride_id for update;
  if not found or target_ride.passenger_id <> current_user_id
    or target_ride.status not in ('searching', 'negotiating') then
    raise exception 'RIDE_NOT_OPEN' using errcode = '42501';
  end if;
  select * into target_offer from public.ride_offers
  where id = p_offer_id and ride_id = p_ride_id and proposer_id <> current_user_id
    and status = 'pending' and expires_at > now() for update;
  if not found then
    raise exception 'OFFER_NOT_ACCEPTABLE' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.profiles p
    join public.driver_profiles d on d.user_id = p.id
    where p.id = target_offer.proposer_id and p.is_active
      and d.is_online and d.vehicle_category = target_ride.category
  ) then
    raise exception 'DRIVER_NOT_AVAILABLE' using errcode = '42501';
  end if;
  update public.ride_offers
  set status = case when id = p_offer_id then 'accepted'::public.offer_status
    else 'rejected'::public.offer_status end,
    responded_at = now()
  where ride_id = p_ride_id and status = 'pending';
  update public.rides
  set driver_id = target_offer.proposer_id,
      agreed_price_mga = target_offer.amount_mga,
      status = 'driver_en_route',
      accepted_at = now(),
      updated_at = now()
  where id = p_ride_id returning * into target_ride;
  return target_ride;
end;
$$;

create or replace function public.reject_ride_offer(p_ride_id uuid, p_offer_id uuid)
returns public.ride_offers
language plpgsql
security definer
set search_path = ''
as $$
declare target_offer public.ride_offers;
begin
  update public.ride_offers o
  set status = 'rejected', responded_at = now()
  from public.rides r
  where o.id = p_offer_id and o.ride_id = p_ride_id and o.status = 'pending'
    and o.expires_at > now() and r.id = o.ride_id
    and r.passenger_id = (select auth.uid())
    and r.status in ('searching', 'negotiating')
  returning o.* into target_offer;
  if not found then
    raise exception 'OFFER_NOT_REJECTABLE' using errcode = 'P0002';
  end if;
  return target_offer;
end;
$$;

create or replace function public.update_ride_status(p_ride_id uuid, p_status text)
returns public.rides
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_ride public.rides;
  next_status public.ride_status;
begin
  begin
    next_status := p_status::public.ride_status;
  exception when invalid_text_representation then
    raise exception 'RIDE_STATUS_INVALID' using errcode = '22023';
  end;
  select * into target_ride from public.rides
  where id = p_ride_id and driver_id = (select auth.uid()) for update;
  if not found then
    raise exception 'RIDE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not (
    (target_ride.status = 'driver_en_route' and next_status = 'driver_arrived')
    or (target_ride.status = 'driver_arrived' and next_status = 'in_progress')
    or (target_ride.status = 'in_progress' and next_status = 'completed')
  ) then
    raise exception 'RIDE_STATUS_TRANSITION_INVALID' using errcode = '22023';
  end if;
  update public.rides
  set status = next_status,
      started_at = case when next_status = 'in_progress' then now() else started_at end,
      completed_at = case when next_status = 'completed' then now() else completed_at end,
      updated_at = now()
  where id = p_ride_id returning * into target_ride;
  if next_status = 'completed' then
    delete from public.ride_locations where ride_id = p_ride_id;
  end if;
  return target_ride;
end;
$$;

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
    and target_ride.driver_id <> (select auth.uid())
  ) then
    raise exception 'RIDE_NOT_FOUND' using errcode = '42501';
  end if;
  if target_ride.status not in ('searching', 'negotiating', 'driver_en_route', 'driver_arrived') then
    raise exception 'RIDE_CANNOT_BE_CANCELLED' using errcode = '22023';
  end if;
  update public.rides set status = 'cancelled', cancelled_at = now(), updated_at = now()
  where id = p_ride_id returning * into target_ride;
  update public.ride_offers set status = 'withdrawn', responded_at = now()
  where ride_id = p_ride_id and status = 'pending';
  delete from public.ride_locations where ride_id = p_ride_id;
  return target_ride;
end;
$$;

create or replace function public.share_ride_location(
  p_ride_id uuid, p_latitude double precision, p_longitude double precision
)
returns public.ride_locations
language plpgsql
security definer
set search_path = ''
as $$
declare saved_location public.ride_locations;
begin
  if not exists (
    select 1 from public.rides r where r.id = p_ride_id
      and r.driver_id = (select auth.uid())
      and r.status in ('driver_en_route', 'driver_arrived', 'in_progress')
  ) then
    raise exception 'RIDE_NOT_FOUND' using errcode = '42501';
  end if;
  insert into public.ride_locations (ride_id, driver_id, latitude, longitude, updated_at)
  values (p_ride_id, (select auth.uid()), p_latitude, p_longitude, now())
  on conflict (ride_id) do update
  set latitude = excluded.latitude, longitude = excluded.longitude, updated_at = now()
  returning * into saved_location;
  return saved_location;
end;
$$;

revoke all on public.profiles, public.driver_profiles, public.rides, public.ride_offers,
  public.chat_messages, public.ratings, public.ride_locations from anon, authenticated;
grant select on public.profiles to authenticated;
grant select on public.public_profiles, public.public_driver_profiles to authenticated;
grant update (name, photo_path, updated_at) on public.profiles to authenticated;
grant select on public.driver_profiles, public.rides, public.ride_offers,
  public.chat_messages, public.ratings, public.ride_locations to authenticated;
grant update (vehicle_category, vehicle_make, vehicle_model, vehicle_color,
  vehicle_registration, updated_at) on public.driver_profiles to authenticated;
grant insert on public.chat_messages, public.ratings to authenticated;

revoke all on function public.set_driver_availability(boolean) from public, anon;
revoke all on function public.create_ride(text, double precision, double precision, text, double precision, double precision, text, integer) from public, anon;
revoke all on function public.create_ride_offer(uuid, integer, uuid) from public, anon;
revoke all on function public.accept_ride_at_proposed_price(uuid) from public, anon;
revoke all on function public.accept_ride_offer(uuid, uuid) from public, anon;
revoke all on function public.reject_ride_offer(uuid, uuid) from public, anon;
revoke all on function public.update_ride_status(uuid, text) from public, anon;
revoke all on function public.cancel_ride(uuid) from public, anon;
revoke all on function public.share_ride_location(uuid, double precision, double precision) from public, anon;
grant execute on function public.set_driver_availability(boolean) to authenticated;
grant execute on function public.create_ride(text, double precision, double precision, text, double precision, double precision, text, integer) to authenticated;
grant execute on function public.create_ride_offer(uuid, integer, uuid) to authenticated;
grant execute on function public.accept_ride_at_proposed_price(uuid) to authenticated;
grant execute on function public.accept_ride_offer(uuid, uuid) to authenticated;
grant execute on function public.reject_ride_offer(uuid, uuid) to authenticated;
grant execute on function public.update_ride_status(uuid, text) to authenticated;
grant execute on function public.cancel_ride(uuid) to authenticated;
grant execute on function public.share_ride_location(uuid, double precision, double precision) to authenticated;
revoke all on function public.refresh_profile_rating() from public, anon, authenticated;
revoke all on function public.create_profile_for_auth_user() from public, anon, authenticated;
