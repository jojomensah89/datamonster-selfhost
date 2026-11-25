-- The last copy of the public list of launch directories that list_directories reads (src/agent/directories.ts). One row.
CREATE TABLE directory_list (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at INTEGER NOT NULL,
  list TEXT NOT NULL
);
