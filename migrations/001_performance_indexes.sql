-- SirverChats performance indexes (PocketBase SQLite)
--
-- Apply this file during a stopped-service maintenance window after backing up
-- pb_data, its WAL/SHM files, and uploaded storage. Every statement is
-- idempotent. PocketBase collection schema fields for thumbnail* must still be
-- added through the PocketBase migration/admin API; SQL indexes alone do not
-- update the collection schema.

CREATE INDEX IF NOT EXISTS idx_messages_channel_created_id
  ON messages (channel, created DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_private_messages_chat_server_created_id
  ON private_messages (chat_server, created DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_message
  ON attachments (message);
CREATE INDEX IF NOT EXISTS idx_private_attachments_message
  ON private_attachments (message);
CREATE INDEX IF NOT EXISTS idx_channels_server_position
  ON channels (server, position);
CREATE INDEX IF NOT EXISTS idx_server_members_user_server
  ON server_members (user, server);
CREATE INDEX IF NOT EXISTS idx_server_members_server_user
  ON server_members (server, user);
CREATE INDEX IF NOT EXISTS idx_private_chat_members_user_chat_server
  ON private_chat_members (user, chat_server);
CREATE INDEX IF NOT EXISTS idx_calls_started_by_updated
  ON calls (started_by, updated DESC);
CREATE INDEX IF NOT EXISTS idx_calls_channel_updated
  ON calls (channel, updated DESC);
