-- SMS Gateway D1 schema
-- 设备表：device(设备名) + sim(卡槽) 唯一，alias 为用户自定义别名
CREATE TABLE IF NOT EXISTS devices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device     TEXT    NOT NULL DEFAULT 'unknown',
  sim        TEXT    NOT NULL DEFAULT '',
  alias      TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_key ON devices(device, sim);

-- 短信表：30 天保留，超期由 cron 清理
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   INTEGER NOT NULL REFERENCES devices(id),
  sender      TEXT    NOT NULL DEFAULT '',
  content     TEXT    NOT NULL DEFAULT '',
  received_at TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_device_time ON messages(device_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(received_at);
-- 去重：同设备+发件人+内容+秒级时间 不重复入库
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup
  ON messages(device_id, sender, content, received_at);
