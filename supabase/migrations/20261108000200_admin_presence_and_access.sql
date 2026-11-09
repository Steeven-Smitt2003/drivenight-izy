create table public.account_presence (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  last_seen_at timestamptz not null default now()
);

alter table public.account_presence enable row level security;
revoke all on public.account_presence from anon, authenticated;

create or replace function public.require_active_account()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = current_user_id and is_active
  ) then
    raise exception 'ACCOUNT_DISABLED' using errcode = '42501';
  end if;
  return current_user_id;
end;
$$;

create or replace function public.require_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = current_user_id and role = 'admin' and is_active
  ) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  return current_user_id;
end;
$$;

create or replace function public.set_account_presence()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare current_user_id uuid := public.require_active_account();
declare seen_at timestamptz := now();
begin
  insert into public.account_presence (user_id, last_seen_at)
  values (current_user_id, seen_at)
  on conflict (user_id) do update set last_seen_at = excluded.last_seen_at;
  return seen_at;
end;
$$;

create or replace function public.admin_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_admin();
  return (
    select jsonb_build_object(
      'users', jsonb_build_object(
        'total', count(*),
        'active', count(*) filter (where p.is_active),
        'inactive', count(*) filter (where not p.is_active),
        'passengers', count(*) filter (where p.role = 'passenger'),
        'drivers', count(*) filter (where p.role = 'driver'),
        'admins', count(*) filter (where p.role = 'admin')
      ),
      'rides', (
        select jsonb_build_object(
          'searching', count(*) filter (where r.status = 'searching'),
          'negotiating', count(*) filter (where r.status = 'negotiating'),
          'driver_en_route', count(*) filter (where r.status = 'driver_en_route'),
          'driver_arrived', count(*) filter (where r.status = 'driver_arrived'),
          'in_progress', count(*) filter (where r.status = 'in_progress'),
          'completed', count(*) filter (where r.status = 'completed'),
          'cancelled', count(*) filter (where r.status = 'cancelled'),
          'total', count(*)
        )
        from public.rides r
      )
    )
    from public.profiles p
  );
end;
$$;

create or replace function public.admin_accounts(
  p_query text default '',
  p_role text default 'all',
  p_status text default 'all'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_admin();
  if p_role not in ('all', 'passenger', 'driver', 'admin')
    or p_status not in ('all', 'active', 'inactive') then
    raise exception 'ADMIN_FILTER_INVALID' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'accounts',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'phone', p.phone,
        'email', p.email,
        'photoPath', p.photo_path,
        'role', p.role,
        'averageRating', p.average_rating,
        'ratingCount', p.rating_count,
        'isActive', p.is_active,
        'createdAt', p.created_at,
        'vehicleCategory', d.vehicle_category,
        'vehicleMake', d.vehicle_make,
        'vehicleModel', d.vehicle_model,
        'vehicleColor', d.vehicle_color,
        'vehicleRegistration', d.vehicle_registration,
        'isOnline', d.is_online
      ) order by case p.role when 'driver' then 0 else 1 end, p.created_at desc, p.id)
      from public.profiles p
      left join public.driver_profiles d on d.user_id = p.id
      where (p_role = 'all' or p.role::text = p_role)
        and (p_status = 'all' or p.is_active = (p_status = 'active'))
        and (
          nullif(trim(p_query), '') is null
          or concat_ws(' ', p.name, p.phone, p.email, d.vehicle_registration)
            ilike '%' || trim(p_query) || '%'
        )
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.admin_operations()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_admin();
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
            and o.expires_at > now()
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

create or replace function public.admin_set_account_status(
  p_account_id uuid,
  p_is_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.profiles;
  disabled_at timestamptz := now();
begin
  perform public.require_admin();
  select * into target from public.profiles
  where id = p_account_id and role in ('passenger', 'driver')
  for update;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not p_is_active then
    if exists (
      select 1 from public.rides r
      where (r.passenger_id = target.id or r.driver_id = target.id)
        and r.status in ('driver_en_route', 'driver_arrived', 'in_progress')
    ) then
      raise exception 'ACCOUNT_HAS_ACTIVE_RIDE' using errcode = '23505';
    end if;

    if target.is_active then
      update public.rides
      set status = 'cancelled', cancelled_at = disabled_at, updated_at = disabled_at
      where passenger_id = target.id and status in ('searching', 'negotiating');

      update public.ride_offers
      set status = 'withdrawn', responded_at = disabled_at
      where status = 'pending' and (
        proposer_id = target.id
        or ride_id in (
          select id from public.rides
          where passenger_id = target.id and status = 'cancelled'
            and cancelled_at = disabled_at
        )
      );

      delete from public.ride_locations
      where ride_id in (
        select id from public.rides
        where passenger_id = target.id and status = 'cancelled'
          and cancelled_at = disabled_at
      );
    end if;
  end if;

  update public.profiles
  set is_active = p_is_active, updated_at = now()
  where id = target.id;
  if target.role = 'driver' and not p_is_active then
    update public.driver_profiles
    set is_online = false, updated_at = now()
    where user_id = target.id;
  end if;
  if not p_is_active then
    delete from public.account_presence where user_id = target.id;
  end if;

  return jsonb_build_object(
    'account', jsonb_build_object('id', target.id, 'isActive', p_is_active)
  );
end;
$$;

drop policy if exists "Chaque personne consulte son profil" on public.profiles;
create policy "Chaque personne consulte son profil"
on public.profiles for select to authenticated
using (id = (select auth.uid()) and is_active);

drop policy if exists "Chaque personne modifie son nom et sa photo" on public.profiles;
create policy "Chaque personne modifie son nom et sa photo"
on public.profiles for update to authenticated
using (id = (select auth.uid()) and is_active)
with check (id = (select auth.uid()) and is_active);

drop policy if exists "Chaque chauffeur consulte son véhicule" on public.driver_profiles;
create policy "Chaque chauffeur consulte son véhicule"
on public.driver_profiles for select to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.profiles p where p.id = user_id and p.is_active
  )
);

drop policy if exists "Chaque chauffeur modifie son véhicule" on public.driver_profiles;
create policy "Chaque chauffeur modifie son véhicule"
on public.driver_profiles for update to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.profiles p where p.id = user_id and p.is_active
  )
)
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.profiles p where p.id = user_id and p.is_active
  )
);

drop policy if exists "Participants consultent leurs courses" on public.rides;
create policy "Participants consultent leurs courses"
on public.rides for select to authenticated
using (
  (
    passenger_id = (select auth.uid()) or driver_id = (select auth.uid())
  ) and exists (
    select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_active
  )
);

drop policy if exists "Chauffeurs en ligne consultent les demandes compatibles" on public.rides;
create policy "Chauffeurs en ligne consultent les demandes compatibles"
on public.rides for select to authenticated
using (
  status in ('searching', 'negotiating')
  and exists (
    select 1 from public.driver_profiles d
    join public.profiles p on p.id = d.user_id
    where d.user_id = (select auth.uid()) and d.is_online and p.is_active
      and d.vehicle_category = category
  )
);

drop policy if exists "Passagers créent leurs demandes" on public.rides;
create policy "Passagers créent leurs demandes"
on public.rides for insert to authenticated
with check (
  passenger_id = (select auth.uid()) and driver_id is null and status = 'searching'
  and exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'passenger' and p.is_active
  )
);

drop policy if exists "Participants consultent les offres" on public.ride_offers;
create policy "Participants consultent les offres"
on public.ride_offers for select to authenticated
using (
  exists (
    select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_active
  )
  and (
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
  )
);

drop policy if exists "Chauffeurs proposent un prix sur une demande compatible" on public.ride_offers;
create policy "Chauffeurs proposent un prix sur une demande compatible"
on public.ride_offers for insert to authenticated
with check (
  proposer_id = (select auth.uid())
  and exists (
    select 1 from public.profiles p
    join public.driver_profiles d on d.user_id = p.id
    join public.rides r on r.id = ride_id
    where p.id = (select auth.uid()) and p.is_active
      and r.status in ('searching', 'negotiating')
      and d.is_online and d.vehicle_category = r.category
  )
);

drop policy if exists "Participants consultent le chat" on public.chat_messages;
create policy "Participants consultent le chat"
on public.chat_messages for select to authenticated
using (
  exists (
    select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_active
  )
  and exists (
    select 1 from public.rides r where r.id = ride_id
      and (r.passenger_id = (select auth.uid()) or r.driver_id = (select auth.uid()))
  )
);

drop policy if exists "Participants actifs envoient des messages" on public.chat_messages;
create policy "Participants actifs envoient des messages"
on public.chat_messages for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and exists (
    select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_active
  )
  and exists (
    select 1 from public.rides r where r.id = ride_id
      and r.status in ('driver_en_route', 'driver_arrived', 'in_progress')
      and (r.passenger_id = (select auth.uid()) or r.driver_id = (select auth.uid()))
  )
);

drop policy if exists "Participants consultent les évaluations" on public.ratings;
create policy "Participants consultent les évaluations"
on public.ratings for select to authenticated
using (
  exists (
    select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_active
  )
  and (
    rater_id = (select auth.uid()) or ratee_id = (select auth.uid())
    or exists (
      select 1 from public.rides r where r.id = ride_id
        and (r.passenger_id = (select auth.uid()) or r.driver_id = (select auth.uid()))
    )
  )
);

drop policy if exists "Participants évaluent une course terminée" on public.ratings;
create policy "Participants évaluent une course terminée"
on public.ratings for insert to authenticated
with check (
  rater_id = (select auth.uid())
  and exists (
    select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_active
  )
  and exists (
    select 1 from public.rides r where r.id = ride_id and r.status = 'completed'
      and (r.passenger_id = (select auth.uid()) or r.driver_id = (select auth.uid()))
      and ratee_id = case when r.passenger_id = (select auth.uid())
        then r.driver_id else r.passenger_id end
  )
);

drop policy if exists "Participants consultent les positions" on public.ride_locations;
create policy "Participants consultent les positions"
on public.ride_locations for select to authenticated
using (
  exists (
    select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_active
  )
  and exists (
    select 1 from public.rides r where r.id = ride_id
      and (r.passenger_id = (select auth.uid()) or r.driver_id = (select auth.uid()))
  )
);

drop policy if exists "Chauffeurs partagent leur position" on public.ride_locations;
create policy "Chauffeurs partagent leur position"
on public.ride_locations for all to authenticated
using (
  driver_id = (select auth.uid())
  and exists (
    select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_active
  )
)
with check (
  driver_id = (select auth.uid())
  and exists (
    select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_active
  )
  and exists (
    select 1 from public.rides r where r.id = ride_id and r.driver_id = (select auth.uid())
      and r.status in ('driver_en_route', 'driver_arrived', 'in_progress')
  )
);

drop policy if exists "Chaque personne gère sa photo de profil" on storage.objects;
create policy "Chaque personne gère sa photo de profil"
on storage.objects for all to authenticated
using (
  bucket_id = 'profile-photos'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_active
  )
)
with check (
  bucket_id = 'profile-photos'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_active
  )
);

revoke all on function public.require_active_account() from public, anon;
revoke all on function public.require_admin() from public, anon;
revoke all on function public.set_account_presence() from public, anon;
revoke all on function public.admin_summary() from public, anon;
revoke all on function public.admin_accounts(text, text, text) from public, anon;
revoke all on function public.admin_operations() from public, anon;
revoke all on function public.admin_set_account_status(uuid, boolean) from public, anon;
grant execute on function public.require_active_account() to authenticated;
grant execute on function public.require_admin() to authenticated;
grant execute on function public.set_account_presence() to authenticated;
grant execute on function public.admin_summary() to authenticated;
grant execute on function public.admin_accounts(text, text, text) to authenticated;
grant execute on function public.admin_operations() to authenticated;
grant execute on function public.admin_set_account_status(uuid, boolean) to authenticated;
