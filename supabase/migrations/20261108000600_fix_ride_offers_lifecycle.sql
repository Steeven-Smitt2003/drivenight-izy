-- Alignement du cycle de vie des offres Supabase sur le backend DriveNight :
-- 1. Les offres initiales passager et les contre-offres chauffeur n'ont pas d'expiration à 15s (expires_at = NULL).
-- 2. Seul l'accord direct du chauffeur au prix proposé par le passager (accept_ride_at_proposed_price) expire au bout de 15s.
-- 3. Les accords directs expirés sont automatiquement retirés (status = 'withdrawn') via expire_timed_ride_offers, qui renvoie l'horloge serveur exacte.

alter table public.ride_offers alter column expires_at drop not null;
alter table public.ride_offers alter column expires_at drop default;

update public.ride_offers
set expires_at = null
where responds_to_offer_id is null;

update public.ride_offers o
set expires_at = null
from public.rides r
where o.ride_id = r.id
  and o.responds_to_offer_id is not null
  and o.amount_mga <> r.proposed_price_mga
  and o.status = 'pending';

update public.ride_offers
set status = 'withdrawn',
    responded_at = now()
where status = 'pending'
  and expires_at is not null
  and expires_at <= now();

create or replace function public.expire_timed_ride_offers(p_ride_id uuid default null)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  server_now timestamptz := now();
begin
  if (select auth.uid()) is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  update public.ride_offers
  set status = 'withdrawn',
      responded_at = server_now
  where status = 'pending'
    and expires_at is not null
    and expires_at <= server_now
    and (p_ride_id is null or ride_id = p_ride_id);
  return server_now;
end;
$$;

revoke all on function public.expire_timed_ride_offers(uuid) from public, anon;
grant execute on function public.expire_timed_ride_offers(uuid) to authenticated;

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
  insert into public.ride_offers (ride_id, proposer_id, amount_mga, expires_at)
  values (created_ride_id, (select auth.uid()), p_proposed_price_mga, null);
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
  perform public.expire_timed_ride_offers(p_ride_id);

  select role into actor_role from public.profiles
  where id = current_user_id and is_active;
  if actor_role is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select * into target_ride from public.rides where id = p_ride_id for update;
  if not found or target_ride.status not in ('searching', 'negotiating') then
    raise exception 'RIDE_NOT_OPEN' using errcode = 'P0002';
  end if;
  if p_responds_to_offer_id is not null then
    select * into parent_offer from public.ride_offers
    where id = p_responds_to_offer_id and ride_id = p_ride_id
      and status = 'pending' and (expires_at is null or expires_at > now()) for update;
  else
    select * into parent_offer from public.ride_offers
    where ride_id = p_ride_id and proposer_id = target_ride.passenger_id
      and responds_to_offer_id is null and status = 'pending'
    order by created_at limit 1 for update;
  end if;
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
      and (expires_at is null or expires_at > now())
  ) then
    raise exception 'OFFER_ALREADY_SUBMITTED' using errcode = '23505';
  end if;
  insert into public.ride_offers (
    ride_id, proposer_id, amount_mga, responds_to_offer_id, expires_at
  ) values (
    p_ride_id, current_user_id, p_amount_mga, parent_offer.id, null
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
  perform public.expire_timed_ride_offers(p_ride_id);

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
      and expires_at is not null and expires_at > now()
  ) then
    raise exception 'OFFER_ALREADY_SUBMITTED' using errcode = '23505';
  end if;

  update public.ride_offers
  set status = 'withdrawn',
      responded_at = now()
  where ride_id = p_ride_id
    and proposer_id = (select auth.uid())
    and status = 'pending'
    and expires_at is null;

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
  perform public.expire_timed_ride_offers(p_ride_id);

  select * into target_ride from public.rides where id = p_ride_id for update;
  if not found or target_ride.passenger_id <> current_user_id
    or target_ride.status not in ('searching', 'negotiating') then
    raise exception 'RIDE_NOT_OPEN' using errcode = '42501';
  end if;
  select * into target_offer from public.ride_offers
  where id = p_offer_id and ride_id = p_ride_id and proposer_id <> current_user_id
    and status = 'pending' and (expires_at is null or expires_at > now()) for update;
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
  perform public.expire_timed_ride_offers(p_ride_id);

  update public.ride_offers o
  set status = 'rejected', responded_at = now()
  from public.rides r
  where o.id = p_offer_id and o.ride_id = p_ride_id and o.status = 'pending'
    and (o.expires_at is null or o.expires_at > now()) and r.id = o.ride_id
    and r.passenger_id = (select auth.uid())
    and r.status in ('searching', 'negotiating')
  returning o.* into target_offer;
  if not found then
    raise exception 'OFFER_NOT_REJECTABLE' using errcode = 'P0002';
  end if;
  return target_offer;
end;
$$;

create or replace function public.admin_operations()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_admin();
  perform public.expire_timed_ride_offers();
  return jsonb_build_object(
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'origin', r.origin_label,
        'destination', r.destination_label,
        'category', r.category,
        'proposedPriceMGA', r.proposed_price_mga,
        'status', r.status,
        'requestedAt', r.requested_at,
        'passenger', jsonb_build_object(
          'id', p.id, 'name', p.name, 'phone', p.phone
        ),
        'pendingOfferCount', (
          select count(*) from public.ride_offers o
          where o.ride_id = r.id and o.status = 'pending'
            and (o.expires_at is null or o.expires_at > now())
        )
      ) order by r.requested_at desc)
      from public.rides r
      join public.profiles p on p.id = r.passenger_id
      where r.status in ('searching', 'negotiating')
    ), '[]'::jsonb),
    'onlineDrivers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'photoPath', p.photo_path,
        'phone', p.phone,
        'averageRating', p.average_rating,
        'ratingCount', p.rating_count,
        'vehicleCategory', d.vehicle_category,
        'vehicleRegistration', d.vehicle_registration,
        'available', not exists (
          select 1 from public.rides r
          where r.driver_id = p.id
            and r.status in ('driver_en_route', 'driver_arrived', 'in_progress')
        )
      ) order by p.name)
      from public.profiles p
      join public.driver_profiles d on d.user_id = p.id
      where p.role = 'driver' and p.is_active and d.is_online
    ), '[]'::jsonb),
    'onlinePassengers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'photoPath', p.photo_path,
        'phone', p.phone
      ) order by p.name)
      from public.account_presence presence
      join public.profiles p on p.id = presence.user_id
      where p.role = 'passenger' and p.is_active
        and presence.last_seen_at > now() - interval '90 seconds'
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'origin', r.origin_label,
        'destination', r.destination_label,
        'category', r.category,
        'proposedPriceMGA', r.proposed_price_mga,
        'agreedPriceMGA', r.agreed_price_mga,
        'status', r.status,
        'requestedAt', r.requested_at,
        'acceptedAt', r.accepted_at,
        'completedAt', r.completed_at,
        'cancelledAt', r.cancelled_at,
        'passengerName', passenger.name,
        'driverName', driver.name
      ) order by coalesce(r.completed_at, r.cancelled_at, r.accepted_at, r.requested_at) desc, r.id desc)
      from public.rides r
      join public.profiles passenger on passenger.id = r.passenger_id
      left join public.profiles driver on driver.id = r.driver_id
    ), '[]'::jsonb),
    'ratings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', rating.id,
        'rideId', rating.ride_id,
        'stars', rating.stars,
        'comment', rating.comment,
        'createdAt', rating.created_at,
        'raterName', rater.name,
        'rateeName', ratee.name,
        'origin', ride.origin_label,
        'destination', ride.destination_label
      ) order by rating.created_at desc, rating.id desc)
      from public.ratings rating
      join public.profiles rater on rater.id = rating.rater_id
      join public.profiles ratee on ratee.id = rating.ratee_id
      join public.rides ride on ride.id = rating.ride_id
    ), '[]'::jsonb),
    'presenceExpiresInSeconds', 90
  );
end;
$$;
