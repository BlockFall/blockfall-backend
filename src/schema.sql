-- ============================================================
-- Blockfall Backend – PostgreSQL Schema
-- ============================================================

-- Users
CREATE TABLE users (
    user_id    BIGINT      PRIMARY KEY,
    address    TEXT        NOT NULL UNIQUE  CHECK (address ~ '^0x[0-9a-f]{40}$'),
    name       TEXT        NOT NULL UNIQUE  CHECK (char_length(name) >= 3 AND char_length(name) <= 50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ                          -- updated only on name change
);

-- Per-user stats (high-churn row → HOT-update friendly)
CREATE TABLE user_numbers (
    user_id     BIGINT  PRIMARY KEY REFERENCES users(user_id),
    best_score  INT     NOT NULL DEFAULT 0 CHECK (best_score  >= 0),
    last_score  INT     NOT NULL DEFAULT 0 CHECK (last_score  >= 0),
    total_score BIGINT  NOT NULL DEFAULT 0 CHECK (total_score >= 0),
    energy      INT     NOT NULL DEFAULT 0 CHECK (energy      >= 0),
    updated_at  TIMESTAMPTZ
) WITH (fillfactor = 80);

-- Daily tournaments
CREATE TABLE daily_tournaments (
    daily_tournament_id BIGINT PRIMARY KEY,
    tournament_date     DATE   NOT NULL UNIQUE
);

-- Individual game sessions
CREATE TABLE game_plays (
    game_play_id BIGINT      PRIMARY KEY,
    user_id      BIGINT      NOT NULL REFERENCES users(user_id),
    started_at   TIMESTAMPTZ NOT NULL,
    ended_at     TIMESTAMPTZ,
    score        INT,
    day_id       BIGINT      NOT NULL REFERENCES daily_tournaments(daily_tournament_id)
);

-- Daily check-ins (one per user per date enforced)
CREATE TABLE daily_checkins (
    check_in_id   BIGINT      PRIMARY KEY,
    user_id       BIGINT      NOT NULL REFERENCES users(user_id),
    check_in_date DATE        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, check_in_date)
);

-- On-chain transactions
CREATE TABLE user_transactions (
    transaction_id BIGINT PRIMARY KEY,
    user_id        BIGINT NOT NULL REFERENCES users(user_id),
    tx_hash        TEXT   NOT NULL UNIQUE,
    event_params   JSONB  NOT NULL
);

-- Energy issuance events
CREATE TABLE energy_issuance (
    energy_issuance_id BIGINT      PRIMARY KEY,
    user_id            BIGINT      NOT NULL REFERENCES users(user_id),
    issuance_type      TEXT        NOT NULL CHECK (issuance_type IN ('signup', 'daily_check_in', 'buy_package', 'mystery_box')),
    amount             INT         NOT NULL CHECK (amount > 0),
    check_in_id        BIGINT      REFERENCES daily_checkins(check_in_id),
    transaction_id     BIGINT      REFERENCES user_transactions(transaction_id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Inventory items
CREATE TABLE user_items (
    item_id               BIGINT      PRIMARY KEY,
    user_id               BIGINT      NOT NULL REFERENCES users(user_id),
    item_type             INT         NOT NULL,
    acquisition_type      TEXT        NOT NULL CHECK (acquisition_type IN ('buy_package', 'mystery_box')),
    buy_date              TIMESTAMPTZ,
    usage_date            TIMESTAMPTZ,
    source_mystery_box_id BIGINT      REFERENCES user_items(item_id)
);

-- Reward payouts
CREATE TABLE user_payouts (
    payout_id            BIGINT      PRIMARY KEY,
    user_id              BIGINT      NOT NULL REFERENCES users(user_id),
    payout_type          TEXT        NOT NULL CHECK (payout_type IN ('daily_reward')),
    action_id            TEXT        NOT NULL UNIQUE,  -- unique uint256 as hex string
    amount               NUMERIC     NOT NULL,
    payment_token        SMALLINT    NOT NULL,
    signature            TEXT        NOT NULL,
    claim_transaction_id BIGINT      REFERENCES user_transactions(transaction_id),
    claim_date           TIMESTAMPTZ
);

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX ON game_plays (user_id, day_id);
CREATE INDEX ON energy_issuance (user_id);
CREATE INDEX ON user_items (user_id);
CREATE INDEX ON user_payouts (user_id);

-- ============================================================
-- Materialized view: scores for the most recent tournament day
-- ============================================================

CREATE MATERIALIZED VIEW last_day_total_scores AS
SELECT
    gp.user_id,
    SUM(gp.score) AS total_score
FROM game_plays gp
WHERE gp.day_id = (
        SELECT daily_tournament_id
        FROM   daily_tournaments
        ORDER  BY tournament_date DESC
        LIMIT  1
    )
  AND gp.score IS NOT NULL
GROUP BY gp.user_id
ORDER BY total_score DESC;
