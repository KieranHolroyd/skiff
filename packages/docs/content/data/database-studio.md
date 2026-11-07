---
title: Database studio
description: Browse, query and edit a managed database from the dashboard, read-only by default, with per-session limits and an audit trail.
---

The database studio is a browser workspace for a managed database. Open it from **Databases → name → Studio** to browse schemas and tables, edit rows, run queries and inspect results without installing a client or handing out a connection string. Sessions are read-only unless you turn on writes, expire on their own, and stop at fixed row, byte and time limits.

## Supported engines

The studio works for PostgreSQL, MySQL, MariaDB, MongoDB, Valkey and Redis. ClickHouse databases have no studio, so the **Open studio** link is not shown for them. For the other engines, see [managed databases](/data/databases).

Each engine has its own object model. Relational engines show schemas, tables and views in a tree; MongoDB shows collections as documents; Valkey and Redis show keys by type. The grid and query editor work the same way across them, but what you can change, and which query tools appear, depends on the engine. Key-value engines have no **Explain**.

## Opening a session

Open the studio from the database's page with **Open studio**. A session belongs to you and one database. It is read-only until you choose otherwise, and the studio tells you so in the header.

- **Read-only** is the default. You can browse, filter, run queries and export results, but nothing can be written.
- **Enable writes** in the header opens a write session. It needs the `database:update` permission in addition to `database:console`. The change applies to this session only and does not persist after you close it.
- A session lasts 60 minutes from when you open it, and closes after 15 minutes without activity. Each use keeps the session alive. When it closes, the header shows **Open again**.
- **Close** ends the session immediately.

The dashboard always uses these defaults. The API accepts other values for the lifetime and idle timeout, but the studio does not expose them.

Permissions decide who can use the studio:

| Role | Can open the studio |
|---|---|
| Owner, admin, deployer | Yes. Deployers can also enable writes, because they hold `database:update`. |
| Viewer | No. Viewers have `database:read` but not `database:console`. |

The studio is for people signed in to the dashboard. An API key or an agent cannot use it, even with the right permissions, and agents do not receive the `database:console` permission by default. See [organisations and roles](/accounts/organizations-and-roles) for how roles are assigned.

## Browsing data

Pick an object in the tree on the left to open it in a tab. Tables and collections load their first page straight away. The tree filter (**⌘/Ctrl+K**) narrows long lists of objects.

- **Paging.** Results load 100 rows at a time. Use the next and previous controls to move through the pages. The studio uses the database's own cursor for each page, so paging stays fast on large tables.
- **Sorting.** Click a column header to sort by that column: the first click sorts ascending, the second descending, and the third clears the sort. Shift-click adds a column to the sort. You can sort by up to eight columns.
- **Filtering.** Open the filter builder to add conditions. Each condition takes a column, an operator and a value, and **Apply filter** reloads the page. The operators are `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `like`, `ilike`, `in`, `is null` and `is not null`. Filters go to the database, so only matching rows are sent to your browser. Key-value and MongoDB objects use their own filter forms instead of these operators.

Long text, JSON and binary values show a preview of up to 64 KiB. Select a truncated cell and open the inspector to load the full value. The studio marks any result that reached a limit (see [limits](#limits)).

## Editing rows

You can edit rows of a table that has a primary key, in a write session. Views, objects without a primary key and read-only sessions are shown without edit controls, with a notice explaining why.

1. Double-click a cell, or select it and press **Enter**, to edit it. Press **Enter** to keep the change in the pending tray. JSON cells use **⌘/Ctrl+Enter** because Enter adds a new line. **Set NULL** sets the selected cell to NULL.
2. Use **Add row** to insert a row. **Delete row** marks the selected row for removal, and **Restore row** undoes that. Nothing is written yet.
3. The pending-changes tray counts your changes. Choose **Review** to see each one, **Discard** to drop them, or **Apply** to write them.

Apply runs every change in one transaction. If any row changed in the database since you loaded it, the whole batch is rolled back, the conflicting rows are marked, and your changes stay in the tray so you can reload and try again. A single apply accepts up to 1,000 changes.

Structure changes, such as adding a column or an index, also need a write session. The studio shows them for review before they run. Which structure changes are offered depends on the engine.

## Running queries

The **Query** tab opens an editor for the database's own language: SQL for the relational engines, MongoDB commands for MongoDB, and Valkey or Redis commands for the key-value engines.

- **Run** executes the selected text, or the whole editor if nothing is selected. Use **⌘/Ctrl+Enter**. **Esc** stops a running query, and the database cancels it.
- Each run takes the **Max rows** you choose from the toolbar. The choices are 100 and 1,000, and the session cap applies on top of that.
- **Explain** shows the plan the database would use for the statement, as a tree. It is available for PostgreSQL, MySQL, MariaDB and MongoDB.
- Results appear in the grid below the editor. Use **Export** to download the loaded rows as CSV or JSON. The export contains only the rows already in the grid, so a truncated result exports truncated.
- Recent queries are kept in your browser, up to 200 per database. They are not sent to Skiff.

### Read-only queries

In a read-only session, the database refuses writes. For PostgreSQL, each statement runs in a read-only transaction, and a statement cannot switch it to read-write. For MySQL and MariaDB, the read-only account has `SELECT` and `SHOW VIEW` only. For MongoDB and Valkey or Redis, the studio blocks write commands, and the read-only account cannot run them either.

Only one statement can run at a time in a session. If you start another while one is running, the studio reports that another statement is still running. Stop the first one with **Esc**, or wait for it to finish.

## How the studio connects

Skiff never gives the studio your owner credentials for read-only work. The safety model has four parts:

- **A read-only account for every database.** Each managed database has a `skiff_studio_ro` account with read rights only. Read-only sessions connect as this account, so the database itself refuses writes. The account is created when you first open a read-only session, and the studio shows **Preparing read-only access…** until it is ready. If that fails, the header shows the error, and opening the studio again retries.
- **Write sessions use the owner.** A write session connects as the database's owner. It needs `database:update`, and stops working if that permission is removed.
- **No credential in the browser.** The browser talks to the control plane, which checks your session, validates each request and adds the database credential. The credential is never sent to the browser or written to logs.
- **Each session runs on the node that hosts the database.** The node starts a small studio process on demand, and stops it after five minutes with no open sessions.

The read-only account and the database's own limits mean that a read-only session cannot write even if a query tries.

## Limits

These limits are fixed. Each one protects the database and your browser from very large results or long-running statements.

| Limit | Value |
|---|---|
| Rows per result | 1,000 (the most you can choose in the toolbar) |
| Bytes per response | 16 MiB |
| Statement timeout | 30 seconds |
| Rows per browse page | 100 |
| Query text per run | 1 MiB |
| Changes per apply | 1,000 |
| Value preview per cell | 64 KiB |
| Session lifetime | 60 minutes |
| Idle timeout | 15 minutes |

When a result hits a row or byte limit, the grid says the result was cut at the session's size limit. When the statement timeout is reached, the query stops and the result says it ran past the time limit.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| **⌘/Ctrl+K** | Focus the object filter in the tree |
| **⌘/Ctrl+Alt+N** | Open a new query tab |
| **⌘/Ctrl+Enter** | Run the selection, or the whole query editor |
| **Esc** | Stop a running query, or cancel the cell being edited |
| **Enter** | Edit the selected cell, or save the cell being edited (JSON cells: **⌘/Ctrl+Enter**) |
| **Tab** / **Shift+Tab** | Save the cell being edited and move to the next or previous cell |
| Arrow keys, **Home**, **End**, **PageUp**, **PageDown** | Move the selected cell in the grid. With **⌘/Ctrl**, arrows and Home or End jump to the edge. |
| **Space** | Open the inspector for the selected cell |
| **⌘/Ctrl+C** | Copy the selected cell |

## Audit

Every studio action is recorded in the organisation's audit log, with the database, the user and the time. Skiff never records the text of a query or any cell value. A run is recorded as a fingerprint of its text and whether the session was read-only. An apply is recorded as counts of inserted, updated and deleted rows, and a structure change as the object and the kind of change.

If you need to know what a session did, look up the audit entries for the database. See [the security model](/accounts/security-model) for how audit fits with the rest of the platform.
