-- Promotion du compte administrateur par défaut (+261340000099) en rôle admin.
update public.profiles
set role = 'admin'::public.account_role,
    updated_at = now()
where phone = '+261340000099';
