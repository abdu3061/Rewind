-- Operational secret only: never history, FTS, cloud approval or a renderer payload.
CREATE TABLE assistant_credential (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0 AND revision < 9007199254740991),
    api_key TEXT CHECK (api_key IS NULL OR length(CAST(api_key AS BLOB)) BETWEEN 16 AND 512),
    updated_at TEXT CHECK (updated_at IS NULL OR length(updated_at) = 24),
    CHECK (
        (revision = 0 AND api_key IS NULL AND updated_at IS NULL) OR
        (revision > 0 AND updated_at IS NOT NULL)
    )
) STRICT;
INSERT INTO assistant_credential(id, revision, api_key, updated_at) VALUES (1, 0, NULL, NULL);
