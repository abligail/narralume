[中文](docker.md)

# Self-hosting with Docker Compose

Docker is the advanced self-hosting entry point in the source workspace; Docker Desktop or Docker Engine must be installed and running beforehand. The desktop release packages do not include the Docker build context.

Before starting, confirm:

- Docker Engine/Desktop is running and supports Compose v2;
- port 4318 is not used by another service;
- the repository root can hold a local-only `.env.local` and a `data/backups/` directory;
- if you plan to access it from other devices, TLS, a reverse proxy, access control, and an independent backup location are already in place.

On Windows, run:

```powershell
powershell -File scripts/docker-start.ps1
```

The script checks Docker, generates a local authentication token in `.env.local`, starts Compose, waits for the health check, and opens a browser. You can also do it manually:

```bash
docker compose up -d --build
```

Visit `http://127.0.0.1:4318`. The Server does not publish a host port directly; Nginx proxies `/api` on the same origin and injects the authentication token. Works live on the `narralume-data` volume, and backups are written to `${NARRATIVE_BACKUP_HOST_DIR:-./data/backups}`.

Check the runtime state:

```bash
docker compose ps
docker compose logs --tail 100 server web
```

The health endpoint is `http://127.0.0.1:4318/api/health`. Never paste tokens, model requests, or manuscript text from the logs into a public Issue.

Common maintenance entries:

```powershell
# Create an online consistency backup; files go to the separately mounted backups directory
powershell -File scripts/docker-backup.ps1
# Pull updates on a clean source workspace, rebuild, and wait for the health check
powershell -File scripts/docker-update.ps1
# Stop the containers but keep the data volumes
powershell -File scripts/docker-stop.ps1
```

The update script only accepts a Git workspace without local changes; it fast-forward pulls, rebuilds the images, and waits for the health check. It does not create a backup for you — run `docker-backup.ps1` before updating and confirm the backup file actually appears in the host directory.

On Linux/macOS, use the corresponding Compose commands:

```bash
docker compose build --pull
docker compose up -d
docker compose down
```

`docker compose down` stops and removes the containers but keeps the named volumes. After restarting, verify the work count and latest manuscript versions before continuing to write.

Do not use `docker compose down --volumes` unless you explicitly intend to delete all work data. Before exposing the Web port to a LAN or the public internet, you must have a high-entropy `NARRATIVE_AUTH_TOKEN`, TLS, access control, and an independent backup directory.

For more environment variables, see [Configuration](configuration.en.md); for backup and recovery steps, see [Data, privacy, and backup](data-and-backup.en.md).
