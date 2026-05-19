import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

let chatId   = process.env.TELEGRAM_CHAT_ID || null;
let _offset  = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch (error) {
    log("telegram_warn", `Invalid user-config.json; chatId not loaded: ${error.message}`);
  }
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const chatType = msg.chat?.type || "unknown";

  if (!chatId) {
    if (!_warnedMissingChatId) {
      log("telegram_warn", "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety.");
      _warnedMissingChatId = true;
    }
    return false;
  }

  if (incomingChatId !== chatId) return false;

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log("telegram_warn", "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control.");
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
  }

  return true;
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

async function postTelegram(method, body) {
  if (!TOKEN || !chatId) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

async function postTelegramRaw(method, body) {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

export async function sendMessage(text) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendMessageWithButtons(text, inlineKeyboard) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", {
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function sendHTML(html) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: html.slice(0, 4096), parse_mode: "HTML" });
}

export async function editMessage(text, messageId) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
  });
}

export async function editMessageWithButtons(text, messageId, inlineKeyboard) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!TOKEN || !callbackQueryId) return null;
  return postTelegramRaw("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

export function hasActiveLiveMessage() {
  return _liveMessageDepth > 0;
}

function createTypingIndicator() {
  if (!TOKEN || !chatId) {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" });
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function toolLabel(name) {
  const labels = {
    get_token_info: "🔍 Token info",
    get_token_narrative: "📰 Token narrative",
    get_token_holders: "👥 Token holders",
    get_top_candidates: "📊 Top candidates",
    get_pool_detail: "🏊 Pool detail",
    get_active_bin: "📍 Active bin",
    deploy_position: "🚀 Deploy position",
    close_position: "🔒 Close position",
    claim_fees: "💰 Claim fees",
    swap_token: "🔄 Swap",
    update_config: "⚙️ Update config",
    get_my_positions: "📋 My positions",
    get_wallet_balance: "👛 Wallet balance",
    check_smart_wallets_on_pool: "🐋 Smart wallets",
    study_top_lpers: "🎓 Study top LPers",
    get_top_lpers: "🏆 Top LPers",
    search_pools: "🔎 Search pools",
    discover_pools: "🌐 Discover pools",
    get_recent_decisions: "📜 Recent decisions",
    list_smart_wallets: "📒 Smart wallets list",
    add_smart_wallet: "➕ Add smart wallet",
    remove_smart_wallet: "➖ Remove smart wallet",
    list_blacklist: "🚫 Blacklist",
    add_to_blacklist: "🚫 Add to blacklist",
    remove_from_blacklist: "✅ Remove from blacklist",
    block_deployer: "🛑 Block deployer",
    unblock_deployer: "✅ Unblock deployer",
    list_blocked_deployers: "📋 Blocked deployers",
    add_lesson: "📝 Add lesson",
    list_lessons: "📚 Lessons",
    pin_lesson: "📌 Pin lesson",
    unpin_lesson: "📍 Unpin lesson",
    clear_lessons: "🗑️ Clear lessons",
    get_position_pnl: "📈 Position PnL",
    get_wallet_positions: "👛 Wallet positions",
    get_performance_history: "📊 Performance",
    add_pool_note: "🗒️ Pool note",
    set_position_note: "🗒️ Position note",
    self_update: "⬆️ Self update",
    list_strategies: "🎯 Strategies",
    get_strategy: "🎯 Strategy detail",
    add_strategy: "➕ Add strategy",
    update_strategy: "✏️ Update strategy",
    delete_strategy: "🗑️ Delete strategy",
    remove_strategy: "🗑️ Remove strategy",
    set_active_strategy: "🎯 Activate strategy",
    get_pool_memory: "🧠 Pool memory",
  };
  return labels[name] || `🔧 ${name.replace(/_/g, " ")}`;
}

function fmtNumber(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtSol(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `◎${n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function fmtUsd(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function fmtAddr(addr, head = 4, tail = 4) {
  const s = String(addr || "");
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const DIVIDER = "━━━━━━━━━━━━━━━━━━";

function summarizeToolResult(name, result) {
  if (!result) return "";
  if (result.error) return String(result.error).slice(0, 80);
  if (result.reason && result.blocked) return String(result.reason).slice(0, 80);
  switch (name) {
    case "deploy_position":
      return result.position ? `${fmtAddr(result.position)} ✓` : "submitted";
    case "close_position":
      if (result.success === false) return result.reason || "failed";
      if (result.pnl_usd != null) {
        const pnl = Number(result.pnl_usd);
        const sign = pnl >= 0 ? "+" : "";
        return `${sign}${fmtUsd(pnl)} closed`;
      }
      return "closed";
    case "claim_fees":
      return result.claimed_amount != null ? `claimed ${fmtNumber(result.claimed_amount, 4)}` : "done";
    case "update_config":
      return Object.keys(result.applied || {}).join(", ") || "updated";
    case "get_top_candidates":
      return `${result.candidates?.length ?? 0} pools found`;
    case "get_my_positions":
      return `${result.total_positions ?? result.positions?.length ?? 0} open`;
    case "get_wallet_balance":
      return result.sol != null ? fmtSol(result.sol) : "ok";
    case "study_top_lpers":
    case "get_top_lpers":
      return `${result.lpers?.length ?? 0} LPers`;
    case "swap_token":
      if (result.success === false) return "failed";
      return result.amount_out != null ? `→ ${fmtNumber(result.amount_out, 4)}` : "swapped";
    case "get_token_info":
      return result.symbol || "ok";
    case "search_pools":
    case "discover_pools":
      return `${result.pools?.length ?? 0} pools`;
    default:
      return result.success === false ? "failed" : "done";
  }
}

export async function createLiveMessage(title, intro = "Starting...") {
  if (!TOKEN || !chatId) return null;
  const typing = createTypingIndicator();

  const state = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
  };

  function render() {
    const sections = [];
    // Header
    sections.push(`<b>${escapeHtml(state.title)}</b>`);
    if (state.intro) {
      sections.push(`<i>${escapeHtml(state.intro)}</i>`);
    }
    if (state.toolLines.length > 0) {
      sections.push(state.toolLines.join("\n"));
    }
    if (state.footer) {
      sections.push(DIVIDER);
      sections.push(state.footer);
    }
    return sections.join("\n\n").slice(0, 4096);
  }

  async function flushNow() {
    state.flushTimer = null;
    state.flushRequested = false;
    const text = render();
    if (!state.messageId) {
      const sent = await postTelegram("sendMessage", { text, parse_mode: "HTML" });
      state.messageId = sent?.result?.message_id ?? null;
      return;
    }
    await postTelegram("editMessageText", {
      message_id: state.messageId,
      text,
      parse_mode: "HTML",
    });
  }

  function scheduleFlush(delay = 300) {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => null);
    }, delay);
  }

  async function upsertToolLine(name, icon, suffix = "") {
    const label = toolLabel(name);
    const escapedSuffix = suffix ? ` <code>${escapeHtml(suffix)}</code>` : "";
    const line = `${icon} ${label}${escapedSuffix}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(label));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name) {
      await upsertToolLine(name, "⏳", "running…");
    },
    async toolFinish(name, result, success) {
      const icon = success ? "✓" : "✗";
      const summary = summarizeToolResult(name, result);
      await upsertToolLine(name, icon, summary);
    },
    async note(text) {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      // Final text from agent — render as plain (escaped) so it's safe regardless of content
      state.footer = escapeHtml(finalText);
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ <b>Error</b>\n<code>${escapeHtml(errorText)}</code>`;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const callback = update.callback_query;
        if (callback?.data && callback?.message) {
          const callbackMsg = {
            chat: callback.message.chat,
            from: callback.from,
            text: callback.data,
          };
          if (!isAuthorizedIncomingMessage(callbackMsg)) continue;
          await onMessage({
            ...callbackMsg,
            isCallback: true,
            callbackQueryId: callback.id,
            callbackData: callback.data,
            messageId: callback.message.message_id,
          });
          continue;
        }
        const msg = update.message;
        if (!msg?.text) continue;
        if (!isAuthorizedIncomingMessage(msg)) continue;
        await onMessage(msg);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  _polling = true;
  poll(onMessage); // fire-and-forget
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, rangeCoverage, binStep, baseFee }) {
  if (hasActiveLiveMessage()) return;
  const lines = [
    `🚀 <b>Deployed</b> · ${escapeHtml(pair)}`,
    DIVIDER,
    `<b>Amount:</b>      ${fmtSol(amountSol)}`,
  ];
  if (priceRange) {
    const lo = priceRange.min < 0.0001 ? Number(priceRange.min).toExponential(3) : Number(priceRange.min).toFixed(6);
    const hi = priceRange.max < 0.0001 ? Number(priceRange.max).toExponential(3) : Number(priceRange.max).toFixed(6);
    lines.push(`<b>Range:</b>       ${lo} – ${hi}`);
  }
  if (rangeCoverage) {
    lines.push(`<b>Coverage:</b>    ↓${fmtPct(rangeCoverage.downside_pct)} · ↑${fmtPct(rangeCoverage.upside_pct)} · width ${fmtPct(rangeCoverage.width_pct)}`);
  }
  if (binStep != null || baseFee != null) {
    lines.push(`<b>Pool:</b>        bin ${binStep ?? "?"} · fee ${baseFee != null ? baseFee + "%" : "?"}`);
  }
  lines.push(`<b>Position:</b>    <code>${escapeHtml(fmtAddr(position, 6, 6))}</code>`);
  if (tx) lines.push(`<b>Tx:</b>          <code>${escapeHtml(fmtAddr(tx, 6, 6))}</code>`);
  await sendHTML(lines.join("\n"));
}

export async function notifyClose({ pair, pnlUsd, pnlPct }) {
  if (hasActiveLiveMessage()) return;
  const pnl = Number(pnlUsd) || 0;
  const pct = Number(pnlPct) || 0;
  const isWin = pnl >= 0;
  const sign = isWin ? "+" : "";
  const emoji = isWin ? "🟢" : "🔴";
  await sendHTML(
    [
      `🔒 <b>Closed</b> · ${escapeHtml(pair)}`,
      DIVIDER,
      `${emoji} <b>PnL:</b> ${sign}${fmtUsd(pnl)} (${sign}${pct.toFixed(2)}%)`,
    ].join("\n")
  );
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    [
      `🔄 <b>Swapped</b> · ${escapeHtml(inputSymbol)} → ${escapeHtml(outputSymbol)}`,
      DIVIDER,
      `<b>In:</b>  ${fmtNumber(amountIn, 4)} ${escapeHtml(inputSymbol)}`,
      `<b>Out:</b> ${fmtNumber(amountOut, 4)} ${escapeHtml(outputSymbol)}`,
      tx ? `<b>Tx:</b>  <code>${escapeHtml(fmtAddr(tx, 6, 6))}</code>` : null,
    ].filter(Boolean).join("\n")
  );
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    [
      `⚠️ <b>Out of Range</b> · ${escapeHtml(pair)}`,
      DIVIDER,
      `Position has been out of range for <b>${minutesOOR}m</b>.`,
    ].join("\n")
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}
