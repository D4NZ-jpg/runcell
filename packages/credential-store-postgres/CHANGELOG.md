# Changelog

All notable changes to `@runcell/postgres-credentials` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0 - 2026-09-02

### Added

- Initial release. A Postgres-backed `CredentialStore` for runcell's
  `credentials: { type: 'shared' }`: each `withLock` call runs in a
  transaction that upserts the key's row and takes `SELECT ... FOR UPDATE`
  on it, so concurrent callers queue on the row lock and a rotated token is
  never clobbered.
- Options: `table` (optionally schema-qualified), `ensureTable` with a
  `postgresCredentialStoreSql()` migration helper, `lockTimeoutMs`, and
  `cacheFallback` to serve the last-known blob through a database outage.
- Optional encryption at rest with `encryptionKey`: AES-256-GCM with a
  scrypt-derived key, random salt and IV per write. Pre-encryption rows stay
  readable and are encrypted on their next write.
- The pool is typed structurally, so any pg-compatible pool works and the
  package has no runtime dependencies.
