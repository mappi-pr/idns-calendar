CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  payload JSON,
  source TEXT,
  created_at TEXT
);
