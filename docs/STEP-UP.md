# Step-up verification ("Please verify it's you")

Status: **Agreed and built (2026-11-09) → D186.** Enforcement ships behind `SKIFF_STEP_UP=1`; the
policy, plugin, API error mapping and VerifyDialog are in `apps/control-plane/src/lib/server/step-up/`
and the catalog. Remaining work is listed in [IAM.md](./IAM.md) §13.

## 1. What and why

Before a sensitive action, a signed-in user proves again that it's really them. After that, the
**session** counts as verified for **30 minutes** and won't ask again. This is GitHub's "sudo mode".

It sits alongside D10 (an owner's session must prove a second factor at sign-in) and doesn't replace
it. D10 asks "was this session started properly?" and step-up asks "is the person at the keyboard
*now* the account holder?" Two threats are covered:

- an unlocked laptop, or a stolen session cookie, being used to mint keys, read credentials, add a
  passkey or remove other members;
- prompt injection driving the assistant. The confirm click (confirm-policy.ts) stops the model acting
  alone, but a click is cheap; a passkey tap isn't.

## 2. Methods and how one is chosen

| Rank | Method | Class | Notes |
|---|---|---|---|
| 1 | Passkey | strong | Phishing-resistant, `userVerification: 'required'` |
| 2 | Authenticator app (TOTP) | strong | Backup codes are accepted here as the recovery route |
| 3 | Password | basic | Only if the user has a `credential` account with a hash |
| 4 | Email code | basic | 6 digits, 10 min, needs platform mail configured |

**The rule:** the dialog opens on the user's **highest-ranked enrolled method**. "Try another way"
lists only other methods **in the same class**. If you have any strong factor, password and email
code are never offered, so an attacker who has the password or the mailbox can't choose the weaker
option. DESIGN §6.1 already names "hijacked mailbox" as a threat. Specifically:

- **Has a passkey:** passkey preferred; TOTP and backup code under "another way" if enrolled.
- **TOTP only:** TOTP; backup code under "another way".
- **No strong factor:** password if set, else email code. Email code also appears under "another way"
  next to password. After verifying, the dialog suggests adding a passkey.
- **No usable method** (GitHub-only, no mail configured): the action is refused, with a link to add a
  passkey. The OAuth `prompt=login` round trip isn't reliable across providers. Not built (§9).

Owners always have a strong factor (D10), so in practice owners always see passkey or TOTP.

The ordering is a pure function, `chooseMethods(enrolment) → { preferred, alternatives, class }`, in a
new `step-up-policy.ts`. It is unit-tested the same way as `second-factor-policy.ts`.

## 3. The 30-minute window

Two new Better Auth `session.additionalFields`, next to `secondFactor` (`input: false`, so clients
can't set them):

- `verifiedAt`: when this session last passed step-up;
- `verifiedClass`: `'strong' | 'basic'`.

A session is **fresh** for an action when all of these hold:

```
now - verifiedAt < STEP_UP_WINDOW (30 min)
rank(verifiedClass) >= rank(strongest class the user has enrolled now)
action.level !== 'always'
```

- **Fixed window, not sliding.** A sliding window never expires while you keep working, so it would
  be no window at all. The dashboard shows how long is left (§6), and verifying again restarts it.
- **A fresh sign-in counts.** A sign-in seeds `verifiedAt` from the existing after-hook in `auth.ts`:
  passkey sign-in or TOTP at sign-in gives `strong`, password-only gives `basic`. So signing in with a
  passkey and deleting a database five minutes later asks nothing.
- **Enrolling a strong factor** sets `strong` + now, since registering or verifying it proved
  possession. Without this a basic-verified user who adds a passkey would be "under-verified" at once.
- **Cleared** (`verifiedAt = NULL`) on: password change or reset, removing any factor, a role change
  for that user, "Lock now" in the user menu, and the failure budget running out (§5).
- `always`-level actions ignore the window and ask every time. Kept to a very short list (§4).

The window is a constant at first. Making it a platform policy (5–120 min, in Settings → Retention & defaults) is
a cheap follow-up if anyone asks.

## 4. Which actions need it

The registry lives in `@skiff/contracts` (`STEP_UP_ACTIONS`), so the REST, MCP, CLI and dashboard
surfaces all read the same list. Each entry has a `level` (`window` | `always`) and a `tokens` rule
(§7).

| Area | Actions | Level | Tokens |
|---|---|---|---|
| Account security | add/remove passkey, enable/disable TOTP, regenerate backup codes, set/change password, change email, revoke other sessions | window | deny |
| Account security | remove your **last** strong factor; delete account | always | deny |
| Access minting | create API key, approve CLI login, OAuth/MCP consent, connected-app grants | window | deny |
| Members | invite, change role, remove member, cancel invitation | window | deny |
| Ownership | transfer org ownership, remove an owner | always | deny |
| Secrets out | reveal DB credentials / public URL / named credentials, reveal env var values, storage access keys, broker credentials | window | allow |
| Exfil paths | create/edit backup target, create log drain, presign object, create share link | window | allow |
| Destructive | delete project / database / bucket / broker / domain, restore database (PITR), rotate credentials | window | allow |
| Live access | container shell (D127), database studio (D96) | window | deny |
| Platform admin | join tokens, self-update, drain node, HA changes, platform domains/settings | window | deny (already session-only, DESIGN §6.2) |

Things that stay unguarded: reads, deploys, promote/rollback, restarts. These happen all the time
and can be undone. Typed confirmation (`typeToConfirm`) stays where it already is, since it guards
against mistakes rather than impostors.

## 5. Verifying

A small **Better Auth plugin** (`stepUp()`, in `lib/server/step-up/`) provides the endpoints, so it
gets session resolution, the per-IP limiter (`rateLimit.customRules`) and the existing hooks for free:

| Endpoint | Does |
|---|---|
| `GET /api/auth/step-up/status` | `{ freshUntil, class, preferred, alternatives, maskedEmail }` |
| `POST /step-up/passkey/options` | WebAuthn assertion options: `allowCredentials` = **this user's** passkeys, UV required; challenge stored in `verification` bound to the session id, 2 min TTL |
| `POST /step-up/passkey/verify` | Verifies with `@simplewebauthn/server` (already a dependency via `@better-auth/passkey`), bumps the counter |
| `POST /step-up/totp` / `backup-code` | Checks the code against the user's twoFactor secret; remembers the last accepted TOTP step to stop a code being replayed |
| `POST /step-up/password` | Better Auth's password verifier against the `credential` account |
| `POST /step-up/email/send` / `verify` | Code hashed in `verification` (`step-up:<sessionId>`), 10 min, 5 tries; resend 1/min and 5/hour; sent by a new `sendStepUpCodeEmail` in `email.ts` that names the action being attempted |
| `POST /step-up/lock` | Clears the window |

Each verify endpoint first checks that the method is **allowed for this user right now**, using the
same `chooseMethods`. Asking for `/step-up/password` while you have a passkey returns a 403, so the
same-class rule holds on the server and not just in the UI.

Why not reuse what exists:

- **Not `/passkey/verify-authentication`.** It signs in **whichever user owns the passkey** and
  issues a new session cookie. For step-up the assertion must be bound to the current user and must
  not swap the session.
- **Not magic links for email.** A link opens a new tab and breaks the "retry the action" flow; a code
  keeps the user in the dialog.

**Failure budget:** at most 5 failed step-up attempts per session, across all methods except passkey
cancellations; after that the session is revoked. This reuses the `recordSecondFactorFailure` /
`revokeSession` pattern in `second-factor.ts`.

**Audit:** `auth.step_up.succeeded|failed` with method, class and requested action. The sensitive
action's own audit entry gets `verifiedBy: <method>`.

## 6. Enforcement and UX

**Server.** Enforcement mirrors permissions:

- `Principal` gains `verification?: { at: number; class: 'strong' | 'basic'; strongest: Class }`,
  filled in by `principalFromSession` with one extra query. The `userHasSecondFactor` query already
  answers most of it.
- `requireStepUp(principal, action)` in `@skiff/contracts` throws `StepUpRequiredError`, next to
  `requirePermission`. Core services call it at the same point they check the permission, so form
  actions, REST, the assistant and MCP all get the same rule without per-route code.
- Account-security and minting endpoints that are Better Auth's own (passkey register, twoFactor
  enable/disable, api-key create, change-password, organization member/role, oauth consent) are
  checked in the existing `hooks.before` in `auth.ts`, using a path → action map like
  `apiKeyEndpointPermissions`.
- `errorResponse` (lib/server/api.ts) maps the error to
  `403 { error: 'step_up_required', action, level }`. Form actions return the same payload through
  `fail(403, …)`.

**Client.**

- A global `VerifyDialog`, a sibling of the confirm dialog, with `askVerify(action)`.
- `runAction` (lib/actions.ts) and `fetchJson` (lib/query.ts) recognise `step_up_required`, open the
  dialog, and **retry the original request once** after success. Existing buttons need no changes.
- `askConfirm` gets an optional `stepUp: '<action>'`. When the root layout says the session isn't
  fresh, the confirm dialog shows the verify step inline, so there's one dialog instead of two in a
  row.
- The assistant confirm card uses the same handling, so a sensitive tool call means a click plus a
  passkey tap.
- Dialog: the preferred method gets a large button. Passkey doesn't auto-prompt, because Safari needs
  a fresh user gesture. "Try another way" opens the same-class list. TOTP and email use a one-time-code
  input (`autocomplete="one-time-code"`), password uses `autocomplete="current-password"`.
- User menu: a "Verified · 24 min left · Lock" chip while the window is open, from root layout data
  (`freshUntil`).

## 7. Tokens: API keys, CLI, MCP

API keys, CLI tokens and MCP tokens can't show a dialog, so:

- `tokens: allow`: the token is allowed if its scopes permit the action. Minting the token already
  needed step-up, so step-up happened when the token was created. This keeps `skif db credentials`
  and CI working.
- `tokens: deny`: session only, the same idea as `canAdministerPlatform` today. Account security,
  minting new access, members, live shells.

External MCP clients follow the token rules. The in-dashboard assistant runs as the user's session,
so it gets the dialog.

## 8. Dev and tests

- `SKIFF_STEP_UP=0|1`, defaulting to off in dev password-login mode the way `SKIFF_OWNER_2FA` does,
  so headless e2e keeps working. One e2e suite turns it on.
- Unit tests: `chooseMethods` (every enrolment combination, and no downgrade), freshness (window
  edge, class upgrade and downgrade, clearing events), the registry vs. token rules, email-code
  attempt and resend limits, TOTP replay.
- Integration: a wrong-user passkey assertion is rejected; asking for the password method while a
  passkey exists returns 403; a failed step-up never changes the session cookie.

## 9. Out of scope

- Re-auth through GitHub OAuth (`prompt=login` / `max_age`), because GitHub doesn't honour it reliably.
- Remembering a device across sessions. The window belongs to the session and ends with it.
- SMS. It isn't offered anywhere else in Skiff and it's weaker than email in practice (SIM swap).
- Org-configurable action lists.

## 10. Build order

1. **Policy and storage:** `step-up-policy.ts` + tests, session fields, `Principal.verification`,
   `requireStepUp`/`StepUpRequiredError`, the API error mapping.
2. **Verification plugin:** passkey, TOTP/backup, password, email code; limits, failure budget, audit,
   seeding at sign-in, clearing events.
3. **Client:** VerifyDialog, retry in `runAction`/`fetchJson`, confirm-dialog integration, the chip and
   "Lock now".
4. **Wire actions in risk order:** account security → access minting → members/ownership → secret
   reveals → exfil paths → destructive → live access → platform admin.
5. **Docs:** DECISIONS D128, DESIGN §6.1, API.md (`step_up_required`), CLI error text for `deny`
   actions ("do this from the dashboard").

## 11. Open questions

1. 30 minutes for everything, or a shorter window (say 5 min) for the account-security row?
2. Should non-owners who only have a password be pushed to add a passkey (a nag), or only invited to
   after they verify?
3. Should an `always` action also email the user afterwards ("your last passkey was removed")?
4. Should a change in IP hash during the window clear it? That's safer, but mobile users would see
   more prompts.
