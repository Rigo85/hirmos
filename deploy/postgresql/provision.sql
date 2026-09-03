\set ON_ERROR_STOP on

-- Required psql variables:
--   hirmos_migrator_password
--   hirmos_app_password
-- This script creates or updates only resources whose names begin with hirmos.

SELECT 'CREATE ROLE hirmos_migrator LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hirmos_migrator')
\gexec

SELECT 'CREATE ROLE hirmos_app LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hirmos_app')
\gexec

SELECT format('ALTER ROLE hirmos_migrator PASSWORD %L', :'hirmos_migrator_password')
\gexec
SELECT format('ALTER ROLE hirmos_app PASSWORD %L', :'hirmos_app_password')
\gexec

SELECT 'CREATE DATABASE hirmos OWNER hirmos_migrator'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'hirmos')
\gexec

REVOKE ALL ON DATABASE hirmos FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE hirmos TO hirmos_migrator;
GRANT CONNECT ON DATABASE hirmos TO hirmos_app;

\connect hirmos
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO hirmos_migrator;
GRANT USAGE ON SCHEMA public TO hirmos_app;
