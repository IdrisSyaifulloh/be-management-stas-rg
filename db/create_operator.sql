BEGIN;

INSERT INTO users (id, name, initials, role, email, password_hash, prodi)
VALUES ('OP001', 'Admin Operator', 'AO', 'operator', 'operator@ac.id', md5('Operator#2026'), NULL)
ON CONFLICT (id)
DO UPDATE SET
  name = EXCLUDED.name,
  initials = EXCLUDED.initials,
  role = EXCLUDED.role,
  email = EXCLUDED.email,
  password_hash = EXCLUDED.password_hash,
  updated_at = NOW();

COMMIT;