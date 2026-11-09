---
title: Site configuration
description: Reference for the _redirects, _headers and yoal.json files that control routing, headers, caching and error pages in a static deploy.
---

A static deploy can include three optional files at the root of the folder you upload: `_redirects` for redirects and rewrites, `_headers` for response headers, and `yoal.json` for site behaviour such as single-page app routing and clean URLs. The syntax follows the Netlify and Cloudflare Pages conventions, but Yoal supports a subset of it, as listed below. Use this page to write the files and to understand what a deploy rejects. For uploading the folder in the first place, see [static sites](/deploying/static-sites).

## Where the files go

Only files named exactly `_redirects`, `_headers` and `yoal.json` at the top of the upload are read. A file in a subfolder with the same name is ignored. All three are optional. A UTF-8 byte order mark at the start of a file is removed before it is read.

When a request arrives, Yoal applies these steps in order:

1. Access checks for protected sites.
2. Default security headers.
3. `_redirects` lines, in file order.
4. Trailing slash handling and clean URLs, if set in `yoal.json`.
5. The SPA fallback, if set.
6. Default cache policy.
7. `_headers` rules.
8. The file itself, or the 404 page if no file matches.

A redirect in `_redirects` therefore runs before anything in `yoal.json`, and it never bypasses access control on a protected site.

## Redirects and rewrites (`_redirects`)

Each line has the form `<from> <to> [status]`, with fields separated by whitespace. The status defaults to `301`. Blank lines are ignored, and lines starting with `#` are comments. Line numbers in error messages count every line, including comments.

```text
# Moved pages (301 is the default when the status is omitted)
/blog/old-post    /blog/new-post
/news/*           /posts/:splat        301

# Serve a page at a short address without changing the URL in the browser
/docs             /documentation/index.html   200

# Dynamic segment
/authors/:name    /people/:name        302

# Gone for good (the target is ignored for these statuses)
/tmp-campaign     /                    410
```

### Statuses

| Status | Behaviour |
| --- | --- |
| `200` | Rewrite. The visitor gets the content at `<to>`, and the address bar keeps the original URL. |
| `301`, `302`, `303`, `307`, `308` | Redirect to `<to>`. `301` is the default. |
| `404`, `410`, `451` | Respond with that status and an empty body. `<to>` is still required, but it is ignored. |

Any other status is rejected, so `_redirects:3: Unsupported status 999` fails the deploy.

### Matching and placeholders

- A `from` path must start with `/`. It matches the request path exactly, so `/old` does not match `/old/` or `/old?x=1`. Query strings are not matched.
- `:name` matches one path segment and makes its value available in `<to>` under the same name. `/authors/:name` matches `/authors/ada` but not `/authors/ada/notes`.
- `*` matches the rest of the path. It is allowed only as the last character of `from`, so `/a/*/b` is rejected. In `<to>`, `:splat` inserts whatever `*` matched.
- Paths may not contain `..`.

A catch-all rewrite such as `/*  /index.html  200` gives the same result as `spa: true` in `yoal.json`, described below. The setting is simpler, so prefer it for single-page apps.

Lines are compiled in file order, so put specific rules above general ones. A deploy supports at most 1,000 redirect rules.

## Headers (`_headers`)

A path line starts in the first column. The header lines under it are indented with spaces or a tab, and each has the form `Name: value`.

```text
/*
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=()

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/downloads/*
  Content-Disposition: attachment
```

- A path must start with `/`. Use literal paths, or end the path with `*` to match everything after it. `_headers` has no `:name` placeholders.
- A header line before any path line is an error. So is a line that is neither a comment nor `Name: value`, and a value containing control characters.
- Lines starting with `#` are comments, whether or not they are indented.
- Every rule whose path matches a request applies, in file order. If two rules set the same header, the later one wins.
- A deploy supports at most 500 path rules.

### Overriding defaults

`_headers` rules come after Yoal's defaults, so they can replace them. The defaults are:

| Header | Default |
| --- | --- |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Cache-Control` on hashed build output | `public, max-age=31536000, immutable` |
| `Cache-Control` on HTML | `no-cache` |

Hashed files are those whose name carries a content hash, such as `app.3f9a2b7c.js`, or a Vite-style `index-DiwrgTda.js` under `/assets/` or `/_astro/`. Yoal sets no Content-Security-Policy by default, and you can add one with `_headers`.

On a protected site (see [access and sharing](/deploying/access-and-sharing)), Yoal rewrites any `Cache-Control` value you set so that it stays private. It adds `private` and removes `public` and `s-maxage`. For example, `public, max-age=600, s-maxage=600` is served as `private, max-age=600`. Other headers pass through unchanged.

## Site settings (`yoal.json`)

`yoal.json` is a single JSON object. Every key is optional, and the defaults below apply to any key you leave out. Keys that Yoal does not recognise are ignored.

| Key | Type | Default | Behaviour |
| --- | --- | --- | --- |
| `spa` | boolean | `false` | Serves `/index.html` for requests that match no file, when the path has no file extension and is not under `/_app/` or `/assets/`. A request for a missing `.js` or `.png` still gets a 404. |
| `cleanUrls` | boolean | `false` | Serves `/about` from `about.html`, or from `about/index.html` if that exists. The URL does not change. |
| `trailingSlash` | `"always"`, `"never"` or `"ignore"` | `"ignore"` | `always` redirects paths without an extension to a trailing slash (`/docs` to `/docs/`). `never` removes a trailing slash (`/docs/` to `/docs`). The root path is never changed. Both use a 308 and keep the query string. `ignore` does nothing. |
| `notFound` | string or `null` | `null` | A path to the page served for missing files, such as `"/404.html"`. Must start with `/`, must not contain `..`, and is at most 1,024 characters. See custom error pages below. |

Yoal does not check at deploy time that a `notFound` file exists in the upload.

If `spa` is on and `notFound` is not set, missing paths fall back to `/index.html`. If both are set, `notFound` takes precedence for 404s.

```json
{
  "spa": false,
  "cleanUrls": true,
  "trailingSlash": "never",
  "notFound": "/404.html"
}
```

## Validation errors

Yoal checks all three files before storing the deploy. If any check fails, nothing is deployed. The API returns HTTP `422` with `error: "validation"`, and the message lists every problem, one per line, in the form `file:line: message`. Problems in `yoal.json` have no line number, because the file is parsed as a whole. A bad `yoal.json` looks like `yoal.json: trailingSlash: ...` with the reason after it.

```text
_redirects:2: Unsupported status 999; use one of 200, 301, 302, 303, 307, 308, 404, 410, 451.
_headers:5: Expected "Name: value".
```

Common messages:

| Message | Cause |
| --- | --- |
| `Expected "<from> <to> [status]".` | A redirect line has fewer than two or more than three fields. |
| `` `from` must start with "/". `` | A redirect source, or a `_headers` path, is not an absolute path. |
| `` `*` is only allowed at the end. `` | A splat appears in the middle of a redirect source. |
| `Paths may not contain "..".` | A redirect path contains `..`. |
| `Header line before any path.` | An indented header line comes before the first path line. |
| `Header value contains control characters.` | A header value contains a control character. |
| `Invalid JSON: ...` | `yoal.json` does not parse. |
| `` `notFound` must start with "/". `` | The custom 404 path is relative. |

## Custom error pages

Yoal serves its own HTML pages for requests that no site can answer. Each page is self-contained, and the visitor gets plain text instead if their client does not accept HTML, such as `curl` without an `Accept` header.

| Situation | What the visitor sees |
| --- | --- |
| A missing page on a static site with no `notFound` | A "Page not found" page with a link to the homepage. |
| A missing page on a site with `notFound` set | The file at that path, in place of Yoal's page. |
| An address on the content domain with no site behind it | "No site here". |
| A domain that points at Yoal but is not connected to a site | "Domain not connected". |
| Any other unexpected error | "Something went wrong", with a reference ID to quote to the site owner. |

To brand your own 404 page, add it to the upload and point `notFound` at it:

```text
my-site/
├── index.html
├── about.html
└── 404.html
```

```json
{ "notFound": "/404.html" }
```

Only a genuine 404 uses your page. Other errors still show Yoal's pages, so an outage never serves your site's files in their place.
