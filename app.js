require("dotenv").config();
const { App } = require("@slack/bolt");
const express = require("express");
const { Pool } = require("pg");

// ------------------ Slack Bot Setup ------------------
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN, // Required for Socket Mode
  socketMode: true,
});

// ------------------ Postgres Setup ------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_mappings (
      channel_ts TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      dms JSONB NOT NULL,
      not_found JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
})();

async function saveMessageMapping(channelTs, channelId, dms, notFound) {
  await pool.query(
    `
    INSERT INTO message_mappings (channel_ts, channel_id, dms, not_found)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (channel_ts)
    DO UPDATE SET dms = $3, not_found = $4, channel_id = $2
    `,
    [channelTs, channelId, JSON.stringify(dms), JSON.stringify(notFound)]
  );
}

async function getMapping(channelTs) {
  const res = await pool.query(
    `SELECT * FROM message_mappings WHERE channel_ts = $1`,
    [channelTs]
  );
  return res.rows[0];
}

async function findMappingByDmThread(dmTs) {
  const res = await pool.query(`SELECT * FROM message_mappings`);
  for (const row of res.rows) {
    const dms = row.dms;
    if (Array.isArray(dms)) {
      const found = dms.find((d) => d.dmTs === dmTs);
      if (found) {
        return { ...row, dmThreadTs: found.dmTs };
      }
    }
  }
  return null;
}

// ------------------ Helpers ------------------
const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;

function extractRecipientEmails(text) {
  const match = text.match(/Email Recipients\s*([\s\S]*?)\s*Email Subject/i);
  if (!match) return [];
  const recipientsBlock = match[1];
  const emails = recipientsBlock.match(emailRegex) || [];
  return [...new Set(emails.map((e) => e.toLowerCase()))];
}

// Extract subject (line between Email Subject and Email Content)
function extractEmailSubject(text) {
  const subjectMatch = text.match(/Email Subject\s*([\s\S]*?)Email Content/i);
  return subjectMatch ? subjectMatch[1].trim() : "N/A";
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
    await saveMessageMapping(message.ts, message.channel, dmUsers, notFound);
    await say(`✅ Routed message to: ${dmUsers.map((d) => `<@${d.userId}>`).join(", ")}`);
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

  const mapping = await getMapping(event.thread_ts);
  if (mapping) {
    channelThreadTs = mapping.channel_ts;
  } else {
    const found = await findMappingByDmThread(event.thread_ts);
    if (found) {
      channelThreadTs = found.channel_ts;
      dmThreadTs = found.dmThreadTs;
    }
  }
  if (!channelThreadTs) return;

  const mappingRow = await getMapping(channelThreadTs);
  if (!mappingRow) return;

  const dms = mappingRow.dms;
  const userInfo = await client.users.info({ user: event.user });
  const fullName = userInfo.user.real_name || userInfo.user.name;

  const isChannelReply = event.channel === mappingRow.channel_id;
  const isDmReply = !isChannelReply;

  // Get original channel message
  let originalMsg;
  try {
    const history = await client.conversations.history({
      channel: mappingRow.channel_id,
      latest: channelThreadTs,
      inclusive: true,
      limit: 1,
    });
    originalMsg = history.messages && history.messages[0];
  } catch {
    originalMsg = null;
  }

  const emailSubject = originalMsg ? extractEmailSubject(originalMsg.text) : "N/A";

  // Always get permalink
  let permalink;
  try {
    const linkRes = await client.chat.getPermalink({
      channel: mappingRow.channel_id,
      message_ts: channelThreadTs,
    });
    permalink = linkRes.permalink;
  } catch {
    permalink = null;
  }

  const notifyChannel = process.env.NOTIFY_CHANNEL_ID; // private channel ID

  // Build notification text (Email Subject + Reply + Link)
  const notifyText =
    `📧 *Ticket: * ${emailSubject}\n` +
    `💬 *${fullName} replied:* ${event.text}\n` +
    (permalink ? `🔗 <${permalink}|View full thread>` : "");

  // Send notification to private channel
  await client.chat.postMessage({
    channel: notifyChannel,
    text: notifyText,
  });

  // Mirror replies as before
  if (isChannelReply) {
    for (const dm of dms) {
      await client.chat.postMessage({
        channel: dm.userId,
        thread_ts: dm.dmTs,
        text: `💬 *${fullName}*: ${event.text}`,
      });
    }
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
      channel: mappingRow.channel_id,
      thread_ts: channelThreadTs,
      text: `💬 *${fullName}*: ${event.text}`,
    });
  }
});

// ------------------ Start Slack App ------------------
(async () => {
  await slackApp.start();
  console.log("⚡ HappyFox Slack app running with Postgres persistence (Socket Mode)");
})();

// ------------------ Express Keep-Alive Server (Render) ------------------
const server = express();
const PORT = process.env.PORT || 3000;

server.get("/", (req, res) => {
  res.send("✅ HappyFox Slack Bot is running on Render!");
});

server.listen(PORT, () => {
  console.log(`🌍 Web service running on port ${PORT}`);
});
