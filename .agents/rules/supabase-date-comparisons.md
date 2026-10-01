# Supabase / PostgreSQL Date Comparisons

When filtering rows by date range using `created_at >= ?` in this project:

- Always use `new Date().toISOString()` to generate the comparison string.
- NEVER use manual `YYYY-MM-DD HH:mm:ss` string formatting.
- Reason: Supabase/PostgreSQL stores timestamps in ISO 8601 format. Using a space-separated format (without 'T' and 'Z') causes silent failures where all comparisons return 0 rows.
- This applies to all three database modes: direct PostgreSQL pool, Supabase API Client RPC, and local SQLite fallback.
