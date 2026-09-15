# MU Intraday Historical Behavior Research v1

Purpose: build a **MU-specific** intraday research dataset before changing the production decision engine.

## What this study tests

For each MU session it reconstructs:

- Premarket state (04:00-09:29 ET): last price, high/low, volume.
- Open +5m, +15m, +30m: gap hold, opening-range high/low, cumulative VWAP, RVOL.
- MU relative strength versus SOXX, NVDA and QQQ.
- Forward 5/15/30/60 minute return from each checkpoint, plus MFE/MAE.
- End-of-day labels: Big Up, Big Down, Reversal Long, Failed Breakout.

The initial setup rules are **hypotheses, not trading recommendations**. They are intentionally separated from `src/decisionV6` until out-of-sample results are convincing.

## Data source

Massive Stocks Custom Bars endpoint, 1-minute adjusted aggregates. Massive's aggregate bars include extended-hours data, but some extended-hours trades are ineligible for aggregate construction, so premarket bars can be sparse. The analysis therefore never assumes that every minute exists.

Required environment variable:

```text
MASSIVE_API_KEY
```

## Run locally

```bash
node research/mu-intraday/download.mjs --start 2025-09-01 --end 2026-09-15
node research/mu-intraday/analyze.mjs
```

Optional ticker override:

```bash
--tickers MU,SOXX,NVDA,QQQ
```

## GitHub Actions

Run **MU intraday historical research** from Actions. The workflow requires repository secret `MASSIVE_API_KEY`.

Default window is 2025-09-01 through 2026-09-15. Massive Basic currently advertises two years of historical coverage, so this window fits the free-history horizon; plan recency may still be end-of-day.

## Output

`research-output/mu-intraday/results/summary.json`

- sample period and chronological 70/30 split date
- label-group averages
- setup results for all/train/test
- win rate, average and median forward return, quartiles, profit factor, MFE and MAE

`mu_daily_features.csv`

One row per MU trading day, including the complete premarket / +5m / +15m / +30m feature set.

`setup_events.csv`

One row per setup occurrence for manual inspection of the exact historical dates.

## Initial hypotheses

1. `gap_go_long_15`
   - Gap >= +1%
   - 5m gap hold >= 70%
   - 15m close above cumulative VWAP
   - MU 15m relative strength > peer basket
   - 15m RVOL >= 1.2

2. `failed_breakout_short_15`
   - Gap >= +1%
   - 5m gap hold < 70%
   - 15m close below cumulative VWAP
   - MU 15m relative strength < peer basket

3. `reversal_long_30`
   - Gap <= -1%
   - 30m close > open
   - 30m close > cumulative VWAP
   - MU relative strength improves from +5m to +30m

4. `trend_breakdown_short_15`
   - Gap <= -1%
   - 15m close < open and VWAP
   - MU 15m relative strength < peer basket

These thresholds are starting points. Do not optimize them on the full sample and then quote the same-sample result as evidence. v1 reports a chronological 70/30 train/test split to expose overfitting early.
