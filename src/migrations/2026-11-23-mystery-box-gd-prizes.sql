-- ============================================================
-- Migration: G$ mystery box prizes (item types 301-303)
-- Opening a box that yields a G$ prize creates a signed 'mystery_box'
-- user_payouts row linked to the opened box.
-- ============================================================

BEGIN;

ALTER TABLE user_payouts DROP CONSTRAINT IF EXISTS user_payouts_payout_type_check;
ALTER TABLE user_payouts
  ADD CONSTRAINT user_payouts_payout_type_check
  CHECK (payout_type IN ('daily_reward', 'conversion', 'mystery_box'));

ALTER TABLE user_payouts
  ADD COLUMN source_mystery_box_id BIGINT UNIQUE REFERENCES user_items(item_id);

COMMIT;
