-- Inverse of 000038: drop event_content.system_blocks, its check first.
ALTER TABLE event_content DROP CONSTRAINT IF EXISTS event_content_system_blocks_check;
ALTER TABLE event_content DROP COLUMN IF EXISTS system_blocks;
