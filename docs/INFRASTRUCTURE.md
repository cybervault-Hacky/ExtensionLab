# Intermediate Infrastructure Matrix (Phase 28)

Status: READY_FOR_INFRASTRUCTURE_E2E (external services unavailable; no fabrication).

| Component | Image / Source | Port | Health | Env Vars | Data | Dependencies | Security |
|---|---|---|---|---|---|---|---|
| App | extensionlab (Dockerfile) | 3000 | /health, /ready | DATABASE_URL, REDIS_URL, STORAGE_*, SESSION_SECRET, APP_ENV | None (DB external) |postgres, redis, storage | non-root, cap-drop, read-only root, tmpfs, bounded resources |
| PostgreSQL | postgres:16-alpine | 5432 | pg_isready | DATABASE_URL (host/user/pass/db) | postgres-data volume | none (first) | non-root, volume only |
| Redis | redis:7-alpine | 6379 | redis-cli ping | REDIS_URL | redis-data volume | none | bounded memory, allkeys-lru |
| Object Storage | minio/minio | 9000/9001 | /minio/health/live | STORAGE_*, STORAGE_BUCKET | s3-data volume | none (after DB/Redis for some flows) | private bucket, no public listing |
| Worker | extensionlab (same image) | none | heartbeat via Redis/DB | REDIS_URL, DATABASE_URL | none persistent (job state in DB/Redis) | postgres, redis | read-only root, no privileged, bounded |
| Browser Worker | extensionlab (same image) | control port (loopback) | control client | SANDBOX_*, REDIS_URL | tmpfs only (disposable) | redis, worker registry | cap-drop ALL + CHOWN/SETUID only; read-only root; no host network; no docker socket; tmpfs; bounded CPU/memory/PID |

Startup order (deterministic, bounded retries): Postgres → Redis → Storage → App/Worker/Browser Worker.
Migration gate: DB must pass migration check before E2E; second migration run must be idempotent.
Failure classification: CONFIGURATION / DATABASE / REDIS / STORAGE / WORKER / BROWSER_WORKER / PACKAGE / ANALYSIS / TEST / ARTIFACT / AUTHORIZATION / TIMEOUT / INFRASTRUCTURE / UNKNOWN.
Real E2E: SKIPPED (Docker/PG/Redis/S3 unavailable). Fixture and harness ready.
