import "dotenv/config";
import express from "express";
import path from "node:path";
import { validateSignature, handleWebhook } from "./line.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Serve audio files for TTS (LINE ต้องการ public URL สำหรับ audio message)
app.use("/audio", express.static(path.resolve("./data/audio")));

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "MyClaw is running" });
});

// LINE webhook endpoint — ใช้ raw body เพื่อ validate signature เอง
app.post("/webhook", express.raw({ type: "*/*" }), (req, res) => {
  const signature = req.headers["x-line-signature"] as string;
  const body = req.body as Buffer;

  console.log(`[WEBHOOK] received, signature: ${signature ? "yes" : "NO"}, body: ${body.length} bytes`);

  // Auto-detect BASE_URL จาก webhook request (ทำงานกับ ngrok/reverse proxy อัตโนมัติ)
  if (!process.env.BASE_URL) {
    const host = (req.headers["x-forwarded-host"] as string) || req.headers.host;
    if (host) {
      const proto = (req.headers["x-forwarded-proto"] as string) || "https";
      process.env.BASE_URL = `${proto}://${host}`;
      console.log(`[SERVER] Auto-detected BASE_URL: ${process.env.BASE_URL}`);
    }
  }

  if (!signature || !validateSignature(body, signature)) {
    console.log("[WEBHOOK] signature validation failed — ignoring");
    res.sendStatus(200); // ตอบ 200 เสมอ ไม่งั้น LINE จะ retry
    return;
  }

  const parsed = JSON.parse(body.toString());
  handleWebhook(parsed.events).catch(console.error);
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════╗
  ║     🦞 MyClaw Mini v1.0.0       ║
  ║     LINE + Claude AI Bot         ║
  ║     Port: ${String(PORT).padEnd(23)}║
  ║     Webhook: /webhook            ║
  ╚══════════════════════════════════╝
  `);
});
