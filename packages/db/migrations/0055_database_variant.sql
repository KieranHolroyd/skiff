-- Database image variants (D126). Additive only.
-- `postgis` and `pg_cron` are Yoal-built Postgres 18 images; every existing database is `standard`.

ALTER TABLE databases ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard';
