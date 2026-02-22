import crypto from "crypto";
import {
  messagingApi,
  type WebhookEvent,
  type MessageEvent,
  type TextEventMessage,
  type StickerEventMessage,
  type LocationEventMessage,
  type FileEventMessage,
} from "@line/bot-sdk";
import { chat, type ChatResult } from "./ai.js";
import { downloadLineMedia, type MediaData } from "./media.js";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
};

export const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

// Validate LINE signature (HMAC-SHA256) — แบบเดียวกับ OpenClaw
export function validateSignature(body: Buffer, signature: string): boolean {
  const hash = crypto
    .createHmac("SHA256", config.channelSecret)
    .update(body)
    .digest("base64");
  const hashBuffer = Buffer.from(hash);
  const signatureBuffer = Buffer.from(signature);
  if (hashBuffer.length !== signatureBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, signatureBuffer);
}

// Sticker package names (จาก OpenClaw)
const STICKER_PACKAGES: Record<string, string> = {
  "1": "Moon & James",
  "2": "Cony & Brown",
  "3": "Brown & Friends",
  "4": "Moon Special",
  "789": "LINE Characters",
  "6136": "Cony's Happy Life",
  "6325": "Brown's Life",
  "6359": "Choco",
  "6362": "Sally",
  "6370": "Edward",
  "11537": "Cony",
  "11538": "Brown",
  "11539": "Moon",
};

// ===== Strip Markdown (LINE ไม่ render markdown) =====

function stripMarkdown(text: string): string {
  return text
    // ```code block``` → เอาแค่เนื้อข้างใน
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, "").trim())
    // ### heading → heading (ลบ # ต้นบรรทัด)
    .replace(/^#{1,6}\s+/gm, "")
    // > blockquote → เนื้อหา
    .replace(/^>\s+/gm, "")
    // --- หรือ *** (horizontal rule) → ลบ
    .replace(/^[-*_]{3,}\s*$/gm, "")
    // ***bold italic*** → bold italic
    .replace(/\*{3}([^*]+?)\*{3}/g, "$1")
    // **bold** → bold (รองรับข้ามบรรทัด)
    .replace(/\*{2}([\s\S]+?)\*{2}/g, "$1")
    // *italic* → italic (ไม่แตะ * bullet list ที่ขึ้นต้นบรรทัด)
    .replace(/(?<=\S)\*([^*\n]+)\*(?=\S|$)/g, "$1")
    .replace(/(?<=^|[^*])\*([^*\s][^*\n]*[^*\s])\*(?=[^*]|$)/gm, "$1")
    // [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // `inline code` → code
    .replace(/`([^`]+)`/g, "$1")
    // ลบบรรทัดว่างซ้ำ (เกิน 2 → เหลือ 2)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ===== Reply Splitter (ตัดตรงจุดที่เหมาะสม) =====

function splitReply(text: string, maxChars = 5000, maxMessages = 5): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0 && chunks.length < maxMessages) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    // หาจุดตัดที่ดีที่สุดภายใน maxChars (ลำดับ: หัวข้อ → บรรทัดว่าง → ขึ้นบรรทัดใหม่)
    const window = remaining.substring(0, maxChars);
    let cutAt = -1;

    // 1. หาหัวข้อที่ขึ้นต้นด้วย ** หรือ # (markdown heading) — ตัดก่อนหัวข้อ
    const headingMatch = window.match(/\n(?=\*\*|#{1,3} )/g);
    if (headingMatch) {
      cutAt = window.lastIndexOf(headingMatch[headingMatch.length - 1]);
    }

    // 2. ถ้าไม่เจอหัวข้อ → หาบรรทัดว่าง (\n\n)
    if (cutAt < maxChars * 0.3) {
      const doubleNewline = window.lastIndexOf("\n\n");
      if (doubleNewline > maxChars * 0.3) cutAt = doubleNewline;
    }

    // 3. ถ้าไม่เจอบรรทัดว่าง → หา \n ธรรมดา
    if (cutAt < maxChars * 0.3) {
      const singleNewline = window.lastIndexOf("\n");
      if (singleNewline > maxChars * 0.3) cutAt = singleNewline;
    }

    // 4. fallback: ตัดที่ maxChars
    if (cutAt < maxChars * 0.3) cutAt = maxChars;

    chunks.push(remaining.substring(0, cutAt).trimEnd());
    remaining = remaining.substring(cutAt).trimStart();
  }

  return chunks;
}

// ===== Message Processing (เหมือน OpenClaw: รับทุกประเภท) =====

interface ProcessedMessage {
  text: string;
  media?: MediaData;
}

async function processMessage(event: MessageEvent): Promise<ProcessedMessage | null> {
  const message = event.message;

  switch (message.type) {
    case "text":
      return { text: (message as TextEventMessage).text };

    case "image": {
      try {
        const media = await downloadLineMedia(message.id, config.channelAccessToken);
        console.log(`[LINE] Downloaded image: ${media.mimeType} (${media.size} bytes)`);
        return { text: "[User sent an image — briefly describe what you see, then ask if they need anything else]", media };
      } catch (err) {
        console.error("[LINE] Image download failed:", err);
        return { text: "[User sent an image that could not be downloaded]" };
      }
    }

    case "video": {
      try {
        const media = await downloadLineMedia(message.id, config.channelAccessToken, undefined, "video/mp4");
        console.log(`[LINE] Downloaded video: ${media.mimeType} (${media.size} bytes)`);
        return { text: `[User sent a video. Do these steps:
1. Briefly describe what you see in the video.
2. If there is speech/dialogue, transcribe it, then clean up: remove filler words, fix broken sentences, rewrite to read naturally while keeping ALL original meaning and details intact.
3. Present the cleaned-up version — do NOT show raw transcription, do NOT add a summary.]`, media };
      } catch (err) {
        console.error("[LINE] Video download failed:", err);
        return { text: "[User sent a video that could not be downloaded]" };
      }
    }

    case "audio": {
      try {
        const media = await downloadLineMedia(message.id, config.channelAccessToken, undefined, "audio/mp4");
        console.log(`[LINE] Downloaded audio: ${media.mimeType} (${media.size} bytes)`);
        return { text: `[User sent an audio message. Do these steps IN ORDER:
1. Transcribe everything said in the audio, preserving the original language.
2. Clean up the transcription: remove filler words (เอ่อ, อ้า, um, uh), fix repeated/broken sentences, and rewrite to read naturally while keeping ALL original meaning and details intact.
3. Present ONLY the cleaned-up version to the user — do NOT show the raw transcription, do NOT add a summary.]`, media };
      } catch (err) {
        console.error("[LINE] Audio download failed:", err);
        return { text: "[User sent an audio message that could not be downloaded]" };
      }
    }

    case "sticker": {
      const sticker = message as StickerEventMessage;
      const packageName = STICKER_PACKAGES[sticker.packageId] ?? "sticker";
      const keywords = sticker.keywords?.slice(0, 3).join(", ") || sticker.text || "";
      return keywords
        ? { text: `[Sent a ${packageName} sticker: ${keywords}]` }
        : { text: `[Sent a ${packageName} sticker]` };
    }

    case "location": {
      const loc = message as LocationEventMessage;
      const parts = [loc.title, loc.address].filter(Boolean);
      const coords = `${loc.latitude}, ${loc.longitude}`;
      return parts.length > 0
        ? { text: `📍 ${parts.join(" — ")} (${coords})` }
        : { text: `📍 ${coords}` };
    }

    case "file": {
      const file = message as FileEventMessage;
      return { text: `[User sent a file: ${file.fileName} (${file.fileSize} bytes)]` };
    }

    default:
      return null;
  }
}

// จัดการ webhook events จาก LINE
export async function handleWebhook(events: WebhookEvent[]): Promise<void> {
  for (const event of events) {
    if (event.type !== "message") continue;

    const userId = event.source.userId;
    const replyToken = event.replyToken;
    if (!userId || !replyToken) continue;

    const processed = await processMessage(event);
    if (!processed) continue;

    console.log(`[LINE] ${userId}: ${processed.text.substring(0, 100)}`);

    try {
      // แสดง loading animation ระหว่างรอ AI ตอบ (แสดงนาน 60 วินาที)
      await lineClient.showLoadingAnimation({ chatId: userId, loadingSeconds: 60 }).catch(() => {});

      // ส่งข้อความไป AI แล้วรอคำตอบ (do-until loop อยู่ข้างใน)
      const result = await chat(userId, processed.text, processed.media);

      console.log(`[AI] → ${result.text.substring(0, 100)}...`);

      // สร้าง messages สำหรับ reply
      const messages: Array<{ type: string; text?: string; originalContentUrl?: string; previewImageUrl?: string; duration?: number }> = [];

      // ถ้ามี image จาก message tool → ส่งเป็น image message
      if (result.imageUrl) {
        console.log(`[LINE] Sending image: ${result.imageUrl}`);
        messages.push({
          type: "image",
          originalContentUrl: result.imageUrl,
          previewImageUrl: result.imageUrl,
        });
      }

      // ถ้ามี audio จาก TTS → ส่งเป็น audio message
      if (result.audioUrl) {
        console.log(`[LINE] Sending audio: ${result.audioUrl} (${result.audioDuration}ms)`);
        messages.push({
          type: "audio",
          originalContentUrl: result.audioUrl,
          duration: result.audioDuration || 5000,
        });
      }

      // ส่งคำตอบ text กลับ LINE (strip markdown → แบ่งตรงจุดที่เหมาะสม)
      const chunks = splitReply(stripMarkdown(result.text));
      for (const text of chunks) {
        messages.push({ type: "text", text });
      }

      // LINE reply (สูงสุด 5 messages)
      await lineClient.replyMessage({
        replyToken,
        messages: messages.slice(0, 5) as any,
      });
    } catch (err: any) {
      console.error("[ERROR]", err);

      // สร้าง error message ที่เข้าใจง่าย
      let errorMsg = "ขอโทษครับ เกิดข้อผิดพลาด";
      const msg = err?.message || err?.error?.error?.message || "";

      if (msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota")) {
        errorMsg = "ขอโทษครับ AI quota หมด (Gemini free tier) กรุณารอสักครู่หรือเปลี่ยน provider";
      } else if (msg.includes("credit balance is too low") || msg.includes("insufficient_quota")) {
        errorMsg = "ขอโทษครับ AI credit หมด กรุณาเติม credit แล้วลองใหม่";
      } else if (msg.includes("authentication") || msg.includes("invalid_api_key") || err?.status === 401) {
        errorMsg = "ขอโทษครับ API key ไม่ถูกต้อง กรุณาตรวจสอบ .env";
      } else if (msg.includes("rate_limit") || err?.status === 429) {
        errorMsg = "ขอโทษครับ ส่งข้อความเร็วเกินไป กรุณารอสักครู่แล้วลองใหม่";
      } else if (msg.includes("overloaded") || err?.status === 529) {
        errorMsg = "ขอโทษครับ AI server กำลังโหลดหนัก กรุณารอสักครู่แล้วลองใหม่";
      } else if (err?.status >= 500) {
        errorMsg = "ขอโทษครับ AI server มีปัญหาชั่วคราว กรุณาลองใหม่";
      }

      try {
        await lineClient.replyMessage({
          replyToken,
          messages: [{ type: "text", text: errorMsg }],
        });
      } catch (replyErr) {
        console.error("[ERROR] reply failed:", replyErr);
      }
    }
  }
}
