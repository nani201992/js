
// scrim.js
// Discord.js v14
// Updated: improved reliability so roles are revoked when a watched message is deleted.
// - On ready: sync recent trigger messages in WATCH_CHANNEL_ID and store current reactors.
// - On messageReactionAdd: store full current reactor set (not just the single user).
// - On messageReactionRemove: update store to reflect current reactors.
// - MessageDelete uses reactStore (persisted) to revoke roles reliably.
// WARNING: keeps inline token/ids as in your file.

import { Client, GatewayIntentBits, Partials } from 'discord.js';
import fs from 'fs/promises';
import path from 'path';

// ---------------- CONFIG ----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID       = "1343532389502025809";

// channel to watch (your provided value)
const WATCH_CHANNEL_ID = "1449214342905200705";

// role to grant/revoke:
const ACCESS_ROLE_ID  = "1450324100164878336";

// reaction emoji and access cap (max users allowed to have role at same time)
const REACTION_EMOJI  = '✅';
const REACTION_CAP    = 7; // 6 allowed; 7th will be put into waiting queue

// store file for reactors + wait queue
const STORE_FILE = path.resolve('./reacts.json');

// ---------------- TRIGGER RULES ----------------
// Only auto-react when message contains a real @everyone mention AND the content is exactly:
// "@everyone <number>" where number is an integer between MIN_NUMBER and MAX_NUMBER inclusive.
const MIN_NUMBER = 5;
const MAX_NUMBER = 8;

// ---------------- CLIENT SETUP ----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User]
});

// ---------------- IN-MEMORY STORES ----------------
// reactStore: { messageId: Set(userId) } - users who currently have the role from that message
// waitQueue:  { messageId: Array(userId) } - FIFO queue of waiting users (they do not have the role)
let reactStore = {};
let waitQueue = {};

// ---------------- PERSISTENCE ----------------
async function loadStore() {
  try {
    const raw = await fs.readFile(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    reactStore = {};
    if (parsed.reactStore) {
      for (const [mid, arr] of Object.entries(parsed.reactStore)) {
        reactStore[mid] = new Set(arr || []);
      }
    }
    waitQueue = parsed.waitQueue || {};
    console.log('Loaded react store:', Object.keys(reactStore).length, 'messages; waitQueue:', Object.keys(waitQueue).length);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      reactStore = {};
      waitQueue = {};
      console.log('No persists found, starting fresh.');
    } else {
      console.error('Failed to load store:', e);
      reactStore = {};
      waitQueue = {};
    }
  }
}

async function saveStore() {
  try {
    const plain = { reactStore: {}, waitQueue: {} };
    for (const [mid, set] of Object.entries(reactStore)) {
      plain.reactStore[mid] = Array.from(set);
    }
    for (const [mid, arr] of Object.entries(waitQueue)) {
      plain.waitQueue[mid] = Array.from(arr);
    }
    await fs.writeFile(STORE_FILE, JSON.stringify(plain, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save store:', e);
  }
}

// ---------------- HELPERS ----------------
function addToReactStore(messageId, userId) {
  if (!reactStore[messageId]) reactStore[messageId] = new Set();
  reactStore[messageId].add(userId);
  saveStore().catch(err => console.error('saveStore err', err));
}

function setReactStoreFromArray(messageId, arr) {
  if (!arr || arr.length === 0) {
    if (reactStore[messageId]) {
      delete reactStore[messageId];
      saveStore().catch(err => console.error('saveStore err', err));
    }
    return;
  }
  reactStore[messageId] = new Set(arr);
  saveStore().catch(err => console.error('saveStore err', err));
}

function removeFromReactStore(messageId, userId) {
  const s = reactStore[messageId];
  if (!s) return;
  s.delete(userId);
  if (s.size === 0) delete reactStore[messageId];
  saveStore().catch(err => console.error('saveStore err', err));
}

function pushToWaitQueue(messageId, userId) {
  if (!waitQueue[messageId]) waitQueue[messageId] = [];
  if (!waitQueue[messageId].includes(userId)) {
    waitQueue[messageId].push(userId);
    saveStore().catch(err => console.error('saveStore err', err));
  }
}

function removeFromWaitQueue(messageId, userId) {
  const q = waitQueue[messageId];
  if (!q) return;
  const idx = q.indexOf(userId);
  if (idx !== -1) {
    q.splice(idx, 1);
    if (q.length === 0) delete waitQueue[messageId];
    saveStore().catch(err => console.error('saveStore err', err));
  }
}

function popNextWaiting(messageId) {
  const q = waitQueue[messageId];
  if (!q || q.length === 0) return null;
  const next = q.shift();
  if (q.length === 0) delete waitQueue[messageId];
  saveStore().catch(err => console.error('saveStore err', err));
  return next;
}

function isEmojiMatch(reactionEmoji) {
  return reactionEmoji === REACTION_EMOJI;
}

async function ensureGuildMember(guild, userId) {
  try {
    return await guild.members.fetch(userId);
  } catch (e) {
    console.warn('Could not fetch member', userId, e && e.message);
    return null;
  }
}

// message trigger detection per latest spec
function messageIsTrigger(message) {
  if (!message || typeof message.content !== 'string') return false;
  if (!message.mentions || !message.mentions.everyone) return false;
  const raw = message.content.trim();
  const parts = raw.split(/\s+/);
  if (parts.length !== 2) return false;
  const numToken = parts[1].trim();
  if (!/^[+-]?\d+$/.test(numToken)) return false;
  const n = Number(numToken);
  if (!Number.isInteger(n)) return false;
  if (n < MIN_NUMBER || n > MAX_NUMBER) return false;
  return true;
}

// ---------------- RESYNC FUNCTION ----------------
// Fetch recent messages in WATCH_CHANNEL_ID and update reactStore for trigger messages.
// Helps ensure reactStore has data even if bot restarted while reactions happened.
async function resyncRecentMessages() {
  try {
    if (!WATCH_CHANNEL_ID) return;
    const ch = await client.channels.fetch(WATCH_CHANNEL_ID).catch(()=>null);
    if (!ch || !ch.isTextBased || typeof ch.messages?.fetch !== 'function') return;
    const fetched = await ch.messages.fetch({ limit: 200 });
    const toSet = {};
    for (const [, msg] of fetched) {
      try {
        if (!messageIsTrigger(msg)) continue;
        const reaction = msg.reactions.cache.get(REACTION_EMOJI) || msg.reactions.cache.find(r => r.emoji.name === REACTION_EMOJI);
        if (!reaction) {
          // ensure no stale entry
          if (reactStore[msg.id]) delete reactStore[msg.id];
          continue;
        }
        let users;
        try {
          users = await reaction.users.fetch();
        } catch (e) {
          users = reaction.users.cache;
        }
        const realUsers = users.filter(u => !u.bot).map(u => u.id);
        if (realUsers.length > 0) {
          toSet[msg.id] = realUsers;
        } else if (reactStore[msg.id]) {
          delete reactStore[msg.id];
        }
      } catch (e) {
        console.warn('resync message error', e && e.message);
      }
    }
    // apply collected sets
    for (const [mid, arr] of Object.entries(toSet)) {
      reactStore[mid] = new Set(arr);
    }
    await saveStore();
    console.log('Resync complete. Stored messages:', Object.keys(toSet).length);
  } catch (e) {
    console.error('resyncRecentMessages failed', e && e.message);
  }
}

// ---------------- EVENTS ----------------

client.once('ready', async () => {
  await loadStore();
  await resyncRecentMessages(); // ensure store up-to-date on start
  console.log(`Bot ready â€” ${client.user.tag}`);
  console.log(`Watching channel ${WATCH_CHANNEL_ID}; allowed numbers ${MIN_NUMBER}-${MAX_NUMBER}; cap ${REACTION_CAP}`);
});

// Auto-react: only when message in WATCH_CHANNEL_ID and messageIsTrigger returns true
client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return;
    if (WATCH_CHANNEL_ID && String(message.channel.id) !== String(WATCH_CHANNEL_ID)) return;
    if (!messageIsTrigger(message)) return;
    await message.react(REACTION_EMOJI).catch(() => {});
  } catch (e) {
    console.error('messageCreate error', e);
  }
});

// Reaction add: handle grant or waiting queue; now store full reactor set
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (reaction.partial) {
      try { await reaction.fetch(); } catch (e) { return; }
    }
    if (user.partial) {
      try { await user.fetch(); } catch (e) { return; }
    }
    if (user.bot) return;

    const emojiIdOrChar = reaction.emoji.id ? reaction.emoji.id : reaction.emoji.name;
    if (!isEmojiMatch(emojiIdOrChar)) return;

    const message = reaction.message;
    if (!message.guild) return;
    if (WATCH_CHANNEL_ID && String(message.channel.id) !== String(WATCH_CHANNEL_ID)) return;
    if (!messageIsTrigger(message)) return;

    // fetch all reactors to count (most accurate)
    let users;
    try {
      users = await reaction.users.fetch();
    } catch (e) {
      users = reaction.users.cache;
    }
    const realUsers = users.filter(u => !u.bot);
    const count = realUsers.size;

    // If over cap, remove this user's reaction and put them in the queue (and DM)
    if (count > REACTION_CAP) {
      try { await reaction.users.remove(user.id); } catch (err) { console.warn('Failed to remove reaction:', err && err.message); }
      try { await user.send(`âŒ ÄĂ£ Ä‘áº¡t giá»›i háº¡n (${REACTION_CAP}). Báº¡n Ä‘Ă£ Ä‘Æ°á»£c Ä‘Æ°a vĂ o hĂ ng chá».\nâ³ Vui lĂ²ng Ä‘á»£i ngÆ°á»i khĂ¡c bá» react â€” bot sáº½ bĂ¡o báº¡n khi cĂ³ slot trá»‘ng.`).catch(()=>{}); } catch(e){}
      pushToWaitQueue(message.id, user.id);
      // Update stored set to exclude this user (since we removed)
      const remaining = realUsers.map(u => u.id).filter(id => id !== user.id);
      setReactStoreFromArray(message.id, remaining);
      return;
    }

    // User within cap: grant role if needed
    const member = await ensureGuildMember(message.guild, user.id);
    if (member) {
      const role = message.guild.roles.cache.get(ACCESS_ROLE_ID);
      if (role && !member.roles.cache.has(role.id)) {
        try {
          await member.roles.add(role, 'Granted by reaction gate');
          await member.send('Báº¡n Ä‘Ă£ Ä‘Æ°á»£c cáº¥p quyá»n xem kĂªnh.').catch(()=>{});
        } catch (err) {
          console.error('Error adding role:', err && err.message);
        }
      }
    }

    // store full current reactor set for the message
    const ids = realUsers.map(u => u.id);
    setReactStoreFromArray(message.id, ids);

  } catch (err) {
    console.error('messageReactionAdd error', err && err.message);
  }
});

// Reaction remove: revoke role and notify waiting user; update store from current reaction.users if possible
client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (reaction.partial) {
      try { await reaction.fetch(); } catch (e) { return; }
    }
    if (user.partial) {
      try { await user.fetch(); } catch (e) { return; }
    }
    if (user.bot) return;

    const emojiIdOrChar = reaction.emoji.id ? reaction.emoji.id : reaction.emoji.name;
    if (!isEmojiMatch(emojiIdOrChar)) return;

    const message = reaction.message;
    if (!message.guild) return;
    if (WATCH_CHANNEL_ID && String(message.channel.id) !== String(WATCH_CHANNEL_ID)) return;
    if (!messageIsTrigger(message)) {
      // clean store entry if exists
      removeFromReactStore(message.id, user.id);
      return;
    }

    // Revoke role from the user who removed their reaction
    const member = await ensureGuildMember(message.guild, user.id);
    if (member) {
      const role = message.guild.roles.cache.get(ACCESS_ROLE_ID);
      if (role && member.roles.cache.has(role.id)) {
        try {
          await member.roles.remove(role, 'Reaction removed - revoke access');
          await member.send('Quyá»n xem Ä‘Ă£ bá»‹ thu khi báº¡n bá» reaction.').catch(()=>{});
        } catch (err) {
          console.error('Failed to remove role on reaction remove:', err && err.message);
        }
      }
    }

    // Update stored reactor list from current reaction.users
    let users;
    try {
      users = await reaction.users.fetch();
    } catch (e) {
      users = reaction.users.cache;
    }
    const realUsers = users.filter(u => !u.bot).map(u => u.id);
    setReactStoreFromArray(message.id, realUsers);

    // Notify next waiting user (FIFO)
    const nextWaitingId = popNextWaiting(message.id);
    if (nextWaitingId) {
      try {
        const nextUser = await client.users.fetch(nextWaitingId).catch(()=>null);
        if (nextUser) {
          await nextUser.send('âœ… ÄĂ£ cĂ³ slot trá»‘ng! Vui lĂ²ng react láº¡i vĂ o tin nháº¯n Ä‘á»ƒ nháº­n quyá»n.').catch(()=>{});
        }
      } catch (e) {
        console.error('Failed to notify waiting user:', e && e.message);
      }
    }

  } catch (err) {
    console.error('messageReactionRemove error', err && err.message);
  }
});

// Message deleted: revoke roles for all who had been granted (from store or reactions), notify waiting users and cleanup
client.on('messageDelete', async (message) => {
  try {
    if (!message) return;
    if (!message.guild) return;
    if (WATCH_CHANNEL_ID && String(message.channel?.id) !== String(WATCH_CHANNEL_ID)) return;

    console.log('messageDelete handling:', message.id);

    const userIdSet = new Set();

    // 1) from persistent store
    const stored = reactStore[message.id];
    if (stored && stored.size) {
      for (const uid of stored) userIdSet.add(uid);
    }

    // 2) from message.reactions cache (best-effort, if cached)
    try {
      if (message.reactions && message.reactions.cache.size > 0) {
        for (const [, reaction] of message.reactions.cache) {
          const emojiIdOrChar = reaction.emoji.id ? reaction.emoji.id : reaction.emoji.name;
          if (!isEmojiMatch(emojiIdOrChar)) continue;
          let users;
          try {
            users = await reaction.users.fetch();
          } catch (e) {
            users = reaction.users.cache;
          }
          for (const [, u] of users) {
            if (u.bot) continue;
            userIdSet.add(u.id);
          }
        }
      }
    } catch (e) {
      console.warn('Error collecting reactors from message.reactions.cache', e && e.message);
    }

    // Notify waiting users that the message was deleted (their queue removed)
    const wq = waitQueue[message.id] || [];
    if (wq.length) {
      for (const uid of wq) {
        try {
          const u = await client.users.fetch(uid).catch(()=>null);
          if (u) {
            await u.send('Tin nháº¯n Ä‘Ă£ bá»‹ xĂ³a â€” hĂ ng chá» cá»§a báº¡n Ä‘Ă£ bá»‹ há»§y.').catch(()=>{});
          }
        } catch (e) {}
      }
    }

    if (userIdSet.size === 0) {
      console.log(`messageDelete: no reactors for message ${message.id}`);
      if (reactStore[message.id]) delete reactStore[message.id];
      if (waitQueue[message.id]) delete waitQueue[message.id];
      await saveStore().catch(()=>{});
      return;
    }

    // Revoke role for each user found
    const guild = message.guild;
    const role = guild.roles.cache.get(ACCESS_ROLE_ID);
    if (!role) {
      console.error('ACCESS_ROLE_ID not found; abort revoke.');
      return;
    }

    for (const uid of userIdSet) {
      try {
        const member = await ensureGuildMember(guild, uid);
        if (!member) continue;
        if (member.roles.cache.has(role.id)) {
          await member.roles.remove(role, `Message ${message.id} deleted - revoke access`);
          await member.send('Tin nháº¯n báº¡n Ä‘Ă£ react bá»‹ xĂ³a â†’ quyá»n xem Ä‘Ă£ bá»‹ thu.').catch(()=>{});
        }
      } catch (e) {
        console.error('Failed to revoke role for user', uid, e && e.message);
      }
    }

    // cleanup store & queue
    if (reactStore[message.id]) delete reactStore[message.id];
    if (waitQueue[message.id]) delete waitQueue[message.id];
    await saveStore().catch(()=>{});

    console.log(`messageDelete: revoked for ${userIdSet.size} users for message ${message.id}`);

  } catch (err) {
    console.error('messageDelete handler error', err && err.message);
  }
});

// graceful shutdown: persist store
process.on('SIGINT', async () => {
  await saveStore();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await saveStore();
  process.exit(0);
});

// Login
client.login(DISCORD_TOKEN).catch(err => {
  console.error('Failed to login â€” check token', err && err.message);
});
