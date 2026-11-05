# Skiff node container

`ghcr.io/<owner>/skiff-node` runs the node agent and Caddy in one container. It
is the **static-serving** node: the agent pulls desired state, downloads
releases into its cache, and drives Caddy through the admin unix socket.

Tier-2 process apps and tier-3 containers are **not** supported here. Those are
systemd/Podman units rendered by the privileged helper, which needs the host.
Use the systemd install (`docs/OPS.md`) for a full node.

| File | Purpose |
| --- | --- |
| `Dockerfile` | Cross-compiles the agent and Caddy (with the Cloudflare DNS plugin) |
| `entrypoint.sh` | Starts Caddy then the agent; if either exits, the container exits |
| `skiff.Caddyfile` | Bootstrap admin socket; the agent replaces it on first reconcile |
| `compose.yaml` | Arcane/Compose project: one `node` service |
| `.env.example` | Control URL, optional node identity, bind address |

## Build

From the repository root:

```sh
docker build -f docker/node/Dockerfile -t skiff-node .
```

Release tags publish `linux/amd64` and `linux/arm64` as
`ghcr.io/<owner>/skiff-node:<version>` and `:latest`. CI builds the image on
every push so a broken Dockerfile fails before a release.

## Deploy with Arcane

1. In the control plane, open **Nodes → Add node** and copy the join token.
2. Add an Arcane project that git-syncs this repository with
   `docker/node/compose.yaml`, and paste `.env.example` into its environment.
3. Join from the project's console (the volume keeps `node.json`):

   ```sh
   docker compose run --rm --entrypoint /opt/skiff/skiff-agent \
     node join "$SKIFF_CONTROL_URL" --token "$JOIN_TOKEN" --name "$(hostname)"
   ```

4. Start it:

   ```sh
   docker compose up -d
   ```

The node should appear online, and `SKIFF_BIND_ADDRESS:SKIFF_HTTP_PORT` becomes
the `host:port` the edge proxies to.

## WireGuard

- `SKIFF_BIND_ADDRESS` must be this host's tunnel address (for example
  `10.88.0.2`), not `127.0.0.1` and not `0.0.0.0`.
- If the platform hostname resolves publicly, pin it to the edge's tunnel
  address inside the container so desired-state traffic stays on the tunnel:

  ```yaml
  extra_hosts:
    - 'control.example.com:10.88.0.1'
  ```

- Firewall the published port to the edge's tunnel address only.

## Notes

- The agent's release cache and Caddy's state live in the `skiff-data` volume.
  Recreating the container keeps both.
- The image is non-root (uid/gid 10001). Caddy listens on `:8080`; if you ever
  need `:80`/`:443`, publish the container port instead of changing the bind.
- `SKIFF_TLS` is off in the Compose project because the edge terminates TLS.
  Only an edge node terminates TLS itself, and an edge needs the control plane
  too — beyond this image.
