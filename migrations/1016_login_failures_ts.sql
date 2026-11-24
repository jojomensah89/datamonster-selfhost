-- Old login attempts are cleared by time.
CREATE INDEX login_failures_ts ON login_failures (ts);
