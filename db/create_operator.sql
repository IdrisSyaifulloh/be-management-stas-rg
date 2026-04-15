BEGIN;

INSERT INTO users (id, name, initials, role, email, password_hash, prodi)
VALUES
  ('OP001', 'idrssyfllh', 'IDR', 'operator', 'idrssyfllh@ac.id', '$2b$10$vm8m2hd/mqJkdfJp8Al6V.XSv9iThHd1liCfiLq.IPJN2CDNpzYJW', NULL),
  ('OP002', 'irham', 'IRH', 'operator', 'irham@ac.id', '$2b$10$vm8m2hd/mqJkdfJp8Al6V.XSv9iThHd1liCfiLq.IPJN2CDNpzYJW', NULL),
  ('OP003', 'rey', 'REY', 'operator', 'rey@ac.id', '$2b$10$vm8m2hd/mqJkdfJp8Al6V.XSv9iThHd1liCfiLq.IPJN2CDNpzYJW', NULL)
ON CONFLICT (id)
DO UPDATE SET
  name = EXCLUDED.name,
  initials = EXCLUDED.initials,
  role = EXCLUDED.role,
  email = EXCLUDED.email,
  password_hash = EXCLUDED.password_hash,
  updated_at = NOW();

COMMIT;