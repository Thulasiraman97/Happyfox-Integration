// app.js
require("dotenv").config();
const { App } = require("@slack/bolt");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Regex for emails
const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;

/*
  messageMap structure:
  {
    "<channelMsgTs>": {
       channel: "C12345",
       dms: [ { userId: "U111", dmTs: "1620..." }, ... ],
       notFound: [ "a@b.com" ]
    }
  }
*/
let messageMap = {};

// -------- Extract ONLY from "Email Recipients" section --------
function extractRecipientEmails(text) {
  // Find text between "Email Recipients" and "Email Subject"
  const match = text.match(/Email Recipients\s*([\s\S]*?)\s*Email Subject/i);
  if (!match) return [];

  const recipientsBlock = match[1];
  const emails = recipientsBlock.match(emailRegex) || [];
  return [...new Set(emails.map(e => e.toLowerCase()))]; // unique + lowercase
}

// ----------- Route channel messages to DMs -----------
app.message(async ({ message, client, say }) => {
  if (!message.text || message.subtype === "bot_message") return;

  // Use new extractor
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
          text: `📩 You received a routed message from <#${message.channel}>:\n\n${message.text}`
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
    messageMap[message.ts] = { channel: message.channel, dms: dmUsers, notFound };
    await say(`✅ Routed message to: ${dmUsers.map(d => `<@${d.userId}>`).join(", ")}`);
  }
  if (notFound.length > 0) {
    await say(`⚠️ Not found in Slack: ${[...new Set(notFound)].join(", ")}`);
  }
});

// ----------- Handle thread replies + notifications -----------
app.event("message", async ({ event, client }) => {
  if (!event.thread_ts || event.subtype === "bot_message") return;

  let channelThreadTs = null;
  let dmThreadTs = null;

  // Check if reply is in channel
  if (messageMap[event.thread_ts]) {
    channelThreadTs = event.thread_ts;
  } else {
    // Or in DM
    for (const [chanTs, mapping] of Object.entries(messageMap)) {
      const found = mapping.dms.find(d => d.dmTs === event.thread_ts);
      if (found) {
        channelThreadTs = chanTs;
        dmThreadTs = found.dmTs;
        break;
      }
    }
  }
  if (!channelThreadTs) return;

  const mapping = messageMap[channelThreadTs];
  const userInfo = await client.users.info({ user: event.user });
  const fullName = userInfo.user.real_name || userInfo.user.name;

  const isChannelReply = (event.channel === mapping.channel);
  const isDmReply = !isChannelReply;

  // Always get permalink for the reply (in channel)
  let permalink;
  try {
    const linkRes = await client.chat.getPermalink({
      channel: mapping.channel,
      message_ts: isChannelReply ? event.ts : channelThreadTs
    });
    permalink = linkRes.permalink;
  } catch {
    permalink = null;
  }

  if (isChannelReply) {
    // Mirror channel reply → all DMs
    for (const dm of mapping.dms) {
      await client.chat.postMessage({
        channel: dm.userId,
        thread_ts: dm.dmTs,
        text: `💬 *${fullName}*: ${event.text}`
      });
    }

    // Post top-level notification in channel
    await client.chat.postMessage({
      channel: mapping.channel,
      text: `🔔 *${fullName}* replied in thread — <${permalink}|View reply>`
    });

  } else {
    // Mirror DM reply → other DMs
    for (const dm of mapping.dms) {
      if (dm.dmTs !== dmThreadTs) {
        await client.chat.postMessage({
          channel: dm.userId,
          thread_ts: dm.dmTs,
          text: `💬 *${fullName}*: ${event.text}`
        });
      }
    }

    // Also mirror DM reply into channel thread
    await client.chat.postMessage({
      channel: mapping.channel,
      thread_ts: channelThreadTs,
      text: `💬 *${fullName}*: ${event.text}`
    });

    // Top-level notification in channel
    await client.chat.postMessage({
      channel: mapping.channel,
      text: `🔔 *${fullName}* replied in DM — <${permalink}|View in channel>`
    });
  }
});

// Start app
(async () => {
  await app.start();
  console.log("⚡ HappyFox Slack app running with Email Recipients filtering");
})();
