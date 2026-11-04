# Changelog

All notable changes to `@runcell/postgres-concurrency` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Initial release. `createPostgresConcurrencyLimiter` shares a runcell
  concurrency limit (maximum in-flight provider requests, workload ceilings,
  strict reservations, priorities, bounded queue, wait limits) across
  workers through PostgreSQL, with row-lock allocation, database-time
  expiry and deadlines, crash recovery, conflict detection for differing
  limits, and `postgresConcurrencySchemaSql()` migrations.
