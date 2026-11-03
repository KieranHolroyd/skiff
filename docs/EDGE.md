# Edge VPS

Reference for the public edge as configured on 2026-11-03.

| | |
|---|---|
| Host | `private-cloud` |
| Address | `178.104.255.136` |
| OS | Ubuntu 26.04.1 LTS |
| Access | SSH as `root`, key only |
| DNS | Cloudflare, zones `kieran.dev` and `kierancloud.dev` |
| Domains | Platform `kieran.dev` · content `kierancloud.dev` |

Cloudflare records are **grey cloud (DNS-only)**, so TLS terminates directly at Caddy and
the zone SSL/TLS mode is not in the request path. If a record is proxied later, set the zone
to **Full (strict)** first, otherwise Caddy's HTTP→HTTPS redirect loops against a Flexible zone.

## Caddy

- Custom build at `/usr/local/bin/caddy`, **v2.11.7**, with `github.com/caddy-dns/cloudflare`.
- The stock `/usr/bin/caddy` (2.6.2, no DNS modules) is unused; a systemd drop-in points the
  unit at the custom binary so package upgrades cannot silently remove the plugin.
- Config: `/etc/caddy/Caddyfile`. Reload: `systemctl reload caddy`.
- Admin API: `unix//var/lib/caddy/admin.sock` only. TCP `:2019` is not bound.
- Cloudflare token: `/etc/caddy/cloudflare.token` (`root:caddy`, `0640`), read at config load
  with `{file./etc/caddy/cloudflare.token}`. It needs `Zone:DNS:Edit` on both zones and is
  required for DNS-01 renewals.

`/etc/systemd/system/caddy.service.d/override.conf`:

```ini
[Service]
ExecStart=
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
ExecReload=
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force --address unix//var/lib/caddy/admin.sock
```

`/etc/caddy/Caddyfile`:

```caddyfile
{
	admin unix//var/lib/caddy/admin.sock
}

(tls_cloudflare) {
	tls {
		dns cloudflare {file./etc/caddy/cloudflare.token}
	}
}

# Content domain: wildcard cert covers the apex and one label (D14).
kierancloud.dev, *.kierancloud.dev {
	import tls_cloudflare
	encode zstd gzip
	@apex host kierancloud.dev
	respond @apex "Skiff edge is up. Nothing is deployed here yet." 200
	respond "Not found" 404
}

# Platform: control plane (SvelteKit/Bun).
control.kieran.dev {
	import tls_cloudflare
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}
```

The agent will replace the content placeholder routes with per-host routes via the admin API;
the Caddyfile is only the bootstrap/catch-all config.

## Records

| Name | Type | Value | Proxy |
|---|---|---|---|
| `kierancloud.dev` | A | `178.104.255.136` | DNS only |
| `*.kierancloud.dev` | A | `178.104.255.136` | DNS only |
| `control.kieran.dev` | A | `178.104.255.136` | DNS only |

Certificates are issued by Let's Encrypt over **ACME DNS-01** and renewed by Caddy.
`kierancloud.dev`, `*.kierancloud.dev`, and `control.kieran.dev` are separate certificates;
the wildcard covers exactly one label.

## Upstreams

- `control.kieran.dev` → `127.0.0.1:3000` (the SvelteKit `adapter-bun` default `PORT`).
  Returns `502` while the control plane is not running.
- Content apex → placeholder `200`; any `<slug>.kierancloud.dev` → `404` until the agent
  adds a route.

## Checks

```sh
dig +short A kierancloud.dev @1.1.1.1
dig +short A control.kieran.dev @1.1.1.1

curl -sSI https://kierancloud.dev | head
curl -sS  -o /dev/null -w '%{http_code}\n' https://anything.kierancloud.dev
curl -sS  -o /dev/null -w '%{http_code}\n' https://control.kieran.dev

openssl s_client -connect 178.104.255.136:443 -servername kierancloud.dev </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -ext subjectAltName
```
