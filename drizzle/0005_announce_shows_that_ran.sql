-- Every show that has already run was public, so mark it announced.
--
-- The 0004 rename carried is_current across to is_announced, but the two mean
-- different things: is_current = 0 meant "not the one featured on the home
-- page", not "never published". Three productions that genuinely ran are
-- sitting at is_announced = 0 for that reason alone.
--
-- Without this, tightening "past" to require an announcement would erase them
-- from the public archive.
UPDATE shows
SET is_announced = 1, updated_at = datetime('now')
WHERE is_announced = 0
  AND EXISTS (
    SELECT 1 FROM show_performances p
    WHERE p.show_id = shows.id AND p.date < date('now')
  );
