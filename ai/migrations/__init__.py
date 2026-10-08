"""
ai/migrations — ai_memory.db şema sürümleri.

Her migration bir kez uygulanır ve ai_schema_migrations tablosuna yazılır.
İfadeler IF NOT EXISTS kullandığı için yarıda kalmış bir migration'ın
tekrar çalıştırılması da güvenlidir. Yeni şema değişikliği = listeye yeni
(sürüm, ad, sql) eklemek; mevcut girdiler asla değiştirilmez.
"""

from __future__ import annotations

MIGRATIONS: list[tuple[int, str, str]] = [
    (
        1,
        "initial",
        """
        CREATE TABLE IF NOT EXISTS ai_messages (
            message_id   INTEGER PRIMARY KEY,
            guild_id     INTEGER NOT NULL,
            channel_id   INTEGER NOT NULL,
            user_id      INTEGER NOT NULL,
            author_name  TEXT,
            content      TEXT    NOT NULL,
            norm_content TEXT    NOT NULL,
            reply_to_id  INTEGER,
            created_at   REAL    NOT NULL,
            edited_at    REAL,
            deleted_at   REAL
        );

        CREATE INDEX IF NOT EXISTS idx_ai_messages_channel_time
            ON ai_messages (guild_id, channel_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_ai_messages_user
            ON ai_messages (guild_id, user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_ai_messages_created
            ON ai_messages (created_at);

        -- Harici içerikli FTS5: metnin kopyası tutulmaz, ai_messages.norm_content indekslenir.
        CREATE VIRTUAL TABLE IF NOT EXISTS ai_messages_fts USING fts5(
            norm_content,
            content='ai_messages',
            content_rowid='message_id',
            tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER IF NOT EXISTS ai_messages_ai AFTER INSERT ON ai_messages BEGIN
            INSERT INTO ai_messages_fts(rowid, norm_content) VALUES (new.message_id, new.norm_content);
        END;
        CREATE TRIGGER IF NOT EXISTS ai_messages_ad AFTER DELETE ON ai_messages BEGIN
            INSERT INTO ai_messages_fts(ai_messages_fts, rowid, norm_content)
            VALUES ('delete', old.message_id, old.norm_content);
        END;
        CREATE TRIGGER IF NOT EXISTS ai_messages_au AFTER UPDATE OF norm_content ON ai_messages BEGIN
            INSERT INTO ai_messages_fts(ai_messages_fts, rowid, norm_content)
            VALUES ('delete', old.message_id, old.norm_content);
            INSERT INTO ai_messages_fts(rowid, norm_content) VALUES (new.message_id, new.norm_content);
        END;

        CREATE TABLE IF NOT EXISTS ai_memories (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id     INTEGER NOT NULL,
            user_id      INTEGER,
            channel_id   INTEGER,
            scope        TEXT    NOT NULL CHECK (scope IN ('user', 'episodic')),
            memory_type  TEXT    NOT NULL,
            content      TEXT    NOT NULL,
            norm_content TEXT    NOT NULL,
            source       TEXT    NOT NULL,
            confidence   REAL    NOT NULL DEFAULT 1.0,
            status       TEXT    NOT NULL CHECK (status IN ('candidate', 'confirmed', 'revoked')),
            created_by   INTEGER,
            created_at   REAL    NOT NULL,
            updated_at   REAL    NOT NULL,
            expires_at   REAL
        );

        CREATE INDEX IF NOT EXISTS idx_ai_memories_user
            ON ai_memories (guild_id, user_id, status);
        CREATE INDEX IF NOT EXISTS idx_ai_memories_scope
            ON ai_memories (guild_id, scope, status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_ai_memories_expires
            ON ai_memories (expires_at);

        CREATE TABLE IF NOT EXISTS ai_memory_sources (
            memory_id  INTEGER NOT NULL REFERENCES ai_memories(id) ON DELETE CASCADE,
            message_id INTEGER NOT NULL,
            channel_id INTEGER,
            PRIMARY KEY (memory_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_ai_memory_sources_msg
            ON ai_memory_sources (message_id);

        CREATE TABLE IF NOT EXISTS ai_memory_participants (
            memory_id INTEGER NOT NULL REFERENCES ai_memories(id) ON DELETE CASCADE,
            user_id   INTEGER NOT NULL,
            PRIMARY KEY (memory_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_ai_memory_participants_user
            ON ai_memory_participants (user_id);

        -- channel_id = 0 → sunucu geneli ayar
        CREATE TABLE IF NOT EXISTS ai_settings (
            guild_id   INTEGER NOT NULL,
            channel_id INTEGER NOT NULL DEFAULT 0,
            key        TEXT    NOT NULL,
            value      TEXT    NOT NULL,
            updated_by INTEGER,
            updated_at REAL    NOT NULL,
            PRIMARY KEY (guild_id, channel_id, key)
        );

        CREATE TABLE IF NOT EXISTS ai_user_privacy (
            guild_id   INTEGER NOT NULL,
            user_id    INTEGER NOT NULL,
            opted_out  INTEGER NOT NULL DEFAULT 1,
            updated_at REAL    NOT NULL,
            PRIMARY KEY (guild_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS ai_usage (
            id                        INTEGER PRIMARY KEY AUTOINCREMENT,
            ts                        REAL    NOT NULL,
            day                       TEXT    NOT NULL,
            guild_id                  INTEGER,
            user_id                   INTEGER,
            provider                  TEXT    NOT NULL,
            model                     TEXT,
            request_count             INTEGER NOT NULL DEFAULT 1,
            approximate_input_tokens  INTEGER,
            approximate_output_tokens INTEGER,
            error_code                TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ai_usage_day ON ai_usage (day, guild_id, user_id);
        CREATE INDEX IF NOT EXISTS idx_ai_usage_ts ON ai_usage (ts);
        """,
    ),
]
