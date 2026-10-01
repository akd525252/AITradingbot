# Database-Synchronized Expiration Timestamps

When calculating future expiration timestamps (`expires_at` or `expiresAt` columns) in this project:

- NEVER assume the Node.js server clock (`Date.now()`) matches the database server clock.
- If there is a cloud database backend (e.g., Supabase), the database clock may be ahead of the local development machine's clock. This causes expiration times calculated locally to be in the past on the cloud, resulting in immediate trade resolution.
- Always retrieve the current database time via a query (`SELECT NOW()` on Postgres or `SELECT CURRENT_TIMESTAMP` on SQLite) and calculate expiration relative to that timestamp.
