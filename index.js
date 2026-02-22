import WebSocket from 'ws';
import axios from 'axios';
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';

dotenv.config();

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID,

  // Поріг ВХОДУ: якщо |spread між bid/ask та markPrice| >= цього → сигнал
  SPREAD_ENTRY_THRESHOLD: parseFloat(process.env.SPREAD_ENTRY_THRESHOLD || '0.5'),

  // Поріг ВИХОДУ: якщо |spread| <= цього → вважаємо позицію закритою
  SPREAD_EXIT_THRESHOLD: parseFloat(process.env.SPREAD_EXIT_THRESHOLD || '0.2'),

  // Мінімальна пауза між двома Entry-сповіщеннями для одного символу (мс)
  SIGNAL_COOLDOWN_MS: parseInt(process.env.SIGNAL_COOLDOWN_MS || '60000'),

  // Asterdex endpoints
  WS_BASE_URL:   'wss://fstream.asterdex.com',
  REST_BASE_URL: 'https://fapi.asterdex.com',

  // Reconnect: примусово через 23 год (сервер рве через 24 год)
  FORCED_RECONNECT_MS: 23 * 60 * 60 * 1000,
  RECONNECT_DELAY_MS:  5_000,
};

if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
  console.error('[ERROR] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
  process.exit(1);
}

// ─── STATE ─────────────────────────────────────────────────────────────────────
const tg = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN);

const state = {
  activeSignals:  new Map(), // symbol → { direction, entryTime, entrySpread }
  lastSignalTime: new Map(), // symbol → timestamp (для cooldown)
  markPrice:      new Map(), // symbol → markPrice (з !markPrice@arr@1s)
  bidPrice:       new Map(), // symbol → bestBidPrice (з !bookTicker)
  askPrice:       new Map(), // symbol → bestAskPrice (з !bookTicker)

  // Два WebSocket: один для markPrice, другий для bookTicker
  wsMarkPrice:          null,
  wsBookTicker:         null,
  forcedReconnectMark:  null,
  forcedReconnectBook:  null,
  reconnectTimerMark:   null,
  reconnectTimerBook:   null,

  stats: { mark: 0, book: 0, lastLog: Date.now() },
};

// ─── TELEGRAM (non-blocking) ──────────────────────────────────────────────────
function sendTelegram(text) {
  tg.sendMessage(CONFIG.TELEGRAM_CHAT_ID, text, { parse_mode: 'HTML' })
    .catch(err => console.error('[TG] Error:', err.message));
}

// ─── ФОРМАТУВАННЯ ─────────────────────────────────────────────────────────────
function formatEntry(symbol, spread, execPrice, markPrice, direction) {
  const icon       = direction === 'LONG' ? '🟢' : '🔴';
  const priceLabel = direction === 'LONG' ? 'ASK (купити по)' : 'BID (продати по)';
  const time       = new Date().toISOString().slice(11, 23) + ' UTC';
  return (
    `🚨 <b>Asterdex - ${Math.abs(spread).toFixed(2)}%</b>\n\n` +
    `👉<b>${symbol}</b>👈\n\n` +
    `${icon} <b>${direction}</b>\n` +
    `💱 ${priceLabel}: ${execPrice}\n` +
    `⚖️ Справедлива: ${markPrice}\n` +
    `⏰ Виявлено: ${time}`
  );
}

function formatExit(symbol, execPrice, markPrice, spread, sig) {
  const elapsed = Date.now() - sig.entryTime;
  const secs    = Math.floor(elapsed / 1000);
  const ms      = elapsed % 1000;
  return (
    `✅ <b>${symbol} - Ціни зрівнялись!</b>\n\n` +
    `⏱️ Через: ${secs} сек ${ms} мс\n` +
    `💰 Ціна: ${execPrice}\n` +
    `⚖️ Справедлива: ${markPrice}\n` +
    `📊 Відхилення: ${Math.abs(spread).toFixed(2)}%\n` +
    `📉 Було відхилення: ${Math.abs(sig.entrySpread).toFixed(2)}%`
  );
}

// ─── СТАТИСТИКА ───────────────────────────────────────────────────────────────
function logStats() {
  if (Date.now() - state.stats.lastLog < 2 * 60 * 1000) return;
  console.log(
    `[STATS] mark/2min=${state.stats.mark} | book/2min=${state.stats.book} | ` +
    `activeSignals=${state.activeSignals.size}`
  );
  for (const [sym, sig] of state.activeSignals) {
    const age = Math.round((Date.now() - sig.entryTime) / 1000);
    console.log(`  → ${sym} ${sig.direction} entry=${sig.entrySpread.toFixed(3)}% | ${age}s ago`);
  }
  state.stats.mark    = 0;
  state.stats.book    = 0;
  state.stats.lastLog = Date.now();
}

// ─── CORE ЛОГІКА СПРЕДУ ───────────────────────────────────────────────────────
// Логіка ідентична KuCoin-версії:
//   LONG  → купуємо по ASK, сигнал якщо ask < markPrice (ринок дешевший за справедливу)
//   SHORT → продаємо по BID, сигнал якщо bid > markPrice (ринок дорожчий за справедливу)
function checkSpread(symbol) {
  const markPrice = state.markPrice.get(symbol);
  const bid       = state.bidPrice.get(symbol);
  const ask       = state.askPrice.get(symbol);

  if (!markPrice || markPrice === 0) return;
  if (!bid && !ask) return;

  // LONG: ask нижче markPrice → можна купити дешевше справедливої ціни
  const askSpread  = ask ? ((ask - markPrice) / markPrice) * 100 : null;
  const longSignal = askSpread !== null && askSpread < 0 ? askSpread : null;

  // SHORT: bid вище markPrice → можна продати дорожче справедливої ціни
  const bidSpread   = bid ? ((bid - markPrice) / markPrice) * 100 : null;
  const shortSignal = bidSpread !== null && bidSpread > 0 ? bidSpread : null;

  // Немає жодного відхилення — все в нормі
  if (longSignal === null && shortSignal === null) {
    // Перевіряємо EXIT якщо є активний сигнал
    if (state.activeSignals.has(symbol)) {
      // Для виходу беремо "нейтральний" спред — closest to zero
      const neutralSpread = askSpread !== null ? askSpread : (bidSpread !== null ? bidSpread : 0);
      if (Math.abs(neutralSpread) <= CONFIG.SPREAD_EXIT_THRESHOLD) {
        const sig       = state.activeSignals.get(symbol);
        const execPrice = sig.direction === 'LONG' ? ask ?? bid : bid ?? ask;
        console.log(`[EXIT]  ${symbol} spread=${neutralSpread.toFixed(3)}%`);
        state.activeSignals.delete(symbol);
        sendTelegram(formatExit(symbol, execPrice, markPrice, neutralSpread, sig));
      }
    }
    return;
  }

  // Беремо сильніший сигнал
  let spread, execPrice, direction;
  if (longSignal !== null && (shortSignal === null || Math.abs(longSignal) >= Math.abs(shortSignal))) {
    spread = longSignal; execPrice = ask; direction = 'LONG';
  } else {
    spread = shortSignal; execPrice = bid; direction = 'SHORT';
  }

  const absSpread = Math.abs(spread);
  const hasSignal = state.activeSignals.has(symbol);
  const cooldown  = (Date.now() - (state.lastSignalTime.get(symbol) || 0)) >= CONFIG.SIGNAL_COOLDOWN_MS;

  // ── ENTRY ────────────────────────────────────────────────────────────────────
  if (!hasSignal && absSpread >= CONFIG.SPREAD_ENTRY_THRESHOLD && cooldown) {
    console.log(`[ENTRY] ${symbol} ${direction} spread=${spread.toFixed(3)}% exec=${execPrice} mark=${markPrice}`);
    state.activeSignals.set(symbol, { direction, entryTime: Date.now(), entrySpread: spread });
    state.lastSignalTime.set(symbol, Date.now());
    sendTelegram(formatEntry(symbol, spread, execPrice, markPrice, direction));
    return;
  }

  // ── EXIT ──────────────────────────────────────────────────────────────────────
  if (hasSignal && absSpread <= CONFIG.SPREAD_EXIT_THRESHOLD) {
    const sig = state.activeSignals.get(symbol);
    console.log(`[EXIT]  ${symbol} spread=${spread.toFixed(3)}%`);
    state.activeSignals.delete(symbol);
    sendTelegram(formatExit(symbol, execPrice, markPrice, spread, sig));
  }
}

// ─── WEBSOCKET: !markPrice@arr@1s ─────────────────────────────────────────────
// Отримуємо markPrice для всіх символів щосекунди
function connectMarkPrice() {
  clearTimeout(state.reconnectTimerMark);
  clearTimeout(state.forcedReconnectMark);

  const url = `${CONFIG.WS_BASE_URL}/ws/!markPrice@arr@1s`;
  console.log(`[WS:markPrice] Connecting to ${url}`);

  const ws = new WebSocket(url);
  state.wsMarkPrice = ws;

  ws.on('open', () => {
    console.log('[WS:markPrice] Connected');
    state.forcedReconnectMark = setTimeout(() => {
      console.log('[WS:markPrice] Forced 23h reconnect');
      ws.terminate();
    }, CONFIG.FORCED_RECONNECT_MS);
  });

  ws.on('message', (raw) => {
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;

      for (const item of arr) {
        const symbol    = item.s;
        const markPrice = parseFloat(item.p);
        if (!symbol || isNaN(markPrice) || markPrice <= 0) continue;

        state.markPrice.set(symbol, markPrice);
        state.stats.mark++;

        logStats();

        // Перевіряємо спред одразу після оновлення markPrice (якщо є bid/ask)
        if (state.bidPrice.has(symbol) || state.askPrice.has(symbol)) {
          checkSpread(symbol);
        }
      }
    } catch (err) {
      console.error('[WS:markPrice] Parse error:', err.message);
    }
  });

  ws.on('ping', () => ws.pong());

  ws.on('error', (err) => console.error('[WS:markPrice] Error:', err.message));

  ws.on('close', (code) => {
    console.log(`[WS:markPrice] Closed (${code}). Reconnecting in ${CONFIG.RECONNECT_DELAY_MS}ms...`);
    clearTimeout(state.forcedReconnectMark);
    state.reconnectTimerMark = setTimeout(connectMarkPrice, CONFIG.RECONNECT_DELAY_MS);
  });
}

// ─── WEBSOCKET: !bookTicker ────────────────────────────────────────────────────
// Отримуємо best bid/ask для всіх символів в реальному часі
// Payload: { e:"bookTicker", s:"BTCUSDT", b:"bestBid", B:"bestBidQty", a:"bestAsk", A:"bestAskQty" }
function connectBookTicker() {
  clearTimeout(state.reconnectTimerBook);
  clearTimeout(state.forcedReconnectBook);

  const url = `${CONFIG.WS_BASE_URL}/ws/!bookTicker`;
  console.log(`[WS:bookTicker] Connecting to ${url}`);

  const ws = new WebSocket(url);
  state.wsBookTicker = ws;

  ws.on('open', () => {
    console.log('[WS:bookTicker] Connected');
    state.forcedReconnectBook = setTimeout(() => {
      console.log('[WS:bookTicker] Forced 23h reconnect');
      ws.terminate();
    }, CONFIG.FORCED_RECONNECT_MS);
  });

  ws.on('message', (raw) => {
    try {
      const item = JSON.parse(raw);
      // !bookTicker шле один об'єкт за раз (не масив)
      if (!item || item.e !== 'bookTicker') return;

      const symbol = item.s;
      const bid    = parseFloat(item.b);
      const ask    = parseFloat(item.a);

      if (!symbol) return;
      if (!isNaN(bid) && bid > 0) state.bidPrice.set(symbol, bid);
      if (!isNaN(ask) && ask > 0) state.askPrice.set(symbol, ask);

      state.stats.book++;

      // Перевіряємо спред після оновлення bid/ask (якщо є markPrice)
      if (state.markPrice.has(symbol)) {
        checkSpread(symbol);
      }
    } catch (err) {
      console.error('[WS:bookTicker] Parse error:', err.message);
    }
  });

  ws.on('ping', () => ws.pong());

  ws.on('error', (err) => console.error('[WS:bookTicker] Error:', err.message));

  ws.on('close', (code) => {
    console.log(`[WS:bookTicker] Closed (${code}). Reconnecting in ${CONFIG.RECONNECT_DELAY_MS}ms...`);
    clearTimeout(state.forcedReconnectBook);
    state.reconnectTimerBook = setTimeout(connectBookTicker, CONFIG.RECONNECT_DELAY_MS);
  });
}

// ─── STARTUP CHECK ────────────────────────────────────────────────────────────
async function ping() {
  try {
    const res   = await axios.get(`${CONFIG.REST_BASE_URL}/fapi/v1/exchangeInfo`, { timeout: 10_000 });
    const count = res.data?.symbols?.filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT').length ?? '?';
    console.log(`[API] Asterdex OK — ${count} active USDT symbols`);
    return count;
  } catch (err) {
    console.warn('[API] Could not fetch exchangeInfo:', err.message);
    return '?';
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('📊 ASTERDEX SPREAD MONITOR BOT (bid/ask vs markPrice)');
  console.log('='.repeat(60));
  console.log(`[CONFIG] Entry Threshold : ${CONFIG.SPREAD_ENTRY_THRESHOLD}%`);
  console.log(`[CONFIG] Exit  Threshold : ${CONFIG.SPREAD_EXIT_THRESHOLD}%`);
  console.log(`[CONFIG] Signal Cooldown : ${CONFIG.SIGNAL_COOLDOWN_MS / 1000}s`);
  console.log('='.repeat(60));

  const symbolCount = await ping();

  // Запускаємо обидва стріми паралельно
  connectMarkPrice();
  connectBookTicker();

  sendTelegram(
    `🤖 <b>ASTERDEX SPREAD MONITOR STARTED</b>\n\n` +
    `Моніторинг: ~${symbolCount} USDT символів\n` +
    `Метод: bid/ask vs markPrice (справедлива)\n` +
    `Поріг входу: ${CONFIG.SPREAD_ENTRY_THRESHOLD}%\n` +
    `Поріг виходу: ${CONFIG.SPREAD_EXIT_THRESHOLD}%\n` +
    `Cooldown: ${CONFIG.SIGNAL_COOLDOWN_MS / 1000}s`
  );
}

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n[SHUTDOWN] ${signal} received`);
  clearTimeout(state.reconnectTimerMark);
  clearTimeout(state.reconnectTimerBook);
  clearTimeout(state.forcedReconnectMark);
  clearTimeout(state.forcedReconnectBook);
  if (state.wsMarkPrice)  state.wsMarkPrice.terminate();
  if (state.wsBookTicker) state.wsBookTicker.terminate();

  tg.sendMessage(CONFIG.TELEGRAM_CHAT_ID, '🛑 <b>ASTERDEX SPREAD MONITOR STOPPED</b>', { parse_mode: 'HTML' })
    .finally(() => process.exit(0));
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
