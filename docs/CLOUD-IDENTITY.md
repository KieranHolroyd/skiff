# Skiff — Cloud identity federation

Status: **issuer, keys, workload tokens, token exchange and Skiff's own consumers built; cloud
federation works.** The platform issuer, discovery document, JWKS, signing-key ring, workload
tokens, the node metadata endpoint and `POST /api/iam/token` are implemented and covered by unit
tests. AWS, GCP and Azure can trust the issuer and exchange a workload token for temporary cloud
credentials without a stored secret. Skiff's REST API, MCP and registry realm now accept a workload
or STS token; storage STS and automatic cloud setup remain (§7). IAM.md tracks the plan (I16–I18,
§7.3–§7.4) and API.md the routes.

Two different things share the same issuer:

1. **Direct federation.** A cloud provider trusts Skiff's public issuer and verifies a workload JWT
   itself. Skiff is not in the request path; the workload talks to AWS, GCP or Azure directly.
2. **Skiff token exchange.** A caller presents any trusted subject token to `POST /api/iam/token`
   and gets a short-lived Skiff access token for a service account. This is RFC 8693 token
   exchange, for calling Skiff rather than a cloud.

Both use ES256 keys from one ring. Neither needs a long-lived cloud secret in the workload.

---

## 1. Issuer

The issuer is the platform origin, exactly as configured (`https://control.example.com`). There is
one issuer and one public JWKS for every signing purpose except user pools.

| Endpoint | What it serves |
|---|---|
| `GET <origin>/.well-known/openid-configuration` | Issuer, `jwks_uri`, `token_endpoint`, supported grant and subject-token types, and the claim names Skiff mints. Public, cached 5 minutes. |
| `GET <origin>/.well-known/jwks.json` | Every ring purpose except `pool:*`: `sts`, `workload`, `oidc`, `registry`. Public, cached 5 minutes. |
| `POST <origin>/api/iam/token` | RFC 8693 token exchange (§3). No `/api/v1` prefix. |

The discovery document is OIDC-shaped but is **not a sign-in provider**: there is no
`authorization_endpoint`, no user login and no id-token issuance to browsers. User pools are the
separate tenant-facing OIDC providers (IAM.md §11.2).

The discovery document advertises:

- `id_token_signing_alg_values_supported`: `ES256` only.
- `grant_types_supported`: `urn:ietf:params:oauth:grant-type:token-exchange`.
- `subject_token_types_supported`: access token, JWT and ID token.
- `token_endpoint_auth_methods_supported`: `none`, because the subject token is the credential.
- claims `iss`, `sub`, `aud`, `exp`, `iat`, `nbf`, `jti`, `scope`, `org_id`, `trust_id`, `act`.

### 1.1 Keys and rotation

Every purpose is keyed by a `kid` derived from the key's RFC 7638 thumbprint. Keys are P-256
(ES256); the private JWK is sealed with the platform master key and never leaves the control plane.

Rotation is next → active → retired:

- `ensure(purpose)` creates the first active key.
- `rotate(purpose)` publishes a fresh `next`, promotes the previous `next` to `active`, and
  retires the previous `active`. The first rotation after `ensure` only publishes a `next` and
  keeps the existing active key signing, so no purpose is ever left without a signer.
- A retired key stays in JWKS for the longest token TTL (one hour) plus a 24-hour margin. A token
  signed moments before a rotation therefore still verifies.
- Leave a `next` published for 24 hours before rotating again. That cadence is policy, not a
  correctness requirement: the retired-key window is what makes rotation safe.
- The maintenance sweep rotates `registry`, `oidc`, `sts` and `workload` every 30 days, publishing
  a `next` key first and promoting it only after the 24-hour overlap. `GET /api/v1/iam/keys` shows
  the decision it would take; `POST /api/v1/iam/keys/rotate` and `skif iam keys rotate` run it on
  demand (D196).

`purpose` is independent: rotating `sts` does not change `workload` or `oidc`. User pools rotate
under `pool:<id>` and publish their own issuer and JWKS, not the platform one.

AWS is configured with the discovery URL; GCP and Azure take the issuer string. All three cache
keys or metadata, so the overlap windows matter: do not remove an old key before its retired window
closes.

### 1.2 Pipeline OIDC alias

Pipeline jobs still have their pre-ring issuer `<origin>/api/pipeline/oidc` for one release (D162),
with discovery at `<issuer>/.well-known/openid-configuration` and keys at `<issuer>/jwks`. It is
signed by the ring's `oidc` purpose and keeps the legacy settings key published during the overlap.
New cloud setups should use the platform origin, not the path alias.

---

## 2. Tokens

### 2.1 Workload tokens

A process or container workload runs as a service account. The control plane mints one token and
the agent delivers it; the token is audience-bound and short-lived.

| Claim | Value |
|---|---|
| `iss` | The platform origin. |
| `sub` | The service account id, `sa_…`. This is the value a cloud trust policy matches. |
| `aud` | `skiff` by default, or the audience requested from the metadata endpoint. |
| `org_id` | The organisation id. |
| `project_id` | The project id. |
| `environment` | The environment slug, e.g. `production`. |
| `act.sub` | `wl:<project>/<environment>` — the stable workload name. |
| `act.name` | The service account name, normally `wl-<project>-<env>` (or the spec override). |
| `iat` / `exp` | Issued at, and exactly one hour later. |

The exact `sub` distinction matters for cloud policies:

- **`sub` is `sa_…`**, not `wl:<project>/<env>`. The service account is the principal the
  workload runs as, and it is what AWS `:sub`, GCP `google.subject` and Azure `subject` compare.
- **`act.sub` is `wl:<project>/<env>`** and `act.name` is the human-readable account name. GCP can
  map `act.sub` into an attribute; AWS and Azure federated credentials cannot match an arbitrary
  nested claim, so they use `sub`.
- An `identity.serviceAccount` override in the workload spec changes `act.name` and the `sub`
  account id, but `act.sub` remains the `wl:<project>/<env>` workload name.

Delivery:

- The agent/helper writes the token to `/run/skiff/identity/<workload>/token` on the host (0400,
  owned by the workload uid) and mounts it at `/var/run/skiff/token`. `SKIFF_TOKEN_FILE` names it.
- The agent refreshes at 50% of the token's lifetime (30 minutes) and rewrites the file. A process
  that reads the file per request gets the current token; one that copied it at startup has at most
  an hour.
- The node-local metadata endpoint serves other audiences. A process reaches
  `http://127.0.0.1:8086/identity/token?audience=…`; a container reaches
  `http://host.containers.internal:8086/identity/token?audience=…`. `SKIFF_IDENTITY_URL` carries
  the right base URL for the runtime. The caller presents the current workload token as
  `Authorization: Bearer <token>`; the endpoint returns
  `{ access_token, expires_in, token_type: "Bearer" }`.
- `GET /identity/token` is the only metadata path. Anything else is a 404, never a proxy.

The metadata endpoint does not trust claims from the request. It matches the presented token
against the agent's in-memory set (constant-time), then asks the control plane to mint for that
workload id and audience. A leaked expired token still only buys a token for the same workload.

### 2.2 STS tokens

The exchange mints an ES256 access token for the trust's service account:

| Claim | Value |
|---|---|
| `iss` | The platform origin. |
| `sub` | The trust's service account id, `sa_…`. |
| `aud` | The requested audience, or the platform origin. |
| `org_id` | The trust's organisation. |
| `trust_id` | The `federation_trusts` row that matched. |
| `scope` | The narrowed permission names, when any. |
| `resources` | The trust's resource restriction, when any. |
| `act` | `{ iss, sub }` of the subject token (RFC 8693 §4.1), so an audit trail names the caller. |
| `iat` / `exp` | Issued at, and 15 minutes later by default. |

The trust's `max_ttl_seconds` caps the lifetime at one hour. There is no refresh token: exchange
again while the subject token is valid.

Pipeline OIDC tokens keep GitHub's subject shape while their path issuer remains:
`repo:<org>/<repository>:environment:<env>`, `…:pull_request`, or `…:ref:<ref>` (D162). They are
not workload tokens; a cloud trust for pipelines matches those subjects, not `sa_…`.

### 2.3 Audience and TTL summary

| Token | Audience | TTL |
|---|---|---|
| Workload, Skiff API | `skiff` | 1 hour, refreshed at 50% by the agent |
| Workload, AWS | `sts.amazonaws.com` | 1 hour |
| Workload, GCP | The workload identity provider resource name, `//iam.googleapis.com/…` | 1 hour |
| Workload, Azure | `api://AzureADTokenExchange` | 1 hour |
| Skiff STS | Caller-chosen; defaults to the platform origin | 15 minutes default, trust cap up to 1 hour |

The audience is 1–512 printable characters, with no control characters. Cloud providers also
impose their own session limits; AWS role session duration and Azure token lifetime are set on the
cloud side.

---

## 3. Skiff token exchange (RFC 8693)

`POST /api/iam/token` takes form-urlencoded fields (JSON is accepted for convenience). The subject
token is the credential; the endpoint needs no session or API key.

| Field | Required | Notes |
|---|---|---|
| `grant_type` | yes | `urn:ietf:params:oauth:grant-type:token-exchange`. |
| `subject_token` | yes | A signed JWT. |
| `subject_token_type` | no | `access_token`, `jwt` or `id_token`. It is validated when present; the verifier is chosen from the token itself. |
| `audience` | no | Audience of the token to mint; defaults to the platform origin. |
| `scope` | no | Space-separated permission names. It can only narrow what the trust allows. |
| `trust_id` | no | Use one trust instead of considering every trust for the issuer. |

The response is:

```json
{
  "access_token": "eyJ…",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer",
  "expires_in": 900
}
```

There is no refresh token and no `scope` echo. Errors are RFC 8693 shapes with status 400 and
`cache-control: no-store`:

```json
{ "error": "invalid_grant", "error_description": "The subject token does not match any federation trust." }
```

### 3.1 Which subject tokens are accepted

- A token signed by this platform's ring under `sts`, `workload` or `oidc`. The ring checks the
  signature, issuer and expiry; the trust supplies the audience and subject policy.
- The legacy pipeline OIDC token (`<origin>/api/pipeline/oidc`), still accepted until the pipeline
  issuer moves fully onto the ring.
- Any external OIDC token whose `iss` matches an enabled trust. RS256 and ES256 are supported.
  GitHub Actions uses its special JWKS path (`/.well-known/jwks`); other issuers use
  `/.well-known/jwks.json`, then their discovery document's `jwks_uri`.

### 3.2 Matching

For each enabled trust with the subject's issuer:

1. The subject token's `aud` must be in the trust's `audiences` array.
2. Its `sub` must match `subject_pattern`. `*` matches within one path segment, `**` across
   segments; missing or `*` matches every subject.
3. Every entry in `claim_conditions_json` must match the corresponding claim. A primitive matches
   exactly, an array is a set of allowed values, and an object compares as JSON.
4. The trust's service account must not be disabled.

If several trusts match, the most specific subject pattern wins (the one with the most literal
characters), then the lowest id. `trust_id` narrows the search when the caller knows the trust.

The trust's `audiences` list is the set of **subject-token** audiences it accepts. It does not
restrict the audience of the token that comes back; `--audience` chooses that independently.

### 3.3 Narrowing

`restriction_json` is the ceiling, with the credential shape used elsewhere:
`{ "permissions": string[], "resources": string[] }`.

- With a permission ceiling, a requested `scope` must be a subset; an outside permission is
  `invalid_grant`. No `scope` means the ceiling.
- With no ceiling, the service account's bindings are the ceiling and `scope` is the caller's own
  narrowing.
- Resource restrictions are copied to the minted token and cannot be widened.

Every exchange is audited as `iam.token.exchange` with the trust, issuer, subject, audience, scope
and lifetime. It never records the subject token.

### 3.4 CLI

From a workload:

```sh
skif identity token --audience sts.amazonaws.com
```

The command reads `$SKIFF_TOKEN_FILE` (or `/var/run/skiff/token`) and, for a non-`skiff` audience,
calls `$SKIFF_IDENTITY_URL` (or `http://127.0.0.1:8086`). It prints only the token; `--json` prints
the whole token response. The subject token is never printed.

To run an exchange:

```sh
skif sts exchange \
  --subject-token-file "$SKIFF_TOKEN_FILE" \
  --audience https://control.example.com \
  --scope project:read
```

`skif sts exchange` posts to `/api/iam/token` at the active profile's platform URL. `--scope` may be
repeated or comma-separated; `--trust-id` selects one trust. The command prints only
`access_token`; `--json` prints the full response. The subject file is read silently and is never
included in an error or a log line.

Equivalent raw calls:

```sh
curl -fsS -X POST https://control.example.com/api/iam/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  -d subject_token="$(cat "$SKIFF_TOKEN_FILE")" \
  -d audience=https://control.example.com \
  -d scope=project:read
```

and, inside a workload without the CLI:

```sh
TOKEN=$(curl -fsS \
  -H "Authorization: Bearer $(cat "$SKIFF_TOKEN_FILE")" \
  "$SKIFF_IDENTITY_URL/identity/token?audience=sts.amazonaws.com" |
  jq -r .access_token)
```

Both forms put the subject token on the command line or in a variable briefly; keep the file at
mode 0400 and avoid shell tracing (`set -x`) around them.

---

## 4. Worked example: AWS

The workload token is a standard OIDC web identity token. AWS trusts the Skiff issuer and returns
temporary role credentials; no access key is stored in the workload.

### 4.1 Create the OIDC provider

In IAM → Identity providers → Add provider:

- Provider type: OpenID Connect.
- Provider URL: `https://control.example.com` (the exact issuer; no `/.well-known` suffix).
- Audience: `sts.amazonaws.com`.

The provider ARN is then
`arn:aws:iam::<account-id>:oidc-provider/control.example.com`. If the issuer contains a path, the
ARN keeps the path without the scheme.

AWS fetches the discovery document and JWKS. If the console asks for a thumbprint, let it fetch
one; only add a manual thumbprint when your tooling requires it.

### 4.2 Role trust policy

Create a role whose trusted entity is the provider. Restrict both the audience and the service
account:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/control.example.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "control.example.com:aud": "sts.amazonaws.com",
          "control.example.com:sub": "sa_01J9Z8K4Q7M2V6R3T5W8X1Y0AB"
        }
      }
    }
  ]
}
```

The value in `:sub` is the workload's service account id. Do **not** put
`wl:shop/production` there: that value is `act.sub`, and AWS OIDC condition keys compare `sub`.
Use one trust per workload, or a `StringLike` pattern when several workloads share an account and
you accept the wider blast radius.

### 4.3 Inside the workload

```sh
ROLE_ARN="arn:aws:iam::123456789012:role/skiff-deploy"

TOKEN="$(skif identity token --audience sts.amazonaws.com)"

aws sts assume-role-with-web-identity \
  --role-arn "$ROLE_ARN" \
  --role-session-name "skiff-$(date +%s)" \
  --web-identity-token "$TOKEN" \
  --duration-seconds 3600
```

The result is the usual `Credentials` object. Use the returned access key, secret key and session
token in the SDK or the CLI; they expire on their own. If the workload does not contain the Skiff
CLI, use the `curl` metadata form in §3.4 and feed `.access_token` to the same command.

The role's policies, not Skiff, decide what the session can do. Nothing in Skiff stores an AWS
secret for this path.

---

## 5. Worked example: GCP

GCP workload identity federation maps the Skiff workload onto a Google service account.

### 5.1 Create the pool and provider

```sh
PROJECT_NUMBER=123456789012
POOL=skiff
PROVIDER=skiff-workloads
GCP_AUDIENCE="//iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"

gcloud iam workload-identity-pools create "$POOL" \
  --location=global \
  --display-name="Skiff workloads"

gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
  --location=global \
  --workload-identity-pool="$POOL" \
  --display-name="Skiff workloads" \
  --issuer-uri="https://control.example.com" \
  --allowed-audiences="$GCP_AUDIENCE" \
  --attribute-mapping="google.subject=assertion.sub,attribute.project=assertion.project_id,attribute.environment=assertion.environment,attribute.workload=assertion.act.sub" \
  --attribute-condition="assertion.sub == 'sa_01J9Z8K4Q7M2V6R3T5W8X1Y0AB'"
```

GCP compares `google.subject` with the token's `sub`; that is the service account id. The
`attribute.workload` mapping is optional and exposes `wl:<project>/<env>` for a
`principalSet://` binding. The provider resource name is also the audience GCP expects, so the
workload token must be minted with exactly `$GCP_AUDIENCE`.

### 5.2 Let the workload impersonate a service account

```sh
SA_EMAIL="deployer@my-project.iam.gserviceaccount.com"
SUBJECT="sa_01J9Z8K4Q7M2V6R3T5W8X1Y0AB"
MEMBER="principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/subject/${SUBJECT}"

gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --role="roles/iam.workloadIdentityUser" \
  --member="$MEMBER"
```

To bind every workload in a project instead, use
`principalSet://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/attribute.project/<project-id>`.
That is broader; prefer the exact subject where possible.

### 5.3 Credential file and gcloud

Write an external-account credential file that reads a subject token from a file:

```json
{
  "type": "external_account",
  "audience": "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/skiff/providers/skiff-workloads",
  "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
  "token_url": "https://sts.googleapis.com/v1/token",
  "credential_source": {
    "file": "/run/skiff/gcp-subject.jwt"
  }
}
```

Mint the subject token for the GCP audience first, then sign in:

```sh
export GCP_AUDIENCE="//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/skiff/providers/skiff-workloads"
skif identity token --audience "$GCP_AUDIENCE" > /run/skiff/gcp-subject.jwt
gcloud auth login --cred-file=/run/skiff/gcp-cred.json
gcloud auth print-access-token
```

For application default credentials, point the SDK at the same file:

```sh
export GOOGLE_APPLICATION_CREDENTIALS=/run/skiff/gcp-cred.json
```

The subject file is a one-hour credential. The Google auth libraries re-read
`credential_source.file` when they refresh, so keep it current: mint it at startup and then before
it expires (a small shell loop is enough), or have the entrypoint regenerate it. Do not copy the
workload file itself into `credential_source.file`; it has audience `skiff` and will not match the
GCP provider.

---

## 6. Worked example: Azure

Azure calls the subject token a federated credential assertion. The app registration trusts the
Skiff issuer for one subject and one audience.

### 6.1 Add the federated credential

```sh
APP_ID="00000000-0000-0000-0000-000000000000"   # the app registration's client id
TENANT_ID="11111111-1111-1111-1111-111111111111"

cat > skiff-federated-credential.json <<'JSON'
{
  "name": "skiff-production",
  "issuer": "https://control.example.com",
  "subject": "sa_01J9Z8K4Q7M2V6R3T5W8X1Y0AB",
  "audiences": ["api://AzureADTokenExchange"]
}
JSON

az ad app federated-credential create \
  --id "$APP_ID" \
  --parameters @skiff-federated-credential.json
```

The issuer is the exact platform origin, the subject is the workload's `sub` (`sa_…`), and the
audience is exactly `api://AzureADTokenExchange`. A mismatch in any of the three is rejected by
Entra ID before Skiff is involved.

### 6.2 Exchange the token

The Azure CLI keeps the assertion out of your code and performs the exchange:

```sh
TOKEN="$(skif identity token --audience api://AzureADTokenExchange)"

az login \
  --service-principal \
  --username "$APP_ID" \
  --tenant "$TENANT_ID" \
  --federated-token "$TOKEN"
```

Or perform the same request the CLI does:

```sh
curl -fsS -X POST \
  "https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token" \
  --data-urlencode "client_id=${APP_ID}" \
  --data-urlencode "scope=https://management.azure.com/.default" \
  --data-urlencode "grant_type=client_credentials" \
  --data-urlencode "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  --data-urlencode "client_assertion=${TOKEN}"
```

The response contains an Azure access token with the app's permissions. `azure/login` in GitHub
Actions performs exactly this exchange, but sources its assertion from GitHub's OIDC issuer, not
Skiff's. For a workload running on Skiff, use `az login --federated-token` (a recent Azure CLI) or
the raw request above; configure the federated credential with the Skiff issuer and `sa_…` subject.

---

## 7. What is consumed, and what is not

Skiff's own surfaces verify the same tokens the issuer mints (D195):

- **REST.** `principalFromRequest` falls back from a Better Auth key and a `skif_` access key to a
  workload/STS bearer token. The token must be signed by the ring, unexpired, issued by the
  platform, and carry an accepted audience (`skiff` for a workload; `skiff` or the platform origin
  for STS). It resolves to the service account's bindings, narrowed by the token's
  `scope`/`resources` (an absent scope means the bindings are the ceiling; an empty one is not
  widened).
- **MCP.** The OAuth verifier runs first; on its 401 the route falls back to the ring with
  `skiff` or the MCP resource as the STS audience and passes the service-account principal to the
  tool layer. Everything else keeps the OAuth challenge so clients can sign in.
- **Registry realm.** The Docker token realm accepts a workload/STS token as `Bearer` or as the
  Basic password (Docker always sends Basic). The grant is still intersected with the caller's
  `image:*` permissions in its own org and the token's restriction. The registry's own realm tokens
  and the old `job.<id>` / `github-oidc` logins remain.

A missing or disabled service account, or a token whose `org_id` no longer matches it, is refused
even though the signature is valid. There is no `jti` or revocation list: a minted token is valid
until `exp`, and disabling the account stops only new mints.

The following are **not** built, and docs that describe them as working are ahead of the code:

- **Storage STS.** RustFS has no `AssumeRoleWithWebIdentity` wiring. Attached storage still uses
  static attachment keys (D66); the workload token is not exchanged for S3 credentials.
- **Automatic cloud setup.** Nothing creates an AWS OIDC provider, a GCP pool/provider, an Azure
  federated credential or an IAM role. Everything in §4–§6 is manual, one cloud at a time.
- **A federation-trust dashboard beyond Settings → Access.** Trusts are managed at
  `/api/v1/federation-trusts` and `skif federation` (D190); there is no separate page.
- **Token revocation.** There is no `jti` denylist; keep TTLs short, as the defaults do.

For a cloud-only use (the common case), none of the missing parts matter: AWS, GCP and Azure
verify the workload token themselves against the public issuer. That path is usable today.
