import express from "express";
import pkg from "@slack/bolt";
import pkgPg from "pg";

const { App, ExpressReceiver } = pkg;
const { Pool } = pkgPg;

// ----------------------
// Setup Postgres
// ----------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // needed for Render Postgres
});

// Ensure table exists
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS routed_messages (
      id SERIAL PRIMARY KEY,
      slack_ts TEXT UNIQUE,
      channel_id TEXT,
      routed_at TIMESTAMP DEFAULT NOW()
    );
  `);
})();

// ----------------------
// Setup Express + Slack Bolt
// ----------------------
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// ----------------------
// Helper: Check if already routed
// ----------------------
async function alreadyRouted(slackTs) {
  const res = await pool.query(
    "SELECT 1 FROM routed_messages WHERE slack_ts=$1",
    [slackTs]
  );
  return res.rowCount > 0;
}

async function markRouted(slackTs, channelId) {
  await pool.query(
    "INSERT INTO routed_messages(slack_ts, channel_id) VALUES ($1, $2) ON CONFLICT (slack_ts) DO NOTHING",
    [slackTs, channelId]
  );
}

// ----------------------
// HappyFox → Slack routing
// ----------------------
receiver.router.post("/happyfox", async (req, res) => {
  try {
    const { subject, emails, text, slackTs, channel } = req.body;

    if (!slackTs) {
      console.warn("No slackTs provided in webhook payload");
      return res.status(400).send("Missing slackTs");
    }

    // Skip if already routed
    if (await alreadyRouted(slackTs)) {
      console.log(`Skipping duplicate route for ${slackTs}`);
      return res.json({ status: "duplicate" });
    }

    let dmUsers = [];
    let notFound = [];

    for (const email of emails) {
      try {
        const userInfo = await app.client.users.lookupByEmail({
          email,
          token: process.env.SLACK_BOT_TOKEN,
        });

        if (userInfo.ok && userInfo.user) {
          // Open a DM channel
          const imRes = await app.client.conversations.open({
            users: userInfo.user.id,
            token: process.env.SLACK_BOT_TOKEN,
          });

          // Send DM
          const dmRes = await app.client.chat.postMessage({
            channel: imRes.channel.id,
            text: `📩 You received a routed message:\n*Subject:* ${subject}\n\n${text}`,
            token: process.env.SLACK_BOT_TOKEN,
          });

          dmUsers.push({ email, userId: userInfo.user.id, dmTs: dmRes.ts });
        } else {
          notFound.push(email);
        }
      } catch (err) {
        console.error(`Error routing to ${email}:`, err.data || err.message);
        notFound.push(email);
      }
    }

    // Mark as routed
    await markRouted(slackTs, channel);

    // Log back in the original Slack channel/thread
    await app.client.chat.postMessage({
      channel,
      thread_ts: slackTs,
      text: `:white_check_mark: Routed message to: ${dmUsers
        .map((u) => `<@${u.userId}>`)
        .join(", ")}${
        notFound.length ? `\n:warning: Not found in Slack: ${notFound.join(", ")}` : ""
      }`,
      token: process.env.SLACK_BOT_TOKEN,
    });

    res.json({ status: "ok", dmUsers, notFound });
  } catch (err) {
    console.error("Webhook handler error:", err);
    res.status(500).send("Internal error");
  }
});

// ----------------------
// Start server
// ----------------------
const port = process.env.PORT || 10000;
receiver.app.listen(port, () => {
  console.log(`🌍 Web service running on port ${port}`);
});

app.start();
