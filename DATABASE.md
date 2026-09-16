# Sirver Database Structure & PocketBase Collections

## Collections Overview

1. **`users`**:
   - Fields: `id`, `username`, `email`, `display_name`, `avatar`, `status`, `role`, `bio`, `theme_color`, `accent_font`, `avatar_decoration`, `banner`

2. **`servers`** (Spaces):
   - Fields: `id`, `name`, `description`, `icon`, `banner`, `owner`, `members`, `is_private`

3. **`channels`**:
   - Fields: `id`, `server`, `name`, `topic`, `type` (`text`, `voice`, `announcement`), `position`

4. **`messages`**:
   - Fields: `id`, `channel`, `user`, `content`, `attachments`, `reply_to`, `reactions`, `pinned`, `created`

5. **`direct_messages`**:
   - Fields: `id`, `sender`, `recipient`, `content`, `attachments`, `created`

## Performance migration

`migrations/001_performance_indexes.sql` contains the idempotent SQLite indexes
used by cursor-based server/DM history and membership lookups. Apply it only
after a consistent stopped-service backup of `pb_data` (including WAL/SHM and
uploaded storage). `migrations/1789493805_attachment_thumbnails.js` is the
PocketBase schema migration for the optional feed thumbnail fields on both
attachment collections. It preserves every original file and only adds a
separate thumbnail plus its dimensions, MIME type, and byte size.
