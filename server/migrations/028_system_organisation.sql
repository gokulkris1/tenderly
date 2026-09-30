-- TLY-246: a reserved organisation for job-level audit entries.
--
-- The retention and deletion jobs write their audit entry under the account id
-- 00000000-0000-0000-0000-000000000000, because a bulk job acts for the system
-- rather than for any one customer. Migration 025 repointed audit_log.account_id
-- at organisations(id), and no such organisation was ever created — so every
-- one of those inserts raised a foreign-key violation, which both jobs caught
-- and downgraded to a log line.
--
-- The effect was that a job could delete customer data and leave no audit
-- record that it had, while reporting success. The audit log is kept longest of
-- anything precisely so the record of a deletion outlives the data; a deletion
-- with no record is the one outcome it exists to prevent.
--
-- A fixed, reserved uuid rather than a generated one, so a job can reference it
-- without a lookup and every environment agrees on which row it is.

INSERT INTO organisations (id, name)
VALUES ('00000000-0000-0000-0000-000000000000', 'Tenderly system')
ON CONFLICT (id) DO NOTHING;
