# Changelog

This file records all notable changes to `@runcell/postgres-concurrency`. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Initial release. `createPostgresConcurrencyLimiter` shares a runcell
  concurrency limit across workers through PostgreSQL. The limit includes
  maximum in-flight provider requests, workload ceilings, strict
  reservations, priorities, a bounded queue, and wait limits.
- Row-lock allocation, with slot expiry and wait deadlines in database
  time.
- Recovery of slots and queue entries from crashed workers.
- Detection of workers that use different limits for the same name.
- `postgresConcurrencySchemaSql()` for migrations.
