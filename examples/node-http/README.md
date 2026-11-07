# Node.js on Skiff

A dependency-free Node.js server deployed as a **process app** with `engine: "node"` (D125). It
calls `server.listen(PORT)` like any Node app. Nothing in it knows about Skiff or systemd: with
socket activation on, the node's preload moves that `listen()` onto the socket systemd passes, so
the app scales to zero after five idle minutes and starts again on the next request.

| File            | What it is                                                         |
| --------------- | ------------------------------------------------------------------ |
| `server.js`     | The app: JSON on `/`, `ok` on `/health`                            |
| `package.json`  | Its `start` script, which the node runs when Command is blank      |
| `workload.json` | The project's workload spec (engine, memory, idle stop)            |

## 1. Node.js on the node

The installer puts the pinned Node.js LTS on every node by default (`--no-node` skips it). On a
node installed before that, the next update adds it, or run:

```sh
sudo /opt/skiff/runtime/bin/bun /opt/skiff/current/repo/scripts/install/node.ts
```

The node then advertises `process-node`, and only such nodes are offered Node apps.

## 2. Create the project and its runtime

Create a project with runtime **process**, then open **Runtime → Configure runtime** and choose
**Engine: Node.js**, leave **Command** blank, keep socket activation on and set **Scale to zero
after** to `300`. Or send `workload.json` to the API:

```sh
curl -X PUT "https://$SKIFF_HOST/api/v1/projects/node-demo/workload" \
  -H "Authorization: Bearer $SKIFF_TOKEN" -H 'Content-Type: application/json' \
  --data @workload.json
```

## 3. Deploy

```sh
skif deploy --project node-demo
```

## Frameworks

- **Express, Fastify, Koa, Hono (`@hono/node-server`), Nuxt/Nitro, Remix:** unchanged; leave
  Command blank so the `start` script runs.
- **Next.js:** `next build` with `output: "standalone"`, deploy `.next/standalone` (plus `public`
  and `.next/static`), command `node server.js`.
- **SvelteKit (`adapter-node`):** command `node build`; it also adopts the socket by itself.
- Ship dependencies in the release (bundle them, or deploy a standalone build): the node does not
  run `npm install`.
- With socket activation on, do not use `npm start` or `node --run start` as the command. Both
  start the app without the socket, so Skiff refuses them. Leave Command blank or run the server
  directly. With socket activation off they work, and the app listens on `PORT`.
