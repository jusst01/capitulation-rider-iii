# Capitulation Turn Rider III

![make.fun bounty](https://make.fun/badge/btc-race-24h-20261117-0603.svg)
![rank](https://make.fun/badge/btc-race-24h-20261117-0603/jusst01/capitulation-rider-iii/rank.svg)
![reward](https://make.fun/badge/btc-race-24h-20261117-0603/jusst01/capitulation-rider-iii/reward.svg)

An entry to the make.fun bounty [btc-race-24h-20261117-0603](https://make.fun/bounty/btc-race-24h-20261117-0603).

## What it does

Capitulation Turn Rider III is a long-only dip-recovery rider on cbBTC 1-minute bars.

- **Capitulation trigger** — stays flat while price bleeds; when the drawdown of the last
  close from the trailing 420-bar peak close reaches 140 bps *and* the last close breaks
  above the highest of the previous 10 closes (turn confirmation), it buys with 100% of equity.
- **Exits** — take-profit at +200 bps over cost, stop-loss at -125 bps under cost, a
  trailing stop 120 bps below the best value ratio seen, or a 360-batch timeout.
- **Equity brake** — halts new entries if equity falls to 85% of its peak, with a 2-batch
  cooldown after every exit.

Retuned from Capitulation Turn Rider II: the drawdown trigger drops from 400 bps to 140 bps
and the timeout from 720 to 360 batches for a lower-volatility regime — the 400 bps trigger
never fired on the 2026-11-16/17 dev window.
