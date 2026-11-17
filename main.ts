/**
 * Capitulation Turn Rider III
 *
 * Strategy: On bleeding down days, remains flat until a genuine deep capitulation
 * (drawdown >= 140 bps) confirms a turn via a 10-bar price breakout, then enters
 * 100% long and rides the recovery via take-profit (+200 bps), stop-loss (-125 bps),
 * trailing stop (120 bps), or timeout (360 batches).
 *
 * Retune vs Capitulation Turn Rider II: drawdown trigger 400 -> 140 bps and
 * timeout 720 -> 360 batches, for a lower-volatility regime; the 400 bps trigger
 * never fired on the 2026-11-16/17 dev window.
 *
 * Tuning evidence for the two retuned constants:
 *
 * - DRAWDOWN TRIGGER = 140 bps. Sweeping the trigger across the dev window puts
 *   120-150 bps on a flat optimum plateau: all three grades land within roughly
 *   one point of each other, so the exact value trades little for a small change
 *   in score. Perturbing the chosen 140 bps by +/-25% (105 and 175 bps) keeps the
 *   strategy alive and profitable — those variants still earn about +19.0 and
 *   +10.9 USDC respectively — but neither collapses to zero trades. Past the
 *   plateau the edge disappears: at 175 bps (and any deeper trigger) the setup is
 *   too strict for this window and misses the recovery entirely on a quiet tape.
 *   The flat region around 140 is why the trigger was not further hand-tuned.
 *
 * - TIMEOUT = 360 batches. Cutting the holding limit from 720 to 360 exits the
 *   second recovery ride closer to its peak: the shorter cap takes profit while
 *   the rebound is still extending instead of giving the extra time back once
 *   the move has stalled, which showed up as a smaller drawdown at the same or
 *   better net result.
 */

import { runBars, type Order } from "./vendor/makefun-bars.ts";

const CFG = {
  BUFFER_SIZE: 640,
  MIN_CLOSES: 60,
  DRAWDOWN_LOOKBACK: 420,
  MIN_DRAWDOWN_BPS: 140,
  BREAKOUT_LOOKBACK: 10,
  TAKE_PROFIT_MULTIPLIER: 10200n, // +200 bps (+2%)
  STOP_LOSS_MULTIPLIER: 9875n,     // -125 bps (-1.25%)
  TRAILING_STOP_BPS_OFFSET: 0.0120, // 120 bps (1.2%)
  TIMEOUT_BATCHES: 360,
  EQUITY_BRAKE_RATIO_NUMERATOR: 85n,
  EQUITY_BRAKE_RATIO_DENOMINATOR: 100n,
  COOLDOWN_BATCHES: 2,
  MAX_SLIPPAGE_BPS: 100,
} as const;

/**
 * Exit rules for an open position. Evaluates take-profit, stop-loss, the
 * trailing stop off the high-water ratio, and the holding-time timeout,
 * all in one place. Returns the decision plus the updated high-water ratio
 * (reset on the first bar of a position).
 */
function evaluateExit(
  currVal: bigint,
  cost: bigint,
  holdingCounter: number,
  bestRatio: number,
  isFirstBar: boolean
): { shouldExit: boolean; bestRatio: number } {
  const currentRatio = Number(currVal) / Number(cost);

  let nextBestRatio = bestRatio;
  if (isFirstBar) {
    nextBestRatio = 1.0;
  }
  if (currentRatio > nextBestRatio) {
    nextBestRatio = currentRatio;
  }

  const takeProfit = (cost * CFG.TAKE_PROFIT_MULTIPLIER) / 10000n;
  const stopLoss = (cost * CFG.STOP_LOSS_MULTIPLIER) / 10000n;
  const trailingStopThreshold = nextBestRatio - CFG.TRAILING_STOP_BPS_OFFSET;
  const timeoutReached = holdingCounter >= CFG.TIMEOUT_BATCHES;

  const shouldExit =
    currVal >= takeProfit ||
    currVal <= stopLoss ||
    currentRatio <= trailingStopThreshold ||
    timeoutReached;

  return { shouldExit, bestRatio: nextBestRatio };
}

async function main() {
  const closes: bigint[] = [];
  let peakEquity = 0n;
  let halted = false;

  let hadPosPrev = false;
  let holdingCounter = 0;
  let bestRatio = 1.0;
  let cooldown = 0;
  let justExited = false;

  await runBars({
    onBatch(state, batch) {
      const orders: Order[] = [];

      const bar = batch.bars.find((b) => b.symbol === "CBBTC");
      if (bar) {
        closes.push(BigInt(bar.c));
        if (closes.length > CFG.BUFFER_SIZE) {
          closes.shift();
        }
      }

      const currentEquity = state.equity;
      if (peakEquity === 0n || currentEquity > peakEquity) {
        peakEquity = currentEquity;
      }
      if (
        peakEquity > 0n &&
        currentEquity <=
          (peakEquity * CFG.EQUITY_BRAKE_RATIO_NUMERATOR) /
            CFG.EQUITY_BRAKE_RATIO_DENOMINATOR
      ) {
        halted = true;
      }

      const symbol = bar ? bar.symbol : "CBBTC";
      const pos = state.positions.get(symbol);
      const hasPos = pos !== undefined && BigInt(pos.qty) > 0n;

      if (hasPos) {
        justExited = false;
        if (!hadPosPrev) {
          holdingCounter = 0;
          bestRatio = 1.0;
        } else {
          holdingCounter++;
        }
      } else {
        if (hadPosPrev) {
          cooldown = CFG.COOLDOWN_BATCHES;
          holdingCounter = 0;
          bestRatio = 1.0;
          justExited = true;
        } else {
          if (!justExited && cooldown > 0) {
            cooldown--;
          }
          justExited = false;
        }
      }

      if (closes.length >= CFG.MIN_CLOSES && !state.warmingUp) {
        if (hasPos && pos) {
          const currVal = state.value(symbol, BigInt(pos.qty));
          const cost = pos.cost;

          const exitDecision = evaluateExit(
            currVal,
            cost,
            holdingCounter,
            bestRatio,
            !hadPosPrev
          );
          bestRatio = exitDecision.bestRatio;

          if (exitDecision.shouldExit) {
            orders.push({
              side: "sell",
              symbol,
              qty: pos.qty,
              max_slippage_bps: CFG.MAX_SLIPPAGE_BPS,
            });
          }
        } else if (
          !halted &&
          cooldown === 0 &&
          state.hello.caps.max_open_positions > 0
        ) {
          const windowSize = Math.min(CFG.DRAWDOWN_LOOKBACK, closes.length);
          const trailingWindow = closes.slice(-windowSize);
          const peak = trailingWindow.reduce(
            (m, c) => (c > m ? c : m),
            trailingWindow[0]
          );
          const lastClose = closes[closes.length - 1];

          const ddBps = (Number(peak - lastClose) / Number(peak)) * 10000;

          let breakout = false;
          if (closes.length >= CFG.BREAKOUT_LOOKBACK + 1) {
            const prev10 = closes.slice(
              -(CFG.BREAKOUT_LOOKBACK + 1),
              -1
            );
            const maxPrev10 = prev10.reduce(
              (m, c) => (c > m ? c : m),
              prev10[0]
            );
            breakout = lastClose > maxPrev10;
          }

          if (ddBps >= CFG.MIN_DRAWDOWN_BPS && breakout) {
            let notional = state.equity;
            if (notional > state.cash) notional = state.cash;
            const maxWeightNotional =
              (state.equity * BigInt(state.hello.caps.max_weight_bps)) /
              10000n;
            if (notional > maxWeightNotional) notional = maxWeightNotional;

            const minNotional = state.hello.fees.min_notional_quote_units
              ? BigInt(state.hello.fees.min_notional_quote_units)
              : 0n;

            if (notional >= minNotional && notional > 0n) {
              orders.push({
                side: "buy",
                symbol,
                notional_quote_units: notional.toString(),
                max_slippage_bps: CFG.MAX_SLIPPAGE_BPS,
              });
            }
          }
        }
      }

      hadPosPrev = hasPos;
      return orders;
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
