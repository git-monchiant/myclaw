/**
 * tts tool — แปลงข้อความเป็นเสียง (Text-to-Speech)
 * Ported from OpenClaw: openclaw/src/tts/
 *
 * Provider: Gemini native audio generation (responseModalities: ["AUDIO"])
 * ไม่ต้องเพิ่ม dependency — ใช้ GEMINI_API_KEY เดิม
 *
 * Flow: text → Gemini audio API → raw PCM → add WAV header → ffmpeg convert to M4A → serve via Express → LINE audio message
 */

import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { ToolDefinition, ToolContext } from "./types.js";

// ===== Constants =====
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const AUDIO_DIR = "./data/audio";
const CLEANUP_DELAY_MS = 10 * 60 * 1000; // 10 นาที แล้ว cleanup
const MAX_TEXT_LENGTH = 4000;

// Gemini TTS model (ต้องใช้ TTS-specific model ไม่ใช่ model ทั่วไป)
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL?.trim() || "gemini-2.5-flash-preview-tts";

// Gemini TTS voices (Gemini 2.5)
const GEMINI_VOICES = ["Aoede", "Charon", "Fenrir", "Kore", "Puck"] as const;
const DEFAULT_VOICE = "Kore";

// ===== Parse sample rate from mimeType =====
// Gemini TTS returns mimeType like "audio/L16;rate=24000"
function parseSampleRate(mimeType: string): number {
  const match = mimeType.match(/rate=(\d+)/);
  return match ? parseInt(match[1], 10) : 24000;
}

// ===== ตรวจว่า buffer เป็น WAV จริง (มี RIFF header) หรือเป็น raw PCM =====
function hasWavHeader(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "RIFF";
}

// ===== Wrap raw PCM ด้วย WAV header =====
function wrapPcmInWav(pcmBuffer: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const headerSize = 44;

  const header = Buffer.alloc(headerSize);
  header.write("RIFF", 0);                          // ChunkID
  header.writeUInt32LE(dataSize + headerSize - 8, 4); // ChunkSize
  header.write("WAVE", 8);                          // Format
  header.write("fmt ", 12);                         // Subchunk1ID
  header.writeUInt32LE(16, 16);                     // Subchunk1Size (PCM)
  header.writeUInt16LE(1, 20);                      // AudioFormat (1 = PCM)
  header.writeUInt16LE(channels, 22);               // NumChannels
  header.writeUInt32LE(sampleRate, 24);             // SampleRate
  header.writeUInt32LE(byteRate, 28);               // ByteRate
  header.writeUInt16LE(blockAlign, 32);             // BlockAlign
  header.writeUInt16LE(bitsPerSample, 34);          // BitsPerSample
  header.write("data", 36);                         // Subchunk2ID
  header.writeUInt32LE(dataSize, 40);               // Subchunk2Size

  return Buffer.concat([header, pcmBuffer]) as Buffer<ArrayBuffer>;
}

// ===== Gemini native TTS =====
async function geminiTTS(params: {
  text: string;
  apiKey: string;
  model: string;
  voice: string;
}): Promise<{ buffer: Buffer; mimeType: string }> {
  const url = `${GEMINI_BASE_URL}/models/${params.model}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": params.apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: params.text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: params.voice },
          },
        },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini TTS error (${res.status}): ${detail.slice(0, 500)}`);
  }

  type GeminiAudioResponse = {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          inlineData?: { mimeType: string; data: string };
          text?: string;
        }>;
      };
    }>;
  };

  const data = (await res.json()) as GeminiAudioResponse;
  const audioPart = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);

  if (!audioPart?.inlineData) {
    throw new Error("No audio data in Gemini response");
  }

  let buffer: Buffer<ArrayBufferLike> = Buffer.from(audioPart.inlineData.data, "base64");
  const mimeType = audioPart.inlineData.mimeType || "audio/wav";

  // ถ้า Gemini ส่ง raw PCM (ไม่มี WAV header) → เพิ่ม WAV header
  if (!hasWavHeader(buffer)) {
    const sampleRate = parseSampleRate(mimeType);
    console.log(`[tts] Raw PCM detected (${mimeType}), adding WAV header (${sampleRate}Hz)`);
    buffer = wrapPcmInWav(buffer, sampleRate);
  }

  return { buffer, mimeType: "audio/wav" };
}

// ===== Audio duration from WAV header =====
function getAudioDurationMs(buffer: Buffer): number {
  if (hasWavHeader(buffer) && buffer.length >= 44) {
    const byteRate = buffer.readUInt32LE(28);
    if (byteRate > 0) {
      const dataSize = buffer.length - 44;
      return Math.ceil((dataSize / byteRate) * 1000);
    }
  }
  // Fallback: assume 24kHz, 16-bit, mono PCM
  const bytesPerSecond = 24000 * 2;
  return Math.ceil((buffer.length / bytesPerSecond) * 1000);
}

// ===== Tool definition =====
export const ttsTool: ToolDefinition = {
  name: "tts",
  description:
    "Convert text to speech audio using Gemini. The audio will be sent as a voice message to the user. Use when the user asks to read text aloud, create audio, or wants voice output. Available voices: Aoede, Charon, Fenrir, Kore (default), Puck.",
  inputSchema: {
    type: "object" as const,
    properties: {
      text: {
        type: "string",
        description: `Text to convert to speech (max ${MAX_TEXT_LENGTH} chars).`,
      },
      voice: {
        type: "string",
        description: `Voice name. Available: ${GEMINI_VOICES.join(", ")}. Default: ${DEFAULT_VOICE}.`,
      },
    },
    required: ["text"],
  },
  execute: async (input, _context?: ToolContext) => {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) {
      return JSON.stringify({ error: "missing_text", message: "Text is required." });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return JSON.stringify({
        error: "text_too_long",
        message: `Text must be under ${MAX_TEXT_LENGTH} characters (got ${text.length}).`,
      });
    }

    const baseUrl = process.env.BASE_URL?.trim();
    if (!baseUrl) {
      return JSON.stringify({
        error: "missing_config",
        message: "BASE_URL env var is required for TTS (to serve audio files via HTTPS).",
      });
    }

    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      return JSON.stringify({ error: "missing_api_key", message: "GEMINI_API_KEY is required for TTS." });
    }

    const model = GEMINI_TTS_MODEL;
    const voice = typeof input.voice === "string" && input.voice.trim()
      ? input.voice.trim()
      : DEFAULT_VOICE;

    const start = Date.now();

    try {
      console.log(`[tts] Generating audio: "${text.substring(0, 50)}..." (voice: ${voice}, model: ${model})`);
      const { buffer } = await geminiTTS({ text, apiKey, model, voice });

      // Save WAV (มี header แล้ว)
      mkdirSync(AUDIO_DIR, { recursive: true });
      const id = randomBytes(8).toString("hex");
      const wavFilename = `${id}.wav`;
      const wavPath = path.join(AUDIO_DIR, wavFilename);
      writeFileSync(wavPath, buffer);

      // คำนวณ duration จาก WAV
      const duration = getAudioDurationMs(buffer);

      // Convert WAV → M4A (LINE รองรับเฉพาะ M4A)
      let serveFilename = wavFilename;
      const m4aFilename = `${id}.m4a`;
      const m4aPath = path.join(AUDIO_DIR, m4aFilename);

      try {
        execSync(
          `ffmpeg -i "${wavPath}" -c:a aac -b:a 128k -y "${m4aPath}"`,
          { timeout: 30000, stdio: "pipe" },
        );
        // ลบ WAV ต้นฉบับ ใช้ M4A แทน
        try { unlinkSync(wavPath); } catch { /* ignore */ }
        serveFilename = m4aFilename;
        console.log(`[tts] Converted to M4A: ${m4aFilename}`);
      } catch (convErr: any) {
        console.warn(`[tts] ffmpeg conversion failed (serving WAV): ${convErr?.message?.substring(0, 200)}`);
      }

      const servePath = path.join(AUDIO_DIR, serveFilename);

      // Auto-cleanup หลัง 10 นาที
      const timer = setTimeout(() => {
        try { unlinkSync(servePath); } catch { /* ignore */ }
        if (serveFilename !== wavFilename) {
          try { unlinkSync(wavPath); } catch { /* ignore */ }
        }
      }, CLEANUP_DELAY_MS);
      timer.unref();

      const audioUrl = `${baseUrl.replace(/\/$/, "")}/audio/${serveFilename}`;

      console.log(`[tts] Done: ${serveFilename} (${(buffer.length / 1024).toFixed(1)}KB raw, ${duration}ms, took ${Date.now() - start}ms)`);

      return JSON.stringify({
        success: true,
        audioUrl,
        duration,
        voice,
        sizeKB: Number((buffer.length / 1024).toFixed(1)),
        tookMs: Date.now() - start,
      });
    } catch (err: any) {
      console.error("[tts] Error:", err?.message || err);
      return JSON.stringify({
        error: "tts_failed",
        message: err?.message || String(err),
        tookMs: Date.now() - start,
      });
    }
  },
};
