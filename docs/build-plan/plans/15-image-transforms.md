# 15 — Image transforms and media pipeline

**Priority:** P1 · **Effort:** M · **Lane:** B · **Wave:** 3
**Depends on:** 02 object-storage surface
**Blocks:** 14 stacks (media-heavy apps), static-site polish
**Primary files:** `packages/contracts/src/media.ts`, `packages/core/src/media.ts`,
`apps/agent/src/media.ts`, `apps/control-plane/src/routes/api/v1/media/**`, `docs/MEDIA.md`

## Goal

Give static sites and apps responsive images without a third-party service: on-demand resize,
crop, and format conversion with signed URLs, a cache, and a build-time variant generator.

## Non-goals

- A full Cloudinary/ImageKit replacement (AI transforms, video, DAM).
- A global image CDN. Transforms run on the node; delivery is the existing edge.
- Rewriting arbitrary HTML.
- Supporting every format; start with JPEG/PNG/WebP/AVIF.

## Current state

- Yoal precompresses HTML/CSS/JS (`br`/`gzip`) but does not transform images.
- Storage instances serve objects with S3 semantics; no transform route.
- Static sites can reference an external image CDN, but that is a privacy/availability dependency.
- Vercel, Netlify, Cloudflare, Supabase, Appwrite, Bunny, and Fastly all offer image optimization.

## Design

### Two modes

1. **Build-time variants** (recommended default): `yoal images` scans `dist/`, generates AVIF/WebP at
   configured widths, writes a manifest (`images.json`), and leaves the originals. A small `<Image>`
   snippet or a Svelte component uses `srcset`. No runtime cost; no signed URLs.
2. **Runtime transforms**: a managed `media` service (imgproxy) attached to a storage instance,
   behind a public route `<storage>--img.<contentDomain>`, with signed URLs and a cache. Use for
   user-uploaded content and CMS images.

### Managed media profile

- New engine/profile `media` (not a database): pinned `imgproxy` image, memory 128–256 MB, CPU 0.5,
  private port; no public port except the route.
- Config: source bucket(s), allowed widths (`320,640,960,1280,1920`), formats (`avif,webp,jpeg`),
  max source bytes (e.g. 25 MB), max output pixels (e.g. 25 MP), quality, cache dir/size.
- Route: `GET /<bucket>/<key>?w=640&h=480&fit=cover&format=avif&sig=...`.
  - HMAC signature covers bucket, key, width, height, fit, format, expiry.
  - Public buckets can allow unsigned GETs with a default width; private buckets require a signature.
  - Set `Cache-Control: public, max-age=31536000, immutable` for keyed variants; purge on object
    update (or use a version query).
- Cache: disk under the helper state dir or a dedicated cache volume; LRU eviction; max size.
  Cache key includes source ETag/version, so an updated object invalidates.
- Metrics: transforms, cache hit rate, source bytes, output bytes, errors, CPU.
- Limits: rate per org, max concurrent transforms, reject oversized sources, decompression-bomb
  guard.

### Build-time variants

- `yoal images --widths 320,640,960,1280,1920 --formats avif,webp`:
  - Uses `sharp`/`libvips` in the CLI or a build step; no runtime service.
  - Writes `<name>-<width>.<format>` and `images.json` with dimensions/hash.
  - Fails the build if an image is too large or an unsupported format.
  - Prints a `<picture>`/`srcset` snippet; the user opts in.
- Static deploy includes the variants; no extra route.

### Security

- Signed URLs: HMAC with a per-storage key, expiry, method; never expose the root key.
- Source path guard: no `..`, only the configured bucket/prefix.
- Content-type sniffing: only images; reject SVG by default (XSS) or sanitize.
- Rate limit and CPU quota; a transform bomb must not take the node down.
- Audit media config changes, not every transform.

## Implementation order

1. Contract `media` config + table (`media_instances` or a `media` profile on storage) (contract PR).
2. Build-time `yoal images` + manifest + snippet (independent, can ship first).
3. imgproxy profile/unit + route rendering + signing.
4. Cache + metrics + limits.
5. Dashboard: enable media, widths/formats, cache usage, sample URL.
6. Docs + a demo static site.

## Acceptance criteria

- [ ] `yoal images` generates AVIF/WebP at five widths with a manifest; a `<picture>` snippet works.
- [ ] A runtime transform returns a WebP at the requested width, with a correct `Content-Type` and
      cache headers.
- [ ] An unsigned private URL is rejected; a signed URL expires and cannot be reused for another
      key/width.
- [ ] A 30 MB source or a decompression bomb is rejected without crashing the node.
- [ ] Cache hit rate and transform count appear in metrics; cache stays under its limit.
- [ ] Updating an object invalidates its variants.
- [ ] SVG is rejected or sanitized; no script executes from the media origin.

## Tests

- Unit: signature, URL builder, width/format allowlist, cache key.
- Integration: imgproxy container, PNG/JPEG/WebP/AVIF, range, cache hit, purge.
- Security: path traversal, signed URL confusion, oversized image, SVG XSS.
- Performance: 20 concurrent transforms under the CPU cap; RSS baseline.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| CPU abuse | CPU quota, concurrency limit, rate limit, cache |
| Cache poisoning | Sign bucket/key/params; include source ETag |
| Decompression bombs | Max source bytes/pixels; libvips limits |
| SVG XSS | Reject by default; sanitize if enabled |
| Cache growth | LRU + max size + alert |
| Extra service footprint | Only on media-enabled instances; 128–256 MB |

## Rollout

Build-time variants ship first (no runtime risk). Runtime transforms behind
`YOAL_FEATURE_MEDIA` off by default; enable per storage instance. Do not make it a default route.

## Open questions

- imgproxy vs Thumbor: imgproxy is smaller/faster; verify license and pinned digest.
- Should transforms be available for private buckets without a public route? Signed URLs still need
  a reachable host; use the platform gateway from 02 or require public.
- Do we need video thumbnails? No.

## File ownership

Own: `packages/contracts/src/media.ts`, `packages/core/src/media.ts` + test,
`apps/agent/src/media.ts`, `apps/control-plane/src/routes/api/v1/media/**`, `docs/MEDIA.md`,
`apps/cli/src/commands/images.ts`.

Integration-owned: schema/migration, core context/index, helper/agent unit rendering, Caddy route
renderer, dashboard storage page, MCP/CLI registration, e2e harness.
