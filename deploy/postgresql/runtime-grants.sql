\set ON_ERROR_STOP on

-- Run as hirmos_migrator, connected only to the hirmos database, after migrations.
GRANT USAGE ON SCHEMA public TO hirmos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hirmos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hirmos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hirmos_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hirmos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hirmos_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO hirmos_app;
