-- Fntv-Plus 匿名统计 / 反馈 表结构（Cloudflare D1）
-- 执行：npx wrangler d1 execute fntv-stats --remote --file=stats-server/schema.sql

-- 每日心跳：(匿名ID, 日期) 为主键 → 天然去重，一人一天只留一行
CREATE TABLE IF NOT EXISTS ping (
  aid  TEXT NOT NULL,   -- 客户端随机生成的匿名 ID（UUID），与账号/设备无关
  day  TEXT NOT NULL,   -- YYYY-MM-DD
  ver  TEXT,            -- 应用版本
  os   TEXT,            -- Windows / macOS / Linux
  arch TEXT,            -- x64 / arm64
  PRIMARY KEY (aid, day)
);
CREATE INDEX IF NOT EXISTS idx_ping_day ON ping(day);

-- Bug 反馈（日志正文不落 D1，放 R2，见 worker.js）
CREATE TABLE IF NOT EXISTS feedback (
  id      TEXT PRIMARY KEY,  -- UUID，同时是 R2 里 logs/<id>.log 的文件名
  ts      TEXT NOT NULL,     -- ISO 时间
  aid     TEXT,              -- 匿名 ID（可选）
  ver     TEXT,
  os      TEXT,
  arch    TEXT,
  contact TEXT,              -- 用户自愿填写的联系方式（可空）
  has_log INTEGER DEFAULT 0, -- 是否附带日志
  message TEXT               -- 问题描述
);
CREATE INDEX IF NOT EXISTS idx_fb_ts ON feedback(ts);
