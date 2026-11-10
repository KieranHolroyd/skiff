# What’s new after an update

Post-update onboarding for platform admins (D212). The goal is narrow: after a Yoal install moves
to a new release, the people who run it see exactly the changes between the version they last
reviewed and the version now running. Changes that need a decision — currently the opt-in
anonymous usage ping — cannot be dismissed as “read”; they wait until someone chooses.

The flow is surfaced to **platform admins** and is install-wide. A platform viewer can open the
page read-only (it is a normal platform view); org members never see it, because the settings
behind consent items are install settings and a consent decision attributed to someone who cannot
change it would be misleading.

## Where it lives

| Piece | Location | Purpose |
| --- | --- | --- |
| Catalog | `packages/contracts/src/whats-new.ts` | The versioned list of changes that ships with the release. |
| Ledger + rules | `packages/core/src/whats-new.ts` | The last reviewed version, per-item decisions, consent actions and audit rows. |
| Page | `apps/control-plane/src/routes/(dashboard)/whats-new` | Reviews items grouped by release and records decisions. |
| Shell notice | `apps/control-plane/src/routes/(dashboard)/+layout.svelte` | A banner and a user-menu entry while items are pending. |
| Fresh-install marker | `apps/control-plane/src/routes/setup/+page.server.ts` | Calls `markInstalled()` so a new install has no backlog. |

The catalog is code, not a file fetched at runtime. A release cannot show a change its code does
not contain, and an air-gapped install needs no network access to learn what changed.

## The version window

An item is visible when

```
lastSeenVersion < item.since <= runningVersion
```

`lastSeenVersion` is the release the admin last cleared the page at. An install upgrading from
`0.13.5` to `0.13.7` therefore sees every item whose `since` is `0.13.6` or `0.13.7`, grouped by
release, newest first. Downgrades show nothing until the running version catches up.

The ledger is one row in the `settings` table (`whats-new`):

```json
{
  "lastSeenVersion": "0.13.7",
  "decisions": {
    "usage-analytics": { "decision": "declined", "at": 1762785600000, "by": "user_…" }
  }
}
```

Only platform admins can read it. Decisions are kept while their item is still in the window and
are cleared when the page is marked as reviewed; the new `lastSeenVersion` covers them.

## First run and fresh installs

- **Existing install, first boot of this feature:** there is no ledger, so the service starts at
  `WHATS_NEW_BASELINE_VERSION` (`0.13.5`). Every item from the release that introduced the ledger
  is shown, which is what an install upgrading from before it needs.
- **Fresh install:** `markInstalled()` runs when setup completes and starts the ledger at the
  running version. A new install does not get a backlog of changes it never experienced.

## Kinds of item

- **`info`** — new behaviour the admin should know about. One decision: `acknowledged`.
- **`consent`** — a setting that does not apply until someone chooses. Decisions are `enabled` or
  `declined`. `enabled` changes the setting; `declined` never changes it, so “not now” cannot turn
  off a setting that was enabled elsewhere. The page shows the **current** state from the service,
  not what the catalog copy assumed.

`acknowledge()` (the page’s “Mark everything as reviewed”) refuses while a consent item is
pending. Silence is not permission.

## Adding an entry

Every release that introduces an admin-visible change adds one object to `WHATS_NEW_ITEMS`:

```ts
{
  id: 'short-stable-id',        // never reused for a different change
  since: '0.14.0',              // the release that ships this entry
  title: 'What changed',
  summary: 'One sentence an admin can act on.',
  body: 'Optional detail: what applies, what does not, and what to do.',
  attention: 'info',            // or 'consent'
  consent: 'usage-analytics',   // only for consent items the service can resolve
  href: '/settings/…',          // where to change it later
  learnMore: 'https://…'        // public docs; the page opens it in a new tab
}
```

Rules of thumb:

- Set `since` to the release that contains the entry, not the first release it was written in. If
  the entry slips to a later release, update `since` in the same change.
- Keep `id` stable. It is the join key for decisions and the audit row.
- Do not add an entry for every fix. This page is for changes that alter what an admin sees,
  configures or must approve. Release notes remain the place for the full changelog.
- A consent item needs a server-side action in `WhatsNewService` as well as a catalog entry. The
  catalog alone cannot grant consent.

## Surfaces

- The shell banner shows the number of pending items and how many need a decision. It is hidden on
  `/whats-new` itself.
- The user menu gets a **What’s new** entry with the pending count.
- `/whats-new` is readable by any platform role (`platform:read`); only a principal that can change
  the setting (`platform:settings`) sees the decision buttons.
- `whats-new.decide`, `whats-new.acknowledge` and `whats-new.installed` are audit rows. A consent
  enable also writes the setting’s own `usage.analytics.update` row.
