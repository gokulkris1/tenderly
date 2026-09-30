-- Reverses 028_system_organisation.sql.
--
-- Only removes the reserved row if nothing references it. An audit entry
-- written by a job is a record of a deletion that already happened, and
-- removing the organisation it hangs from would cascade that record away —
-- which is the very failure 028 exists to fix.

DELETE FROM organisations
 WHERE id = '00000000-0000-0000-0000-000000000000'
   AND NOT EXISTS (
     SELECT 1 FROM audit_log WHERE account_id = '00000000-0000-0000-0000-000000000000'
   );
