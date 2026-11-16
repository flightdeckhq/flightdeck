-- Inverse of 000038: drop event_content.system_blocks, and its checks
-- with it (they are the column's own).
ALTER TABLE event_content DROP COLUMN system_blocks;
