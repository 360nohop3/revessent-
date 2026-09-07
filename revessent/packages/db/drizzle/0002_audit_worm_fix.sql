-- 0001 granted DML to all tables AFTER revoking audit_logs mutations — order
-- bug. This migration re-establishes the append-only guarantee (final word).
revoke update, delete on audit_logs from revessent_app;
alter default privileges in schema public revoke update, delete on tables from revessent_app;
