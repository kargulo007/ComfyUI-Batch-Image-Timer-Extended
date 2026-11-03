# Security and privacy

This is a ComfyUI backend extension that records render statistics and may store workflow snapshots. Treat the database and exported ZIP files as potentially sensitive.

- Do not expose unauthenticated ComfyUI API endpoints to untrusted networks.
- `IMPORT DATA` and database restore affect the running server's SQLite data.
- Keep `data/`, backup exports and real image outputs out of public Git repositories.
- Review output logs and workflow JSON before posting them publicly.
- Report security issues privately through GitHub's private vulnerability reporting feature if enabled, rather than publishing working exploits in an issue.

No security audit of every deployment configuration is claimed.
