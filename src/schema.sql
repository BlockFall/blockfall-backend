-- ============================================================
-- Blockfall Backend – PostgreSQL Schema
-- ============================================================

-- Users (no-update)
CREATE TABLE users (
    user_id      BIGINT      PRIMARY KEY,
    address      TEXT        NOT NULL UNIQUE  CHECK (address ~ '^0x[0-9a-f]{40}$'),
    user_source  TEXT        NOT NULL CHECK (user_source IN ('mobile-web', 'web', 'minipay')),
    wallet_info  TEXT        NOT NULL
);

-- A new record is inserted here on a user updated (no-update)
CREATE TABLE user_mutable_data (
    user_change_id  BIGINT    PRIMARY KEY,
    user_id         BIGINT    NOT NULL REFERENCES users(user_id),
    name            TEXT      NOT NULL CHECK (char_length(name) >= 3 AND char_length(name) <= 50),
    is_banned       BOOLEAN   NOT NULL DEFAULT FALSE
);

-- Per-user stats (high-churn row → HOT-update friendly)
CREATE TABLE user_numbers (
    user_id      BIGINT  PRIMARY KEY REFERENCES users(user_id),
    best_score   INT     NOT NULL DEFAULT 0 CHECK (best_score   >= 0),
    last_score   INT     NOT NULL DEFAULT 0 CHECK (last_score   >= 0),
    games_played INT     NOT NULL DEFAULT 0 CHECK (games_played >= 0),
    energy       INT     NOT NULL DEFAULT 0 CHECK (energy       >= 0),
    total_score  BIGINT  NOT NULL DEFAULT 0 CHECK (total_score  >= 0),
    updated_at   TIMESTAMPTZ
) WITH (fillfactor = 80);

-- Daily tournaments (no-update)
CREATE TABLE daily_tournaments (
    daily_tournament_id BIGINT PRIMARY KEY,
    tournament_date     DATE   NOT NULL UNIQUE
);

-- Daily tournament Results, added when processed (no-update) (one-to-one, enforced by PK/FK)
CREATE TABLE daily_tournament_results (
    daily_tournament_id BIGINT  PRIMARY KEY REFERENCES daily_tournaments(daily_tournament_id),
    processed_at        TIMESTAMPTZ NOT NULL,
    revenue             NUMERIC NOT NULL CHECK (revenue >= 0),
    used_for_payout     NUMERIC NOT NULL CHECK (used_for_payout >= 0)
);

-- Individual game sessions, added when game starts (no-update)
CREATE TABLE game_plays (
    game_play_id        BIGINT      PRIMARY KEY, -- has start_date in it
    user_id             BIGINT      NOT NULL REFERENCES users(user_id),
    daily_tournament_id BIGINT      NOT NULL REFERENCES daily_tournaments(daily_tournament_id),
    boost_multiplier    INT         NOT NULL -- normally 100 (divided by 100 in calculations. e.g. 150 for 1.5x boost)
);

-- Game plays results (no-update) (one-to-one with game_plays, enforced by PK/FK)
CREATE TABLE game_play_results (
    game_play_id        BIGINT      PRIMARY KEY REFERENCES game_plays(game_play_id),
    ended_at            TIMESTAMPTZ NOT NULL,
    score               INT         NOT NULL CHECK (score >= 0)
);

-- In-game events for analytics (no-update)
CREATE TABLE game_ingame_events (
    event_id           BIGINT      PRIMARY KEY,
    game_play_id       BIGINT      NOT NULL REFERENCES game_plays(game_play_id),
    event_time         TIMESTAMPTZ NOT NULL,
    event_type         TEXT        NOT NULL,
    intval             INT,
    textval            TEXT,
    extra_data         JSONB
);

-- Daily check-ins (one per user per date enforced)
CREATE TABLE daily_checkins (
    check_in_id   BIGINT      PRIMARY KEY,
    user_id       BIGINT      NOT NULL REFERENCES users(user_id),
    check_in_date DATE        NOT NULL,
    UNIQUE (user_id, check_in_date)
);

-- On-chain transactions (no-update) (revenue is present for buy transactions, otherwise 0)
CREATE TABLE user_transactions (
    transaction_id BIGINT      PRIMARY KEY,
    user_id        BIGINT      NOT NULL REFERENCES users(user_id),
    tx_hash        TEXT        NOT NULL UNIQUE, -- uint256 as hex string
    tx_time        TIMESTAMPTZ NOT NULL, -- from block timestamp
    revenue        NUMERIC     NOT NULL DEFAULT 0 CHECK (revenue >= 0),
    event_params   JSONB       NOT NULL
);

-- Energy issuance events (no-update)
CREATE TABLE energy_issuance (
    energy_issuance_id BIGINT      PRIMARY KEY,
    user_id            BIGINT      NOT NULL REFERENCES users(user_id),
    issuance_type      TEXT        NOT NULL CHECK (issuance_type IN ('signup', 'daily_check_in', 'buy_package', 'mystery_box')),
    amount             INT         NOT NULL CHECK (amount > 0),
    check_in_id        BIGINT      REFERENCES daily_checkins(check_in_id),
    transaction_id     BIGINT      REFERENCES user_transactions(transaction_id)
);

-- Inventory items (no-update)
CREATE TABLE user_items (
    item_id               BIGINT      PRIMARY KEY,
    user_id               BIGINT      NOT NULL REFERENCES users(user_id),
    item_type             INT         NOT NULL,
    acquisition_type      TEXT        NOT NULL CHECK (acquisition_type IN ('buy_package', 'mystery_box', 'daily_check_in')),
    buy_transaction_id    BIGINT      REFERENCES user_transactions(transaction_id),
    source_mystery_box_id BIGINT      REFERENCES user_items(item_id)
);

-- Item usage records (no-update) (one per item, only for used items)
CREATE TABLE user_item_usages (
    item_id        BIGINT       PRIMARY KEY REFERENCES user_items(item_id),
    usage_date     TIMESTAMPTZ  NOT NULL
);

-- User Boosts (no record if no active boost)
CREATE TABLE user_active_boost (
    user_id     BIGINT      PRIMARY KEY REFERENCES users(user_id),
    item_id     BIGINT      NOT NULL REFERENCES user_items(item_id),
    multiplier  INT         NOT NULL CHECK (multiplier > 1), -- used divided by 100 in calculations (e.g. 150 for 1.5x boost)
    started_at  TIMESTAMPTZ NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL
);

-- Reward payouts
CREATE TABLE user_payouts (
    payout_id            BIGINT      PRIMARY KEY,
    user_id              BIGINT      NOT NULL REFERENCES users(user_id),
    payout_type          TEXT        NOT NULL CHECK (payout_type IN ('daily_reward')),
    action_id            TEXT        NOT NULL UNIQUE,  -- unique uint256 as hex string
    amount               NUMERIC     NOT NULL,
    payment_token        SMALLINT    NOT NULL, -- 1=USDT, 2=USDC, 3=USDm
    signature            TEXT        NOT NULL,
    daily_tournament_id  BIGINT      REFERENCES daily_tournaments(daily_tournament_id), -- for daily rewards
    claim_transaction_id BIGINT      REFERENCES user_transactions(transaction_id),
    claim_date           TIMESTAMPTZ
);

-- Daily total scores
CREATE TABLE daily_total_scores (
  user_id        BIGINT   NOT NULL REFERENCES users(user_id),
  score_date     DATE     NOT NULL,
  total_score    INT      NOT NULL CHECK (total_score >= 0),
  rank           INT      NOT NULL CHECK (rank > 0),
  PRIMARY KEY (user_id, score_date)
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
