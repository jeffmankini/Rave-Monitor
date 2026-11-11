-- The color theme each account picked (a preset id from config/themes.json, or 'custom' for their own
-- colors, which stay in custom_theme), so it follows them to other devices. NULL: none saved yet.
ALTER TABLE users ADD COLUMN theme TEXT;
