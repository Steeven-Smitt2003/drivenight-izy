ALTER TABLE users ADD COLUMN password_hash TEXT;

UPDATE users
SET password_hash = 'scrypt$32768$8$1$64726976656e696768742d64656d6f2d32303236$0c1ffbaf8e41318e00af8c77c50df57db154b70298a5999e12ba01758a27bc75b69b8fe38e2137bc70744c882347fdffad25d72140aad181192d152452f72c10'
WHERE id IN (
  'demo-passenger-01',
  'demo-passenger-02',
  'demo-driver-01',
  'demo-driver-02',
  'demo-driver-03',
  'demo-admin-01'
);
