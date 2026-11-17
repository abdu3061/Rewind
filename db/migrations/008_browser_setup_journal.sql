-- Private installation ownership, not recorded browsing evidence or consent.
CREATE TABLE browser_setup_journal (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0 AND revision < 9007199254740991),
    payload TEXT NOT NULL CHECK (
        json_valid(payload) AND
        length(CAST(payload AS BLOB)) <= 262144 AND
        json_extract(payload, '$.version') = 1 AND
        json_extract(payload, '$.revision') = revision
    )
);
INSERT INTO browser_setup_journal(id, revision, payload) VALUES (
    1, 0,
    '{"version":1,"revision":0,"generations":[],"registrations":{"chrome":null,"edge":null},"pending":null}'
);
