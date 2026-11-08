# Neon connection setup

The Neon Console is available at <https://console.neon.tech/app/projects>.
Create or select a project there; project and region choices must be made by
the account owner. Consider latency for Antananarivo and the unresolved
cross-border data/privacy review before choosing a region.

For an application connection, Neon’s official
[Connect from any application guide](https://neon.com/docs/connect/connect-from-any-app)
instructs users to select **Connect** in the Console, then choose a branch,
compute, database, and role. The Console constructs the connection string.
Pooled connection details are shown by default; the string is intended to be
stored as `DATABASE_URL` and passed to a PostgreSQL driver such as Node.js `pg`.
The guide says Neon requires TLS and its example includes `sslmode=require`.

The DriveNight setup wizard stores the full Neon connection string only in
the local, Git-ignored `.env` file. It masks input, does not print the value,
and does not connect or apply migrations unless the user confirms that step.
It does not seed demo accounts in Neon.

## Sources

- [Neon — Connect from any application](https://neon.com/docs/connect/connect-from-any-app)
- [Neon Console — Projects](https://console.neon.tech/app/projects)
