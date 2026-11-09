---
title: Sign-in and two-factor
description: How people sign into your cloud, how owners must verify a second factor, how to reset a forgotten password, and how to recover access.
---

This page covers how you sign into your cloud, how the first owner is created, how owners verify a second factor in every session, and how the CLI gets access through your browser. Account management lives under **Settings → Account**, which is described below.

## Sign-in methods

Yoal is invite-only. Nobody can create an account by signing up on their own, so every method below is for an account that already exists.

| Method | Available when | Notes |
| --- | --- | --- |
| Email and password | Always | Works over plain HTTP and on IP-only installs. Passwords are 12 to 128 characters. |
| Passkey | The dashboard is served over HTTPS, or on `localhost` | The button is hidden in browsers or contexts where passkeys cannot work. |
| GitHub | The operator has configured GitHub OAuth | The button appears on the sign-in page only when it is configured. |
| Email sign-in link | Always offered; the link only arrives by email if SMTP is configured | Links expire after 10 minutes. |

On the sign-in page, choose **No password, or prefer a link? Email me a sign-in link** to get a one-time link. Without SMTP, the link is written to the control plane's log instead of emailed, and the page shows the command to find it.

## Reset a forgotten password

1. On the sign-in page, select **Forgot password?** next to the password field.
2. Enter the email address you sign in with and select **Email me a reset link**.
3. Open the link in the email within 30 minutes, then enter and confirm a new password of 12 to 128 characters.

The page answers the same way for every address, so it never shows whether an address has an account. If nothing arrives, check your spam folder. A link works once. Asking for another link is fine, and using any link voids the others.

Saving the new password signs you out of every session on every device, including the one you are using. It does not sign you in. Sign in with the new password as usual. Owners then verify a passkey or authenticator code, because a reset is not a second factor. Your passkeys and authenticator app are not changed.

Reset emails are limited to one a minute and five an hour for each address, and the server also limits how often one network can ask. Each reset appears in your organisation's audit log as `user.password_reset`.

Reset links need email. When the operator has not configured SMTP, **Forgot password?** explains that no link can be sent and that the operator must reset the password for you. See [resetting a password as the operator](#reset-a-password-as-the-operator).

### Configure GitHub sign-in

If a platform admin has created Yoal's [GitHub App](/deploying/github), GitHub sign-in uses the App's OAuth client after the next control-plane restart, and you can skip this section. Environment variables, when set, take precedence over the App.

Otherwise, GitHub sign-in needs an OAuth app on GitHub and two environment variables on the control plane:

```dotenv
GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxxxxxx
GITHUB_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Set the OAuth app's callback URL to `https://control.example.com/api/auth/callback/github`, using your own platform origin. Both variables must be set; if either is missing, GitHub sign-in is disabled. GitHub sign-in does not bypass invitations: a new person can only create an account if they have a pending invitation to their email address.

### Configure email for sign-in links

Sign-in links and invitations are sent through SMTP. Set these on the control plane:

| Variable | Default | Purpose |
| --- | --- | --- |
| `YOAL_SMTP_HOST` | none | SMTP server. Setting it turns on email delivery. |
| `YOAL_SMTP_PORT` | `587` | SMTP port. |
| `YOAL_SMTP_USER` | empty | SMTP username. |
| `YOAL_SMTP_PASSWORD` | empty | SMTP password. |
| `YOAL_SMTP_FROM` | `noreply` at the content domain | Sender address, as `Yoal <noreply@…>`. |
| `YOAL_SMTP_SECURE` | off | Set to `1` for implicit TLS. |

See [configuration](/self-hosting/configuration) for where these are set on a self-hosted install.

## Setting up the first owner

A new install has no users, so the sign-in page sends you to the setup wizard at `/setup`. The installer prints a link containing the setup token. The token is stored on the server, in `/etc/yoal/setup-token` by default, and the control plane falls back to a file in its data directory if that one is missing or unreadable.

The wizard works through four steps:

1. **Check.** It shows the platform origin, whether HTTPS is in use, and whether email and GitHub are configured. If you open the wizard on a different hostname, for example an IP address, it asks you to use the platform address instead, because cookies and passkeys are bound to that origin.
2. **Account.** Enter your name, email address, organisation name and a password (entered twice). Opening the link stores the token in a cookie and removes it from the address bar. If the link was not opened, paste the token or the whole link instead.
3. **Secure.** You must add a second factor before the wizard continues. See [the owner second factor](#the-owner-second-factor).
4. **Done.** Next steps and the account settings.

Creating the owner also gives that account the platform admin role. Once an owner exists, `/setup` no longer creates accounts; it redirects to sign-in.

## The owner second factor

Owners of an organisation must prove a second factor in every new browser session. This applies to the `owner` role only. Admins, deployers and viewers are not asked for a second factor.

A session counts as proved when it was established with a passkey, or when the owner has entered a valid authenticator code or backup code in that session. Signing in with a password, GitHub or an email link is single-factor on its own, so an owner who uses one of those is sent to **Two-factor verification** before anything else:

- **No factor enrolled yet:** the owner is asked to add a passkey (recommended) or an authenticator app.
- **A factor already enrolled:** the owner verifies it with a passkey, an authenticator code, or a backup code.

Until the factor is proved, the dashboard pages and most account actions are refused, and the browser is sent to the verification page. An owner with an unproven session also cannot add or remove a factor, so a compromised GitHub account or mailbox cannot register its own passkey. Five incorrect codes in one unproven session revoke that session, and the owner must sign in again.

API keys and MCP tokens are not affected by the session check. They are created from a proved session in the first place.

The check is on by default. The operator can turn it off with `YOAL_OWNER_2FA=0`; see [recovering access](#recovering-access).

## Authenticator app and backup codes

To set up an authenticator app, open **Settings → Account → Two-factor authentication** or follow the prompt during setup. Scan the setup link on your phone, or enter the setup key by hand in an app such as 1Password, Bitwarden or Google Authenticator, then enter the 6-digit code it shows to confirm.

Setup also gives you a set of one-time **backup codes**. They are shown only once, so save them somewhere safe. Each code works once. Backup codes are accepted on the verification page under **Lost your device? Use a backup code**.

Accounts that already have a password must enter it to add or remove an authenticator app. Accounts without a password do not.

## Settings → Account

**Settings → Account** shows your profile and the following sections.

- **Profile.** Change your display name.
- **Password.** Set a password if you signed in another way, or change it by entering your current password. Changing the password signs out every other session.
- **Two-factor authentication.** Shows whether an authenticator app is set up. You can remove it, which asks for your password if you have one. For owners, this section notes that a second factor is required.
- **Passkeys.** Lists the passkeys on your account, with the authenticator name where it is known. Add a new one with **Add a passkey**, or remove one you no longer use. Each passkey counts as a second factor.
- **Active sessions.** Lists the browser sessions signed in as you, with device, IP address and last activity. Sign out a session you do not recognise, or **Sign out other sessions** to end all but the current one. Use **Sign out** to end the current session.
- **Linked sign-in methods.** Lists external accounts connected to your identity, such as GitHub. Your password and passkeys are managed in the sections above.

## Signing in to the CLI

The `yoal` CLI can sign in through your browser:

```sh
yoal login --url https://control.example.com
```

The CLI opens `/cli/login` in your browser and waits on a local port. The page asks you to confirm that you ran the command on this machine, and shows **Cancel** and **Authorize**. Authorizing sends a one-time code back to the CLI, which exchanges it for a new API key and saves it to `~/.config/yoal/config.json` with mode `0600`. The code expires after five minutes, and the CLI gives up waiting after five minutes too.

Only **owners** and **admins** can authorize the CLI, because only those roles can create API keys. Owners must also have verified their second factor in the current session.

Use `--no-browser` to print the URL instead of opening a browser, for example on a remote machine. To skip the browser entirely, pass an API key with `--token` or set `YOAL_TOKEN`. Keys are covered in [API keys and tokens](/accounts/api-keys-and-tokens), and the full command reference is in the [CLI page](/clients/cli).

## Recovering access

Use one of these routes, in order:

1. **Reset your password** with **Forgot password?** on the sign-in page, if the server sends email. See [reset a forgotten password](#reset-a-forgotten-password).
2. **Sign in another way.** If you have a passkey, GitHub, or an email link that still reaches you, use it. Changing an existing password from **Settings → Account** asks for the current one, so use a reset if you have forgotten it.
3. **Use a backup code** if you lost your authenticator app, or verify with a passkey.
4. **Ask an owner or admin** of your organisation to check your membership and role. Owners can also manage roles; see [organisations and roles](/accounts/organizations-and-roles).

### Reset a password as the operator

Someone with shell access to the control plane can set a user's password directly. Use this when the server has no SMTP, or when the user cannot receive email. On an install made by the installer, run:

```sh
cd /opt/yoal/current/repo/apps/control-plane
sudo -u yoal env YOAL_DATA_DIR=/var/lib/yoal/data /opt/yoal/runtime/bin/bun scripts/reset-password.ts you@example.com
```

The script asks for the new password twice without showing it, or reads the first line of standard input. It has the same effect as a reset by email: every session of that user is signed out, their outstanding reset links stop working, and the reset is recorded in the audit log. Passkeys and the authenticator app are not changed, so an owner still verifies a second factor after signing in. An account that had no password gets one.

If an owner has lost every way to verify a second factor and cannot reach any of the sign-in methods above, an operator with access to the control plane can temporarily turn the owner second factor off:

1. Set `YOAL_OWNER_2FA=0` in the control plane's environment, and restart it.
2. Sign in, then add a new passkey or authenticator app in **Settings → Account**.
3. Remove `YOAL_OWNER_2FA=0`, or set it to `1`, and restart the control plane again.

> [!WARNING]
> While `YOAL_OWNER_2FA=0` is set, anyone who can sign in as an owner, including through a compromised GitHub account or mailbox, can use the platform without a second factor. Keep the window short and turn the check back on as soon as you have re-enrolled.

If the install itself was never completed, the setup link from the installer still works until the first owner exists.
