-- ============================================================
-- Blockfall Backend – PostgreSQL Schema
-- ============================================================

-- Insert only design, no updates or deletes (except for user_numbers and user_active_boost)
-- All IDs are k-orderd 63 bit (42-bit ms timestamp | 21-bit random)

-- Users (no-update)
CREATE TABLE users (
    user_id      BIGINT      DEFAULT generate_id() PRIMARY KEY,
    address      TEXT        NOT NULL UNIQUE  CHECK (address ~ '^0x[0-9a-f]{40}$'),
    user_source  TEXT        NOT NULL CHECK (user_source IN ('mobile-web', 'web', 'minipay')),
    wallet_info  TEXT        NOT NULL
);

-- A new record is inserted here on a user updated (no-update)
CREATE TABLE user_mutable_data (
    user_change_id  BIGINT    DEFAULT generate_id() PRIMARY KEY,
    user_id         BIGINT    NOT NULL REFERENCES users(user_id),
    name            TEXT      NOT NULL CHECK (char_length(name) >= 3 AND char_length(name) <= 50),
    is_banned       BOOLEAN   NOT NULL DEFAULT FALSE
);

-- Daily tournaments (no-update)
CREATE TABLE daily_tournaments (
    daily_tournament_id BIGINT DEFAULT generate_id() PRIMARY KEY,
    tournament_date     DATE   NOT NULL UNIQUE
);

-- Daily tournament Results, added when processed (no-update) (one-to-one, enforced by unique FK)
CREATE TABLE daily_tournament_results (
    tournament_result_id BIGINT DEFAULT generate_id() PRIMARY KEY,
    daily_tournament_id  BIGINT NOT NULL UNIQUE REFERENCES daily_tournaments(daily_tournament_id),
    revenue              NUMERIC NOT NULL CHECK (revenue >= 0),
    inherited_revenue    NUMERIC NOT NULL CHECK (inherited_revenue >= 0), -- revenue inherited from previous day
    -- used_for_payout = (revenue + inherited_revenue) / 2 | if revenue is less than a certain threshold, this is set to 0 and the revenue is rolled over to the next day (inherited_revenue)
    used_for_payout      NUMERIC NOT NULL CHECK (used_for_payout >= 0),
    processed_at         TIMESTAMPTZ GENERATED ALWAYS AS (date_from_id(tournament_result_id)) STORED
);

-- Individual game sessions, added when game starts (no-update)
CREATE TABLE game_plays (
    game_play_id        BIGINT      DEFAULT generate_id() PRIMARY KEY, -- has start_date in it
    user_id             BIGINT      NOT NULL REFERENCES users(user_id),
    daily_tournament_id BIGINT      NOT NULL REFERENCES daily_tournaments(daily_tournament_id),
    boost_multiplier    INT         NOT NULL -- normally 100 (divided by 100 in calculations. e.g. 150 for 1.5x boost)
);

-- Game plays results (no-update) (one-to-one with game_plays, enforced by unique FK)
CREATE TABLE game_play_results (
    game_play_result_id BIGINT      DEFAULT generate_id() PRIMARY KEY,
    game_play_id        BIGINT      NOT NULL UNIQUE REFERENCES game_plays(game_play_id),
    score               INT         NOT NULL CHECK (score >= 0),
    ended_at            TIMESTAMPTZ GENERATED ALWAYS AS (date_from_id(game_play_result_id)) STORED
);

-- In-game events for analytics (no-update)
CREATE TABLE game_ingame_events (
    event_id           BIGINT      DEFAULT generate_id() PRIMARY KEY,
    game_play_id       BIGINT      NOT NULL REFERENCES game_plays(game_play_id),
    event_time         TIMESTAMPTZ NOT NULL,
    event_type         TEXT        NOT NULL,
    intval             INT,
    textval            TEXT,
    extra_data         JSONB
);

-- Daily check-ins (no-update) (one per user per date enforced)
CREATE TABLE daily_checkins (
    check_in_id   BIGINT      DEFAULT generate_id() PRIMARY KEY,
    user_id       BIGINT      NOT NULL REFERENCES users(user_id),
    check_in_date DATE        NOT NULL,
    UNIQUE (user_id, check_in_date)
);

-- On-chain transactions (no-update) (revenue is present for buy transactions, otherwise 0)
CREATE TABLE user_transactions (
    transaction_id BIGINT      DEFAULT generate_id() PRIMARY KEY,
    user_id        BIGINT      NOT NULL REFERENCES users(user_id),
    tx_hash        TEXT        NOT NULL UNIQUE, -- uint256 as hex string
    tx_time        TIMESTAMPTZ NOT NULL, -- from block timestamp
    revenue        NUMERIC     NOT NULL DEFAULT 0 CHECK (revenue >= 0),
    event_params   JSONB       NOT NULL
);

-- Energy issuance events (no-update)
CREATE TABLE energy_issuance (
    energy_issuance_id BIGINT      DEFAULT generate_id() PRIMARY KEY,
    user_id            BIGINT      NOT NULL REFERENCES users(user_id),
    issuance_type      TEXT        NOT NULL CHECK (issuance_type IN ('signup', 'daily_check_in', 'buy_package', 'mystery_box')),
    amount             INT         NOT NULL CHECK (amount > 0),
    check_in_id        BIGINT      REFERENCES daily_checkins(check_in_id),
    transaction_id     BIGINT      REFERENCES user_transactions(transaction_id)
);

-- Inventory items (no-update)
CREATE TABLE user_items (
    item_id               BIGINT      DEFAULT generate_id() PRIMARY KEY,
    user_id               BIGINT      NOT NULL REFERENCES users(user_id),
    item_type             INT         NOT NULL,
    acquisition_type      TEXT        NOT NULL CHECK (acquisition_type IN ('buy_package', 'mystery_box', 'daily_check_in')),
    buy_transaction_id    BIGINT      REFERENCES user_transactions(transaction_id),
    source_mystery_box_id BIGINT      REFERENCES user_items(item_id)
);

-- Item usage records (no-update) (one per item, only for used items)
CREATE TABLE user_item_usages (
    item_usage_id  BIGINT       DEFAULT generate_id() PRIMARY KEY,
    item_id        BIGINT       NOT NULL UNIQUE REFERENCES user_items(item_id),
    usage_date     TIMESTAMPTZ GENERATED ALWAYS AS (date_from_id(item_usage_id)) STORED
);

-- Reward payouts (no-update)
CREATE TABLE user_payouts (
    payout_id            BIGINT      DEFAULT generate_id() PRIMARY KEY,
    user_id              BIGINT      NOT NULL REFERENCES users(user_id),
    payout_type          TEXT        NOT NULL CHECK (payout_type IN ('daily_reward')),
    action_id            TEXT        NOT NULL UNIQUE,  -- unique uint256 as hex string
    amount               NUMERIC     NOT NULL,
    payment_token        SMALLINT    NOT NULL, -- 1=USDT, 2=USDC, 3=USDm
    signature            TEXT        NOT NULL,
    daily_tournament_id  BIGINT      REFERENCES daily_tournaments(daily_tournament_id) -- for daily rewards
);

-- User claims (no-update) (one-to-one with payouts, enforced by unique FK)
CREATE TABLE user_claims (
    claim_id             BIGINT   DEFAULT generate_id() PRIMARY KEY,
    payout_id            BIGINT   NOT NULL UNIQUE REFERENCES user_payouts(payout_id),
    claim_transaction_id BIGINT   NOT NULL REFERENCES user_transactions(transaction_id)
);

-- Daily total scores (no-update)
CREATE TABLE daily_total_scores (
  daily_score_id BIGINT   DEFAULT generate_id() PRIMARY KEY,
  user_id        BIGINT   NOT NULL REFERENCES users(user_id),
  score_date     DATE     NOT NULL,
  total_score    INT      NOT NULL CHECK (total_score >= 0),
  rank           INT      NOT NULL CHECK (rank > 0),
  UNIQUE (user_id, score_date)
);

-- Per-user stats (updateable) (recreateable summary) (high-churn row → HOT-update friendly)
CREATE TABLE user_numbers (
    user_id           BIGINT  PRIMARY KEY REFERENCES users(user_id),
    best_score        INT     NOT NULL DEFAULT 0 CHECK (best_score   >= 0),
    last_score        INT     NOT NULL DEFAULT 0 CHECK (last_score   >= 0),
    games_played      INT     NOT NULL DEFAULT 0 CHECK (games_played >= 0),
    energy            INT     NOT NULL DEFAULT 0 CHECK (energy       >= 0),
    total_score       BIGINT  NOT NULL DEFAULT 0 CHECK (total_score  >= 0),
    today_score       INT     NOT NULL DEFAULT 0 CHECK (today_score  >= 0), --today_score is meaningful when today_score_date matches the current date
    today_score_date  DATE,
    updated_at        TIMESTAMPTZ
) WITH (fillfactor = 80);

-- User Boost information (updateable) (recreateable summary) (no record if no active boost)
CREATE TABLE user_active_boost (
    user_id     BIGINT      PRIMARY KEY REFERENCES users(user_id),
    item_id     BIGINT      NOT NULL REFERENCES user_items(item_id),
    multiplier  INT         NOT NULL CHECK (multiplier > 1), -- used divided by 100 in calculations (e.g. 150 for 1.5x boost)
    started_at  TIMESTAMPTZ NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL
);

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX ON game_plays (user_id, daily_tournament_id);
CREATE INDEX ON energy_issuance (user_id);
CREATE INDEX ON user_items (user_id);
CREATE INDEX ON user_payouts (user_id);
-- For user_mutable_data, we will often query the latest record for a user, so we index by user_id and user_change_id desc to optimize that query
CREATE INDEX idx_user_mutable_data_latest ON user_mutable_data (user_id, user_change_id DESC);


-- ============================================================
-- Functions
-- ============================================================

-- ID generation function (k-ordered, 63-bit, with 42-bit ms timestamp and 21-bit random)
CREATE OR REPLACE FUNCTION generate_id() RETURNS bigint AS $$
DECLARE
  ts bigint;
  rand bigint;
BEGIN
  ts := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint & x'3ffffffffff'::bigint;
  rand := floor(random() * 2097152)::bigint; -- 2^21
  RETURN (ts << 21) | rand;
END;
$$ LANGUAGE plpgsql;

-- Function to extract timestamp from ID
CREATE OR REPLACE FUNCTION date_from_id(id bigint) RETURNS timestamptz AS $$
BEGIN
  RETURN to_timestamp((id >> 21) / 1000.0);
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE;

-- Function to generate ID from a given timestamp (for backfilling old records with correct ID ordering)
CREATE OR REPLACE FUNCTION generate_id_at(ts timestamptz) RETURNS bigint AS $$
DECLARE
  ms bigint;
  rand bigint;
BEGIN
  ms := (EXTRACT(EPOCH FROM ts) * 1000)::bigint & x'3ffffffffff'::bigint;
  rand := floor(random() * 2097152)::bigint;
  RETURN (ms << 21) | rand;
END;
$$ LANGUAGE plpgsql STRICT;

-- Deterministic version of generate_id_at this is used for range queries.
-- WHERE id >= generate_id_at('2025-01-01'::timestamptz)          -- rand = 0
--   AND id <  generate_id_at('2025-02-01'::timestamptz, true);   -- rand = max (2097151)
CREATE OR REPLACE FUNCTION generate_id_at_det(ts timestamptz, max_val boolean DEFAULT false) RETURNS bigint AS $$
DECLARE
  ms bigint;
  rand bigint;
BEGIN
  ms := (EXTRACT(EPOCH FROM ts) * 1000)::bigint & x'3ffffffffff'::bigint;
  rand := CASE WHEN max_val THEN 2097151 ELSE 0 END;
  RETURN (ms << 21) | rand;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE;


-- ============================================================
-- Views
-- ============================================================

-- Users joined with their latest mutable data + derived created_at.
-- Use this anywhere a read needs name / is_banned / created_at instead of
-- repeating the JOIN LATERAL against user_mutable_data.
CREATE VIEW users_with_data AS
SELECT u.user_id,
       u.address,
       u.user_source,
       u.wallet_info,
       umd.name,
       umd.is_banned,
       date_from_id(u.user_id) AS created_at
FROM   users u
JOIN LATERAL (
    SELECT name, is_banned
    FROM   user_mutable_data
    WHERE  user_id = u.user_id
    ORDER BY user_change_id DESC
    LIMIT 1
) umd ON true;
