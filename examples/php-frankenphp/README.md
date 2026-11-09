# PHP on Yoal (FrankenPHP)

A PHP app deployed as an ordinary **process app** that scales to zero (D121). FrankenPHP is PHP
embedded in Caddy: it serves `public/` and adopts the listen socket systemd hands it (`bind fd/3`),
so Yoal can stop it after five idle minutes and start it again on the next request.

| File            | What it is                                                                      |
| --------------- | ------------------------------------------------------------------------------- |
| `Caddyfile`     | FrankenPHP config: plain HTTP on the inherited socket, no admin, no certificates |
| `public/`       | The document root                                                               |
| `workload.json` | The project's workload spec (command, memory, idle stop)                        |

## 1. Put FrankenPHP on the node

The static FrankenPHP build is about 175 MB, over the release per-file limit, so it lives on the
node like workerd. It is pinned and checksum-verified, and it is opt-in:

```sh
# a new install
curl -fsSL https://…/install.sh | sudo bash -s -- --with-php
# an installed node (from the Yoal checkout under /opt/yoal/current/repo)
sudo /opt/yoal/runtime/bin/bun /opt/yoal/current/repo/scripts/install/frankenphp.ts
```

That installs `/usr/lib/yoal/frankenphp/<version>/frankenphp` and links `/usr/local/bin/frankenphp`.
Updates keep the pin current on nodes that have it. Place PHP projects on a node that has it; a node
without it fails the unit with "frankenphp: not found" in the logs.

## 2. Create the project and its runtime

Create a project with runtime **process**, then either open **Runtime → Configure runtime** and set:

- Command: `frankenphp run --config Caddyfile`
- Socket activation: on
- Scale to zero after: `300` seconds (0 keeps it always on)
- Variables: `XDG_CONFIG_HOME=/tmp/config`, `XDG_DATA_HOME=/tmp/data`

or send `workload.json` to the API:

```sh
curl -X PUT "https://$YOAL_HOST/api/v1/projects/php-demo/workload" \
  -H "Authorization: Bearer $YOAL_TOKEN" -H 'Content-Type: application/json' \
  --data @workload.json
```

## 3. Deploy

```sh
yoal deploy --project php-demo
```

The first request after an idle stop pays a cold start (FrankenPHP starts in tens of milliseconds;
OPcache is empty again). `hits` in the response is kept in the unit's state directory, so it
survives idle stops and restarts.

## Other languages

The same pattern works for any server that can listen on an inherited socket (`LISTEN_FDS`, fd 3):

| Language | Server                         | How                                                        |
| -------- | ------------------------------ | ---------------------------------------------------------- |
| PHP      | FrankenPHP                     | `bind fd/3` in the Caddyfile (this example)                |
| Python   | Gunicorn                       | `gunicorn --bind fd://3 app:app`                           |
| Python   | Uvicorn                        | `uvicorn --fd 3 app:app`                                   |
| Ruby     | Puma                           | socket activation is built in (`LISTEN_FDS`)               |
| Node.js  | any (`engine: "node"`)         | automatic: the node's preload adopts fd 3 ([`examples/node-http`](../node-http), D125) |
| Go       | `net/http`                     | `net.FileListener(os.NewFile(3, "socket"))`                |
| Bun      | —                              | cannot adopt a listener yet; turn socket activation off and stay always on |

The interpreter itself must be on the node's PATH or inside the release, as with Bun today.
