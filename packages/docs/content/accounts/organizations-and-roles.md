---
title: Organisations, members and roles
description: How organisations contain projects and people, how invitations work, what each role can do, and how roles limit API keys and OAuth tokens.
---

Everything in Yoal belongs to an **organisation**, and what you can do inside it depends on your **role**. This page explains how organisations work, how to invite and manage members in **Settings → Members**, what each built-in role allows, and how roles interact with API keys and OAuth tokens. For the vocabulary used throughout the docs, see [core concepts](/getting-started/concepts).

## Organisations

An organisation is the tenant boundary. Projects, managed services, API keys, secrets and share links all belong to exactly one organisation, and quotas are set per organisation. Members see only what their role allows inside it.

You normally belong to one organisation. The dashboard has no organisation switcher: if a user has more than one membership, Yoal uses the earliest one.

You cannot create an organisation from the dashboard. Organisations come from two places:

- **Setup.** The first owner created by the setup wizard gets an organisation of their own.
- **Open sign-up.** On an install that runs with `YOAL_OPEN_SIGNUP=1`, each new user gets a personal organisation, with them as its owner. See [configuration](/self-hosting/configuration).

On a normal invite-only install, everyone else joins an existing organisation by accepting an invitation.

To rename the organisation or change its slug, open **Settings → General**. Owners and admins can do this.

## Roles

Every member has exactly one role: `owner`, `admin`, `deployer` or `viewer`.

| Role | What it is for |
| --- | --- |
| `owner` | Everything, including members, API keys and deleting projects. |
| `admin` | Manage projects, deployments, members (except owners) and API keys. |
| `deployer` | Create projects and deploy, promote and roll back. Cannot delete anything or manage members or API keys. |
| `viewer` | Read-only access to projects, deployments, logs and metrics. |

Owners and admins hold the same permissions. The difference is the ownership rules in the next section, and the second-factor requirement for owners described in [sign-in and two-factor authentication](/accounts/sign-in-and-2fa).

### Owners and admins

- Only an owner can invite another owner, grant the owner role, change an existing owner's role, or remove an owner.
- An admin can invite, change and remove everyone else, including other admins.
- An organisation must always keep at least one owner. See [the last owner](#the-last-owner).

## Permissions

Each role is a set of permissions written as `resource:action`, for example `deployment:promote`. The table lists every permission in Yoal and shows which roles hold it. Owners and admins hold all of them.

| Permission | What it allows | Deployer | Viewer |
| --- | --- | --- | --- |
| `project:create` | Create a project. | Yes | No |
| `project:read` | See projects. | Yes | Yes |
| `project:update` | Change a project's settings. | Yes | No |
| `project:delete` | Delete a project. | No | No |
| `deployment:create` | Deploy a release. | Yes | No |
| `deployment:read` | See deployments. | Yes | Yes |
| `deployment:promote` | Point production at a deployment. | Yes | No |
| `deployment:rollback` | Roll production back to the previous deployment. | Yes | No |
| `deployment:delete` | Delete a deployment. | No | No |
| `domain:create` | Add a custom domain. | No | No |
| `domain:read` | See domains. | Yes | Yes |
| `domain:delete` | Remove a custom domain. | No | No |
| `secret:create` | Create a secret with a new name and set its value. | Yes | No |
| `secret:read-metadata` | List secret names and metadata. Values are never listed. | Yes | Yes |
| `secret:update` | Set a new value (a new version) for a secret name that already exists. | Yes | No |
| `secret:delete` | Delete a secret. | No | No |
| `build:create` | Start a build. | Yes | No |
| `build:read` | See builds. | Yes | Yes |
| `build:cancel` | Cancel a build. | Yes | No |
| `database:create` | Create a managed database. | Yes | No |
| `database:read` | See databases. | Yes | Yes |
| `database:update` | Change a database's settings. | Yes | No |
| `database:delete` | Delete a database. | No | No |
| `database:credentials` | Reveal a database's connection credentials. | Yes | No |
| `database:console` | Open the database studio. | Yes | No |
| `storage:create` | Create an object storage bucket. | Yes | No |
| `storage:read` | See object storage. | Yes | Yes |
| `storage:update` | Change object storage settings. | Yes | No |
| `storage:delete` | Delete object storage. | No | No |
| `storage:credentials` | Reveal object storage access credentials. | Yes | No |
| `broker:create` | Create a message broker. | Yes | No |
| `broker:read` | See brokers. | Yes | Yes |
| `broker:update` | Change a broker's settings. | Yes | No |
| `broker:delete` | Delete a broker. | No | No |
| `broker:credentials` | Reveal a broker's connection credentials. | Yes | No |
| `email:read` | See email configuration. | Yes | Yes |
| `email:send` | Send email. | Yes | No |
| `email:update` | Change email configuration. | Yes | No |
| `email:delete` | Delete email configuration. | No | No |
| `email:credentials` | Reveal email sending credentials. | Yes | No |
| `shareLink:create` | Create a share link. | Yes | No |
| `shareLink:read` | See share links. | Yes | Yes |
| `shareLink:revoke` | Revoke a share link or a visitor's session. | Yes | No |
| `logs:read` | Read logs. | Yes | Yes |
| `metrics:read` | Read metrics. | Yes | Yes |
| `apiKey:create` | Create and edit API keys. | No | No |
| `apiKey:read` | See API keys. | No | No |
| `apiKey:revoke` | Revoke API keys. | No | No |
| `member:invite` | Invite members, and cancel pending invitations. | No | No |
| `member:update-role` | Change a member's role. | No | No |
| `member:remove` | Remove a member. | No | No |

> [!NOTE]
> A viewer cannot read secret values, credentials or API keys, and cannot see the Members page's email addresses. Only owners and admins see member email addresses.

## Settings → Members

**Settings → Members** lists everyone in the organisation with their role and join date. Everyone can open the page, but you only see the controls your role allows. Anyone with `member:invite` also sees the list of pending invitations.

### Inviting someone

1. Open **Settings → Members** and select **Invite member**. This needs `member:invite`, so owners and admins can do it.
2. Enter the person's email address and choose a role. Only owners see the owner role in the list.
3. Select **Send invitation**. Yoal emails them a link to `/accept-invitation/<id>` on your platform address. The invitation also appears under **Pending invitations**, where you can copy the link.

An invitation expires after 48 hours. Inviting an address that already has a pending invitation sends the invitation again and renews its expiry. An address that is already a member cannot be invited.

### Accepting an invitation

The invitee follows the link and does the following:

1. **Signs in with the invited address.** Yoal is invite-only, so only invited addresses can create an account. Password sign-up is disabled on invite-only installs. The invitee signs in or creates an account with GitHub, a passkey or an email sign-in link. If they are not signed in, the link sends them to sign-in first.
2. **Checks the account.** The accept page shows the address they are signed in as. Yoal refuses the invitation if that address does not match the invited one, so the invitation must be opened from the right account.
3. **Selects Accept invitation.** Yoal adds them to the organisation with the invited role and opens the overview.

An expired or cancelled invitation cannot be accepted. Send the invitation again from **Settings → Members**.

### Changing a role

Select a member's role in the table to change it. The dropdown lists the roles you may assign. Changes take effect on the member's next request, so a demotion narrows their access straight away, including the permissions of any API keys and OAuth tokens they hold.

### Removing a member

Select **Remove** next to a member and confirm. The member loses access to the organisation immediately, and API keys they created stop working for it. You cannot remove yourself from this page.

> [!NOTE]
> On an install with open sign-up, a removed member who signs in again gets a new personal organisation of their own. Their access to the old organisation does not come back.

### Cancelling an invitation

Select **Cancel** next to a pending invitation and confirm. The invitation link stops working. Cancelling needs `member:invite`.

### The last owner

An organisation always keeps at least one owner. The rules are:

- The only owner cannot be demoted or removed.
- Only an owner can change or remove an owner.
- To step down as the only owner, first make someone else an owner.

If you try one of these actions, Yoal refuses it with a message such as "An organisation needs at least one owner. Make someone else an owner first."

## Platform admins

A **platform admin** is a separate, install-wide role. It is a flag on the user account, not an organisation role, so being an owner does not make you a platform admin, and being a platform admin does not give you any organisation permission you lack.

- The owner created by the setup wizard is a platform admin.
- On an install that predates platform admins, the earliest user is made one during the upgrade.

Platform admins can view the fleet of nodes. Changes to the platform, such as creating node join tokens, draining a node or rotating node tokens, need a platform admin signed in to the dashboard with a normal session. API keys and OAuth tokens cannot make these changes, whatever their scopes. See [nodes and fleet](/self-hosting/nodes-and-fleet).

## Roles and tokens

API keys, CLI logins and MCP clients (through OAuth) all act as a member of the organisation, and never more than that member is allowed to do. A token's **effective permissions** are the scopes it was granted, capped by the issuing user's current role, checked on every request:

```text
effective permissions = granted scopes ∩ the user's current role
```

This has three consequences:

- A key or token can never do more than the person who created it.
- Changing a member's role changes what all of their keys and tokens can do straight away.
- Removing a member stops all of their keys and tokens for the organisation.

A key created in **Settings → API keys** carries only the scopes you ticked. A key with no recorded scopes, such as one created by the CLI's browser login, acts with its owner's full current role. The OAuth scopes an MCP client asks for are shown on the consent screen. See [API keys and tokens](/accounts/api-keys-and-tokens) for how to create and scope keys, and [the MCP page](/clients/mcp) for connecting a client.
