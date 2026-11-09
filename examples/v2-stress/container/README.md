# v2-stress (container variant)

Yoal v2 runs tier-3 workloads as rootless Podman Quadlet units. This image is the same app as
`../src/server.ts`, bundled and copied into a small Bun image. Build it where Podman/Docker can
push to a registry your node can pull from.

```sh
# from examples/v2-stress
bun run build
docker build -t registry.example.com/v2-stress:dev -f container/Dockerfile .
docker push registry.example.com/v2-stress:dev

YOAL_URL=https://control.example.com YOAL_TOKEN=yoal_… \
  bun scripts/provision.ts --slug v2-stress-container \
  --runtime container --image registry.example.com/v2-stress:dev
```

The helper writes the release's data directory to `/data`, publishes `127.0.0.1:<port>:<port>`,
drops all capabilities and runs the container read-only. `HOST=0.0.0.0` is set by the provision
script (and the image) so the published port reaches the process; the app still writes only to
`/data`.

Notes:

- The deployment artifact is a tiny marker file. A container workload's runtime is its image; the
  release exists so the normal deploy/promote/rollback pipeline has a deployment to point at.
- Use a digest or immutable tag. `:latest` makes rollback compare the wrong thing.
- `--memory` and `--crash` work the same way; OOM kills are visible as `failed` after the restart
  budget is exhausted.
