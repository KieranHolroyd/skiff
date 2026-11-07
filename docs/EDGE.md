# Edge VPS

Reference for the public edge as configured on 2026-11-03.

| | |
|---|---|
| Host | `private-cloud` |
| Address | `178.104.255.136` |
| OS | Ubuntu 26.04.1 LTS |
| Access | SSH as `root`, key only |
| DNS | Cloudflare, zones `example.com` and `examplecloud.com` |
| Domains | Platform `example.com` · content `examplecloud.com` |

Cloudflare records are **proxied (orange cloud)**. TLS still terminates at Caddy; the zones
must be **Full (strict)** for origin validation. `examplecloud.com` is zone-wide Full (strict);
`example.com` stays Flexible for unrelated services and uses a Configuration Rule that sets
`control.example.com` to Full (strict). Visitors reach Caddy through Cloudflare, so the real
client IP is in `CF-Connecting-IP`.

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
	admin unix//var/lib/caddy/admin.sock|0660
}

(tls_cloudflare) {
	tls {
		dns cloudflare {file./etc/caddy/cloudflare.token}
	}
}

# Content domain: wildcard cert covers the apex and one label (D14).
examplecloud.com, *.examplecloud.com {
	import tls_cloudflare
	encode zstd gzip
	@apex host examplecloud.com
	respond @apex "Skiff edge is up. Nothing is deployed here yet." 200
	respond "Not found" 404
}

# Platform: control plane (SvelteKit/Bun).
control.example.com {
	import tls_cloudflare
	encode zstd gzip
	reverse_proxy unix//run/skiff/control.sock
}
```

The agent replaces this bootstrap config with the full platform + content route table via the
admin API. The Caddyfile is only the bootstrap/catch-all config. The installer also gives Caddy
the `skiff` supplementary group (to read release artifacts) and sets the admin socket to `0660`.

## Records

| Name | Type | Value | Proxy |
|---|---|---|---|
| `examplecloud.com` | A | `178.104.255.136` | Proxied |
| `*.examplecloud.com` | A | `178.104.255.136` | Proxied |
| `control.example.com` | A | `178.104.255.136` | Proxied |

Certificates are issued by Let's Encrypt over **ACME DNS-01** and renewed by Caddy.
`examplecloud.com`, `*.examplecloud.com`, and `control.example.com` are separate certificates;
the wildcard covers exactly one label.

## Upstreams

- `control.example.com` → `unix//run/skiff/control.sock` (adapter-bun on the control-plane socket).
  The installer rewrites the bootstrap Caddyfile to this upstream; the agent then owns the full
  config via the admin API.
- Content apex → placeholder `200`; any `<slug>.examplecloud.com` → `404` until the agent
  adds a route.
- A live project that has never been deployed (created in the dashboard, nothing pushed yet)
  answers `200` at `<slug>.examplecloud.com` with a default "Nothing deployed yet" page that
  shows `skiff deploy` and links to the project in the dashboard. The control plane lists these
  hosts in the edge's desired state (`placeholders`); the first production deployment replaces
  the page with the real route. Workers have no host and get no page.

## Checks

```sh
dig +short A examplecloud.com @1.1.1.1
dig +short A control.example.com @1.1.1.1

curl -sSI https://examplecloud.com | head
curl -sS  -o /dev/null -w '%{http_code}\n' https://anything.examplecloud.com
curl -sS  -o /dev/null -w '%{http_code}\n' https://control.example.com

openssl s_client -connect 178.104.255.136:443 -servername examplecloud.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -ext subjectAltName
```
