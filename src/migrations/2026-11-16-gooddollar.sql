-- ============================================================
-- Migration: GoodDollar (G$) payments and generic deposits (stablecoin → G$ conversions)
-- Run once against an existing database created from an older schema.sql.
-- ============================================================

BEGIN;

ALTER TABLE user_payouts DROP CONSTRAINT IF EXISTS user_payouts_payout_type_check;
ALTER TABLE user_payouts
  ADD CONSTRAINT user_payouts_payout_type_check
  CHECK (payout_type IN ('daily_reward', 'conversion'));

COMMENT ON COLUMN user_payouts.payment_token IS '1=USDT, 2=USDC, 3=USDm, 4=G$';

CREATE TABLE user_deposits (
    deposit_id            BIGINT      DEFAULT generate_id() PRIMARY KEY,
    user_id               BIGINT      NOT NULL REFERENCES users(user_id),
    deposit_type          TEXT        NOT NULL CHECK (deposit_type IN ('usdt_to_gd', 'usdc_to_gd', 'usdm_to_gd', 'gd_to_usdt', 'gd_to_usdc', 'gd_to_usdm')),
    action_id             TEXT        NOT NULL UNIQUE,
    payment_token         SMALLINT    NOT NULL,
    amount                NUMERIC     NOT NULL CHECK (amount > 0),
    quoted_payout_amount  NUMERIC     CHECK (quoted_payout_amount > 0),
    signature             TEXT        NOT NULL,
    expires_at            TIMESTAMPTZ NOT NULL
);

CREATE TABLE user_deposit_confirmations (
    confirmation_id        BIGINT DEFAULT generate_id() PRIMARY KEY,
    deposit_id             BIGINT NOT NULL UNIQUE REFERENCES user_deposits(deposit_id),
    deposit_transaction_id BIGINT NOT NULL REFERENCES user_transactions(transaction_id),
    payout_id              BIGINT UNIQUE REFERENCES user_payouts(payout_id)
);

CREATE INDEX ON user_deposits (user_id);

COMMIT;
