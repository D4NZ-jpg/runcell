# Changelog

All notable changes to `@runcell/postgres-admission` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Initial release. `createPostgresScheduler` enforces RunCell admission
  policies (pool and workload limits, strict reservations, priorities,
  bounded queues, wait limits) across workers sharing a database, with
  row-lock allocation, database-time expiry and deadlines, crash recovery,
  policy-conflict detection, and `postgresAdmissionSchemaSql()` migrations.
