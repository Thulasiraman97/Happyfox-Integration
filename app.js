// app.js
require("dotenv").config();
const { App } = require("@slack/bolt");
const express = require("express");
const { Pool } = require("pg");

// ------------------ Slack Bot Setup ------------------
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// ------------------ PostgreSQL Setup ------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Init DB table
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_map (
      channel_ts TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      dms JSONB NOT NULL,
      not_found JSONB
    )
  `);
}
initDB();

// Save mapping
async function saveMapping(channelTs, channelId, dms, notFound) {
  await pool.query(
    `INSERT INTO message_map (channel_ts, channel_id, dms, not_found)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (channel_ts)
     DO UPDATE SET dms = EXCLUDED.dms, not_found = EXCLUDED.not_found`,
    [channelTs, channelId, JSON.stringify(dms), JSON.stringify(notFound)]
  );
}

// Get mapping
async function getMapping(channelTs) {
  const result = await pool.query(
    "SELECT * FROM message_map WHERE channel_ts = $1",
    [channelTs]
  );
  return result.rows[0] || null;
}

// ------------------ Helpers ------------------
const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;

function extractRecipientEmails(text) {
  const match = text.match(/Email Recipients\s*([\s\S]*?)\s*Email Subject/i);
  if (!match) return [];
  const recipientsBlock = match[1];
  const emails = recipientsBlock.match(emailRegex) || [];
  return [...new Set(emails.map(e => e.toLowerCase()))];
}

// ------------------ Route channel messages to DMs ------------------
slackApp.message(async ({ message, client, say }) => {
  if (!message.text || message.subtype === "bot_message") return;

  const emails = extractRecipientEmails(message.text);
  if (emails.length === 0) return;

  let dmUsers = [];
  let notFound = [];

  for (const email of emails) {
    try {
      const userInfo = await client.users.lookupByEmail({ email });
      if (userInfo.ok && userInfo.user) {
        const dmRes = await client.chat.postMessage({
          channel: userInfo.user.id,
          text: `📩 You received a routed message from <#${message.channel}>:\n\n${message.text}`,
        });
        dmUsers.push({ userId: userInfo.user.id, dmTs: dmRes.ts });
      } else {
        notFound.push(email);
      }
    } catch {
      notFound.push(email);
    }
  }

  if (dmUsers.length > 0) {
    await saveMapping(message.ts, message.channel, dmUsers, notFound);
    await say(`✅ Routed message to: ${dmUsers.map(d => `<@${d.userId}>`).join(", ")}`);
  }
  if (notFound.length > 0) {
    await say(`⚠️ Not found in Slack: ${[...new Set(notFound)].join(", ")}`);
  }
});

// ------------------ Handle thread replies + notifications ------------------
slackApp.event("message", async ({ event, client }) => {
  if (!event.thread_ts || event.subtype === "bot_message") return;

  let channelThreadTs = null;
  let dmThreadTs = null;
  let mapping = await getMapping(event.thread_ts);

  if (mapping) {
    channelThreadTs = mapping.channel_ts;
  } else {
    // Search inside all mappings for matching DM
    const res = await pool.query("SELECT * FROM message_map");
    for (const row of res.rows) {
      const dms = row.dms;
      const found = dms.find(d => d.dmTs === event.thread_ts);
      if (found) {
        channelThreadTs = row.channel_ts;
        dmThreadTs = found.dmTs;
        mapping = row;
        break;
      }
    }
  }
  if (!channelThreadTs || !mapping) return;

  const userInfo = await client.users.info({ user: event.user });
  const fullName = userInfo.user.real_name || userInfo.user.name;
  const isChannelReply = event.channel === mapping.channel_id;
  const isDmReply = !isChannelReply;

  let permalink;
  try {
    const linkRes = await client.chat.getPermalink({
      channel: mapping.channel_id,
      message_ts: isChannelReply ? event.ts : channelThreadTs,
    });
    permalink = linkRes.permalink;
  } catch {
    permalink = null;
  }

  const dms = mapping.dms;

  if (isChannelReply) {
    for (const dm of dms) {
      await client.chat.postMessage({
        channel: dm.userId,
        thread_ts: dm.dmTs,
        text: `💬 *${fullName}*: ${event.text}`,
      });
    }
    await client.chat.postMessage({
      channel: mapping.channel_id,
      text: `🔔 *${fullName}* replied in thread — <${permalink}|View reply>`,
    });
  } else {
    for (const dm of dms) {
      if (dm.dmTs !== dmThreadTs) {
        await client.chat.postMessage({
          channel: dm.userId,
          thread_ts: dm.dmTs,
          text: `💬 *${fullName}*: ${event.text}`,
        });
      }
    }
    await client.chat.postMessage({
      channel: mapping.channel_id,
      thread_ts: channelThreadTs,
      text: `💬 *${fullName}*: ${event.text}`,
    });
    await client.chat.postMessage({
      channel: mapping.channel_id,
      text: `🔔 *${fullName}* replied in DM — <${permalink}|View in channel>`,
    });
  }
});

// ------------------ Start Slack App ------------------
(async () => {
  await slackApp.start();
  console.log("⚡ HappyFox Slack app running with Postgres persistence");
})();

// ------------------ Express Keep-Alive Server (Render) ------------------
const server = express();
const PORT = process.env.PORT || 3000;
server.get("/", (req, res) => {
  res.send("✅ HappyFox Slack Bot is running on Render with Postgres!");
});
server.listen(PORT, () => {
  console.log(`🌍 Web service running on port ${PORT}`);
});
