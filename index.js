import WebSocket from 'ws';
import axios from 'axios';
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';

dotenv.config();

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  TELEGRAM_BOT_TOKEN:    process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID:      process.env.TELEGRAM_CHAT_ID,

  // Поріг ВХОДУ: якщо |spread| >= цього значення → відправляємо сповіщення
  SPREAD_ENTRY_THRESHOLD: parseFloat(process.env.SPREAD_ENTRY_THRESHOLD || '0.3'),

  // Поріг ВИХОДУ: якщо |spread| <= цього значення → вважаємо позицію закритою
  // Рекомендовано 0.15-0.2%, бо markPrice рідко падає нижче цього навіть при "рівновазі"
  SPREAD_EXIT_THRESHOLD:  parseFloat(process.env.SPREAD_EXIT_THRESHOLD  || '0.15'),

  // Мінімальна пауза між двома Entry-сповіщеннями для одного символу (мс)
  // Захист від "флікерингу" якщо спред стрибає навколо порогу
  SIGNAL_COOLDOWN_MS: parseInt(process.env.SIGNAL_COOLDOWN_MS || '60000'),

  // Asterdex endpoints
  WS_BASE_URL:  'wss://fstream.asterdex.com',
  REST_BASE_URL: 'https://fapi.asterdex.com',

  // Reconnect при помилці / примусово кожні 23 год (Asterdex рве з'єднання через 24 год)
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
  activeSignals: new Map(),   // symbol → { direction, entryTime, entrySpread }
  lastSignalTime: new Map(),  // symbol → timestamp (для cooldown)
  lastIndexPrice: new Map(),  // symbol → indexPrice (кеш — стрім іноді не шле item.i)
  ws: null,
  forcedReconnectTimer: null,
  reconnectTimer: null,
};

// ─── TELEGRAM (non-blocking fire-and-forget) ───────────────────────────────────
function sendTelegram(text) {
  tg.sendMessage(CONFIG.TELEGRAM_CHAT_ID, text, { parse_mode: 'HTML' })
    .catch(err => console.error('[TG] Send error:', err.message));
}

// ─── HELPERS ───────────────────────────────────────────────────────────────────
function calcSpread(markPrice, indexPrice) {
  if (!markPrice || !indexPrice || indexPrice === 0) return 0;
  return ((markPrice - indexPrice) / indexPrice) * 100;
}

function formatEntry(symbol, direction, markPrice, indexPrice, spread) {
  return (
    `📊 <b>SPREAD SIGNAL</b>\n` +
    `SYMBOL: <code>${symbol}</code>\n` +
    `DIRECTION: <b>${direction}</b>\n` +
    `MARK_PRICE: ${markPrice}\n` +
    `INDEX_PRICE: ${indexPrice}\n` +
    `SPREAD: <b>${spread.toFixed(3)}%</b>\n` +
    `TIME: ${new Date().toISOString()}`
  );
}

function formatExit(symbol, direction, markPrice, indexPrice, spread, entrySpread) {
  return (
    `✅ <b>SPREAD CLOSED</b>\n` +
    `SYMBOL: <code>${symbol}</code>\n` +
    `DIRECTION: ${direction}\n` +
    `MARK_PRICE: ${markPrice}\n` +
    `INDEX_PRICE: ${indexPrice}\n` +
    `SPREAD: ${spread.toFixed(3)}%\n` +
    `ENTRY WAS: ${entrySpread.toFixed(3)}%\n` +
    `TIME: ${new Date().toISOString()}`
  );
}

// ─── CORE LOGIC ────────────────────────────────────────────────────────────────
function processMarkPrice(symbol, markPrice, indexPrice) {
  const spread    = calcSpread(markPrice, indexPrice);
  const absSpread = Math.abs(spread);
  const direction = markPrice < indexPrice ? 'LONG' : 'SHORT';

  const hasSignal  = state.activeSignals.has(symbol);
  const lastSent   = state.lastSignalTime.get(symbol) || 0;
  const cooldownOk = (Date.now() - lastSent) >= CONFIG.SIGNAL_COOLDOWN_MS;

  // ── ENTRY ──────────────────────────────────────────────────────────────────
  if (!hasSignal && absSpread >= CONFIG.SPREAD_ENTRY_THRESHOLD && cooldownOk) {
    console.log(`[ENTRY] ${symbol} ${direction} spread=${spread.toFixed(3)}%`);

    state.activeSignals.set(symbol, { direction, entryTime: Date.now(), entrySpread: spread });
    state.lastSignalTime.set(symbol, Date.now());

    sendTelegram(formatEntry(symbol, direction, markPrice, indexPrice, spread));
    return;
  }

  // ── EXIT ───────────────────────────────────────────────────────────────────
  if (hasSignal && absSpread <= CONFIG.SPREAD_EXIT_THRESHOLD) {
    const sig = state.activeSignals.get(symbol);
    console.log(`[EXIT]  ${symbol} ${sig.direction} spread=${spread.toFixed(3)}%`);

    state.activeSignals.delete(symbol);

    sendTelegram(formatExit(symbol, sig.direction, markPrice, indexPrice, spread, sig.entrySpread));
  }
}

// ─── WEBSOCKET ─────────────────────────────────────────────────────────────────
// Використовуємо спеціальний стрім !markPrice@arr@1s — він пушить
// markPrice + indexPrice для ВСІХ символів щосекунди.
// Один WebSocket замість сотень підписок.
function connect() {
  clearTimeout(state.reconnectTimer);
  clearTimeout(state.forcedReconnectTimer);

  const url = `${CONFIG.WS_BASE_URL}/ws/!markPrice@arr@1s`;
  console.log(`[WS] Connecting to ${url}`);

  const ws = new WebSocket(url);
  state.ws = ws;

  ws.on('open', () => {
    console.log('[WS] Connected — receiving !markPrice@arr@1s stream');

    // Asterdex розриває з'єднання рівно через 24 год → reconnect через 23 год
    state.forcedReconnectTimer = setTimeout(() => {
      console.log('[WS] Forced 23h reconnect');
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

        // indexPrice (item.i) іноді відсутній у пакеті — беремо з кешу
        let indexPrice = parseFloat(item.i);
        if (!isNaN(indexPrice) && indexPrice > 0) {
          state.lastIndexPrice.set(symbol, indexPrice);
        } else {
          indexPrice = state.lastIndexPrice.get(symbol) ?? NaN;
        }

        if (!symbol || isNaN(markPrice) || isNaN(indexPrice)) continue;
        processMarkPrice(symbol, markPrice, indexPrice);
      }
    } catch (err) {
      console.error('[WS] Parse error:', err.message);
    }
  });

  ws.on('ping', () => ws.pong());

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });

  ws.on('close', (code, reason) => {
    console.log(`[WS] Closed (${code}). Reconnecting in ${CONFIG.RECONNECT_DELAY_MS}ms…`);
    clearTimeout(state.forcedReconnectTimer);
    state.reconnectTimer = setTimeout(connect, CONFIG.RECONNECT_DELAY_MS);
  });
}

// ─── STARTUP CHECK (необов'язково — переконатися що API доступне) ──────────────
async function ping() {
  try {
    const res = await axios.get(`${CONFIG.REST_BASE_URL}/fapi/v1/exchangeInfo`, { timeout: 10_000 });
    const count = res.data?.symbols?.filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT').length ?? '?';
    console.log(`[API] Asterdex OK — ${count} active USDT symbols`);
    return count;
  } catch (err) {
    console.warn('[API] Could not fetch exchangeInfo:', err.message);
    return '?';
  }
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('📊 ASTERDEX SPREAD MONITOR BOT');
  console.log('='.repeat(60));
  console.log(`[CONFIG] Entry Threshold : ${CONFIG.SPREAD_ENTRY_THRESHOLD}%`);
  console.log(`[CONFIG] Exit  Threshold : ${CONFIG.SPREAD_EXIT_THRESHOLD}%`);
  console.log(`[CONFIG] Signal Cooldown : ${CONFIG.SIGNAL_COOLDOWN_MS / 1000}s`);
  console.log('='.repeat(60));

  const symbolCount = await ping();

  connect();

  sendTelegram(
    `🤖 <b>ASTERDEX SPREAD MONITOR STARTED</b>\n\n` +
    `Monitoring: ~${symbolCount} USDT symbols\n` +
    `Entry Threshold: ${CONFIG.SPREAD_ENTRY_THRESHOLD}%\n` +
    `Exit Threshold:  ${CONFIG.SPREAD_EXIT_THRESHOLD}%\n` +
    `Signal Cooldown: ${CONFIG.SIGNAL_COOLDOWN_MS / 1000}s`
  );
}

// ─── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n[SHUTDOWN] ${signal} received`);
  clearTimeout(state.reconnectTimer);
  clearTimeout(state.forcedReconnectTimer);
  if (state.ws) state.ws.terminate();

  // Даємо Telegram відправитись перед виходом
  tg.sendMessage(CONFIG.TELEGRAM_CHAT_ID, '🛑 <b>ASTERDEX SPREAD MONITOR STOPPED</b>', { parse_mode: 'HTML' })
    .finally(() => process.exit(0));
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
