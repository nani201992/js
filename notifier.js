// notifier.js (Discord.js v14, ESM)
// Mục tiêu: khi có tin nhắn mới ở ANNOUNCE_CHANNEL_ID -> mention toàn bộ user đã react (từ reacts.json) + DM "đã tìm thấy"

import { Client, GatewayIntentBits, Partials } from "discord.js";
import fs from "fs/promises";
import path from "path";

// ================== CONFIG ==================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN; // khuyên dùng env
if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN env. Run: DISCORD_TOKEN=xxx node notifier.js");
  process.exit(1);
}

// Kênh có tin nhắn mới để trigger notify
const ANNOUNCE_CHANNEL_ID = "1449214342905200706";

// File store được tạo bởi bot auto-react/role (scrim.js)
const STORE_FILE = path.resolve("./reacts.json");

// File state để tránh notify trùng message
const STATE_FILE = path.resolve("./notifier_state.json");

// Batch để tránh vượt giới hạn 2000 ký tự và giảm spam
const MENTION_BATCH_SIZE = 40; // 40 mentions / tin là khá an toàn
const SEND_DELAY_MS = 1100;    // delay nhẹ giữa các tin để tránh rate-limit

// Nội dung DM
const DM_TEXT = "đã tìm thấy";

// ================== CLIENT ==================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ================== HELPERS ==================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJsonSafe(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

async function writeJsonSafe(file, data) {
  try {
    await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("writeJsonSafe error:", e?.message || e);
  }
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Đọc reacts.json và lấy toàn bộ userId từ reactStore
async function getAllReactorsFromStore() {
  const data = await readJsonSafe(STORE_FILE, null);
  if (!data || !data.reactStore) return [];

  const ids = [];
  for (const mid of Object.keys(data.reactStore)) {
    const arr = data.reactStore[mid];
    if (Array.isArray(arr)) ids.push(...arr);
  }
  return uniq(ids).filter(Boolean);
}

async function dmUser(userId) {
  try {
    const u = await client.users.fetch(userId).catch(() => null);
    if (!u) return false;
    await u.send(DM_TEXT).catch(() => null);
    return true;
  } catch {
    return false;
  }
}

// ================== STATE ==================
let state = {
  notifiedMessageIds: [], // lưu message.id đã xử lý
};

async function loadState() {
  state = await readJsonSafe(STATE_FILE, { notifiedMessageIds: [] });
  if (!Array.isArray(state.notifiedMessageIds)) state.notifiedMessageIds = [];
}

async function markNotified(messageId) {
  if (!state.notifiedMessageIds.includes(messageId)) {
    state.notifiedMessageIds.push(messageId);
    // giới hạn size để file không phình vô hạn
    if (state.notifiedMessageIds.length > 5000) {
      state.notifiedMessageIds = state.notifiedMessageIds.slice(-3000);
    }
    await writeJsonSafe(STATE_FILE, state);
  }
}

// ================== EVENTS ==================
client.once("ready", async () => {
  await loadState();
  console.log(`Notifier ready — ${client.user.tag}`);
  console.log(`Announce channel: ${ANNOUNCE_CHANNEL_ID}`);
  console.log(`Using store file: ${STORE_FILE}`);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author?.bot) return;
    if (String(message.channel?.id) !== String(ANNOUNCE_CHANNEL_ID)) return;

    // chống xử lý trùng
    if (state.notifiedMessageIds.includes(message.id)) return;

    const reactorIds = await getAllReactorsFromStore();
    if (!reactorIds.length) {
      await markNotified(message.id);
      console.log("No reactors found in store -> skip mention/DM");
      return;
    }

    // Mention trong kênh (reply vào message mới)
    const mentionStrings = reactorIds.map((id) => `<@${id}>`);
    const batches = chunk(mentionStrings, MENTION_BATCH_SIZE);

    for (let i = 0; i < batches.length; i++) {
      const content = batches[i].join(" ");
      await message.reply({
        content,
        allowedMentions: { users: reactorIds }, // chỉ ping user, không ping role/everyone
      }).catch(() => null);

      if (i < batches.length - 1) await sleep(SEND_DELAY_MS);
    }

    // DM từng người: "đã tìm thấy"
    // (DM nhiều người có thể rate limit -> có delay nhẹ)
    for (const uid of reactorIds) {
      await dmUser(uid);
      await sleep(300);
    }

    await markNotified(message.id);
    console.log(`Notified ${reactorIds.length} users for message ${message.id}`);
  } catch (e) {
    console.error("messageCreate handler error:", e?.message || e);
  }
});

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("Failed to login:", err?.message || err);
});
