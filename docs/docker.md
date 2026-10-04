# MundusMaker on Docker / a NAS

The download includes a Docker build and a Compose project. One instance
on your own server lets you continue the same campaign from different devices.
All world files, uploads, library packs and recovery history live in its `/data`
volume. MundusMaker has no external database, cloud service or subscription.

This is a **DM workspace**: everyone who knows its password can read and edit
everything, including GM secrets. Player preview only helps check an export;
it is not a restricted login. Give players the exported player handbook and
handouts, rather than the server password.

## Start it

Use Docker Engine with Compose v2, Docker Desktop, or a NAS container manager
that supports building a Compose project. The official Node 24 Debian image
supports x86-64 and ARM64, including Apple silicon. Your Docker installation
must support your NAS processor; 32-bit ARM and MIPS NAS devices are not targets.
The first build downloads the base image. The running app makes no external
requests except when you press one of its download buttons: the Library's
5etools downloader, Check for updates in Settings, or Get it from… in the
Official sheet dialog.

1. Extract the complete MundusMaker ZIP to a folder on the server. Use the
   folder containing `compose.yaml`. Keep this project folder for future updates.
2. Create a `secrets` folder there. In a plain text editor, create
   `secrets/mundusmaker-password.txt` with one long, unique password, at least
   16 characters. Do not put quotes around it. A final newline is fine.
   The container runs as UID/GID `1000:1000` and must be able to read this file.
   On Linux, a private `secrets` directory (mode `700`) and a readable secret
   file (mode `644`) allow Docker to mount it for that user while restricting
   other host users' access to its parent directory. Keep the file out of backups
   you share with other people.
3. For first use on the same machine, leave the port settings as supplied.
   Run from the project folder:

   ```sh
   docker compose up -d --build
   docker compose ps
   ```

   In a compatible NAS container manager, create/build a project from this
   folder's Compose file instead. The image is built locally; there is no
   MundusMaker image to pull from a public registry.
4. Open **http://localhost:4870** on that machine. The browser's sign-in prompt
   uses username **dm** and the password from your file. The container refuses
   to start with a missing, unreadable or short password.

To reach the NAS from another device, create a plain text `.env` file beside
`compose.yaml`, using the NAS's actual private LAN or VPN interface address:

```dotenv
MUNDUSMAKER_BIND=192.168.1.50
MUNDUSMAKER_PORT=4870
```

The IP above is an example; replace it with your NAS address, then run
`docker compose up -d` again. Open **http://192.168.1.50:4870** using your actual
address. A NAS firewall may also need to allow this port from your private
network. Docker normally publishes unspecified addresses on all interfaces;
this project deliberately defaults to `127.0.0.1`.
[Docker port-publishing reference](https://docs.docker.com/engine/network/port-publishing/)

Wait for **Saved** before closing a browser or switching devices. Open or reload
the same server address on the next device to load current files. Concurrent
edits can produce preserved conflicts; this is not a live collaborative editor.
Only run one MundusMaker container against a given data volume.

## Access away from home

Use a private VPN to your home network, or an HTTPS reverse proxy. Basic
authentication does not encrypt its password by itself. Do not port-forward
the plain HTTP service directly to the public internet.

With a VPN, bind to the NAS's private interface reachable through that VPN and
use that address while connected. No application cloud account is required.

For an existing HTTPS reverse proxy:

- Keep the gateway reachable only by the proxy/private network. A proxy on the
  NAS host can use `http://localhost:4870`; a proxy in another container needs a
  shared private Docker network and `http://mundusmaker:4870` as its upstream.
- Pass the `Authorization` header and preserve the browser's `Host`. Do not
  cache authenticated HTML, API, asset or export responses.
- Set `MUNDUSMAKER_ORIGIN=https://campaign.example.com` in `.env`, replacing
  the example with your actual origin. Use no path prefix. Recreate the container
  with `docker compose up -d`. The gateway checks browser request origins before
  forwarding to the internal app; it does not trust client-supplied forwarded
  host headers.
- Allow uploads up to 64 MiB and sufficient response time for exports and
  library downloads. An additional proxy login must preserve MundusMaker's
  own Authorization header, or it will prevent the DM sign-in from working.

Bookmarks on each device should use this same server address. Browser settings
such as the welcome tour and active world remain per browser profile.

## Keep and move your campaign

The default Compose project is named `mundusmaker`, so extracting a newer
release under a differently named folder does not silently select a new data
volume. Its named volume is `mundusmaker_mundusmaker-data`. Preserve the project
name if using a NAS UI or `docker compose -p` override.

The volume survives container replacement, `docker compose down`, and image
rebuilds. **Do not use `docker compose down -v` or delete this volume** when
upgrading: those operations remove the saved data.
[Docker volume reference](https://docs.docker.com/engine/storage/volumes/)

To move a desktop world without shell commands:

1. In the desktop app, open Settings → Backup, tick **Include images**, and
   click **Download backup (.json)**.
2. On the NAS app, create a new empty world. Open Import → **Restore a backup**
   and select the file. Check the destination world name when confirming.
3. Check entries, maps and images before using the NAS copy. Keep the desktop
   copy as your fallback. Repeat for other worlds; import library packs again
   on the NAS, since world backups do not contain the shared library.

For a large collection, stop both instances and **copy** the complete desktop
data folder, including its hidden folders, into a new NAS data directory. In
Compose replace `mundusmaker-data:/data` with your actual NAS path, for example
`/volume1/mundusmaker-data:/data`. Grant UID/GID `1000:1000` read/write access
only to that copied directory using the NAS permissions editor. Keep the source
unchanged. Do not merge two live data directories or run both servers against
the same files.

Take regular snapshots or backups of the **whole volume**, preferably with the
container stopped. It contains `worlds` (with images, exports and per-entry
history), `.library`, `.snapshots`, `.trash`, `.conflicts`, and `.config`.
Settings backups are useful for a single world; volume backups also keep the
shared library and recovery history. The Settings data-folder box is replaced
with volume guidance in container mode.

For an upgrade, keep `secrets`, `.env`, and your volume, replace the app files
with the new release, then run `docker compose up -d --build`. Do not copy
sample data over existing worlds.

## Password changes and troubleshooting

Set an optional `MUNDUSMAKER_USER` in `.env` to change the username. Set
`MUNDUSMAKER_PASSWORD_PATH` there to use a different host secret-file location.
The password itself belongs only in the secret file, not `.env`, Compose,
command arguments or a Docker image. To rotate it, update the file and run
`docker compose up -d --force-recreate`. Browsers may need to close and reopen
their session to forget cached Basic credentials.
[Compose secrets reference](https://docs.docker.com/reference/compose-file/secrets/)

Use `docker compose logs --tail=80 mundusmaker` for startup trouble. A password
file permissions error means UID 1000 cannot read the mounted file. A `/data`
write error on a bind mount means that copied NAS folder needs permissions for
UID 1000. A 403 after configuring a proxy usually means its Host or configured
origin does not match the browser address. Do not remove authentication to fix it.

The desktop server still binds only to `127.0.0.1`. The container starts its
own backend at loopback port 4871 and exposes only an authenticated gateway on
container port 4870. Do not publish 4871. The image has no npm install or new
runtime packages, runs as a non-root user, and uses a read-only app filesystem.
The build context allowlist excludes your campaigns, secrets, bundled desktop
runtimes, contributor instructions and development artifacts.

Release validation: gateway/authentication, origin checks, guarded downloads,
revision conflicts and persistent-data restart tests run against the actual
Node server. An isolated browser checks the authenticated UI. A Docker engine
was not available on the release host, so image build and NAS deployment still
need a native smoke test; the supplied image has not been claimed as deployed.
