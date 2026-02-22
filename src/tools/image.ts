/**
 * image tool — วิเคราะห์รูปภาพ/วิดีโอด้วย Vision AI
 * Ported from OpenClaw: openclaw/src/agents/tools/image-tool.ts
 *
 * รับ URL รูป/วิดีโอ → fetch → base64 → ส่งให้ Vision AI → return คำอธิบาย
 * รองรับ: image/*, video/* (สั้นๆ <20MB)
 * รองรับหลายไฟล์พร้อมกัน (สูงสุด 20)
 *
 * Multi-provider with fallback (เหมือน OpenClaw):
 * - Gemini (primary): รองรับ image + video + YouTube
 * - Anthropic Claude Vision (fallback): รองรับ image เท่านั้น (jpeg/png/gif/webp)
 * - ถ้า Gemini ล้ม → ลอง Anthropic อัตโนมัติ
 * - ถ้าไม่มี Gemini key แต่มี Anthropic key → ใช้ Anthropic เลย
 */

import type { ToolDefinition } from "./types.js";
import { isPrivateUrl } from "./web-shared.js";

// ===== Constants =====
const MAX_MEDIA = 20;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024; // 20MB per file (Gemini inline limit)
const DEFAULT_PROMPT = "Describe the image in detail.";
const DEFAULT_VIDEO_PROMPT = `Summarize this video in detail. Cover ALL of the following:
1. What is the video about? (topic, context, who is speaking/presenting)
2. List EVERY key point, argument, and piece of information mentioned — do not skip anything.
3. If there are statistics, numbers, names, places, or dates mentioned, include them all.
4. If there is text shown on screen (titles, captions, graphics), transcribe them.
5. If there is dialogue or narration, capture the main statements and quotes.
6. Organize the summary in a clear structure with bullet points.
Be thorough — a longer, complete summary is better than a short, incomplete one.`;
const SUPPORTED_MIME_PREFIXES = ["image/", "video/"];
const FETCH_TIMEOUT_MS = 60_000; // 60s for larger video files

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// ===== Types =====
type MediaData = {
  url: string;
  mimeType: string;
  base64: string;
  isVideo: boolean;
  sizeBytes: number;
};

type YouTubeRef = {
  url: string;
  isYouTube: true;
  isVideo: true;
};

type MediaItem = MediaData | YouTubeRef;

// ===== YouTube URL detection =====
const YOUTUBE_PATTERNS = [
  /^https?:\/\/(?:www\.)?youtube\.com\/watch\?/,
  /^https?:\/\/(?:www\.)?youtube\.com\/shorts\//,
  /^https?:\/\/youtu\.be\//,
  /^https?:\/\/(?:www\.)?youtube\.com\/embed\//,
  /^https?:\/\/(?:www\.)?youtube\.com\/live\//,
];

function isYouTubeUrl(url: string): boolean {
  return YOUTUBE_PATTERNS.some((p) => p.test(url));
}

// YouTube duration limit (นาที) — ถ้า video ยาวกว่านี้ Gemini จะ process นานจนเกิน LINE reply token timeout
const MAX_YOUTUBE_MINUTES = 15;

/**
 * ดึงความยาว YouTube video (วินาที) จาก page HTML
 * ใช้ itemprop="duration" meta tag (ISO 8601: PT5M30S)
 * Return null ถ้าดึงไม่ได้
 */
async function getYouTubeDuration(url: string): Promise<number | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MyClaw/1.0)" },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const html = await res.text();

    // วิธี 1: itemprop="duration" content="PT5M30S"
    const metaMatch = html.match(/itemprop="duration"\s+content="([^"]+)"/);
    if (metaMatch) {
      return parseISO8601Duration(metaMatch[1]);
    }

    // วิธี 2: "lengthSeconds":"123" จาก ytInitialPlayerResponse
    const lengthMatch = html.match(/"lengthSeconds"\s*:\s*"(\d+)"/);
    if (lengthMatch) {
      return parseInt(lengthMatch[1], 10);
    }

    return null;
  } catch {
    return null;
  }
}

/** Parse ISO 8601 duration (PT1H2M30S → seconds) */
function parseISO8601Duration(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const h = parseInt(match[1] || "0", 10);
  const m = parseInt(match[2] || "0", 10);
  const s = parseInt(match[3] || "0", 10);
  return h * 3600 + m * 60 + s;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ===== Image fetching =====
async function fetchMediaAsBase64(url: string): Promise<MediaData> {
  // SSRF guard
  if (isPrivateUrl(url)) {
    throw new Error(`SSRF blocked: ${url} is a private/internal address`);
  }

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error(`Unsupported protocol: ${parsedUrl.protocol}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "image/*, video/*",
        "User-Agent": "MyClaw/1.0 ImageTool",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    // Check content-type
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const mimeType = contentType.split(";")[0].trim().toLowerCase();

    if (!SUPPORTED_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) {
      throw new Error(`Unsupported content type: ${mimeType} (expected image/* or video/*)`);
    }

    // Read as buffer with size limit
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_MEDIA_BYTES) {
      throw new Error(`File too large: ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)}MB (max ${MAX_MEDIA_BYTES / 1024 / 1024}MB)`);
    }

    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const isVideo = mimeType.startsWith("video/");

    return { url, mimeType, base64, isVideo, sizeBytes: arrayBuffer.byteLength };
  } finally {
    clearTimeout(timeout);
  }
}

// ===== Detect MIME from URL extension (fallback) =====
function guessMimeFromUrl(url: string): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
  };
  return map[ext || ""] || "image/jpeg";
}

// ===== Vision API call =====
async function analyzeWithGemini(params: {
  media: MediaItem[];
  prompt: string;
  apiKey: string;
  model: string;
}): Promise<string> {
  const parts: Array<Record<string, unknown>> = [];

  // Add prompt text
  parts.push({ text: params.prompt });

  // Add media: YouTube → fileData, otherwise → inlineData
  for (const m of params.media) {
    if ("isYouTube" in m) {
      // YouTube URL — ส่งเป็น fileData (Gemini จัดการ YouTube ได้โดยตรง เหมือน NotebookLM)
      parts.push({
        fileData: {
          fileUri: m.url,
          mimeType: "video/*",
        },
      });
    } else {
      parts.push({
        inlineData: {
          mimeType: m.mimeType,
          data: m.base64,
        },
      });
    }
  }

  const url = `${GEMINI_BASE_URL}/models/${params.model}:generateContent`;
  const body = {
    contents: [{ parts }],
    generationConfig: { maxOutputTokens: 8192 },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": params.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini Vision API error (${res.status}): ${detail.slice(0, 500) || res.statusText}`);
  }

  type GeminiResponse = {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const data = (await res.json()) as GeminiResponse;
  const textParts = data.candidates?.[0]?.content?.parts
    ?.filter((p) => p.text)
    .map((p) => p.text!) ?? [];

  return textParts.join("\n") || "No description generated.";
}

// ===== Anthropic Claude Vision API call =====
// Supported MIME types for Anthropic: image/jpeg, image/png, image/gif, image/webp
const ANTHROPIC_SUPPORTED_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

async function analyzeWithAnthropic(params: {
  media: MediaItem[];
  prompt: string;
  apiKey: string;
  model: string;
}): Promise<string> {
  // Anthropic ไม่รองรับ video และ YouTube — filter เฉพาะ image ที่รองรับ
  const imageMedia = params.media.filter((m): m is MediaData =>
    !("isYouTube" in m) && !m.isVideo && ANTHROPIC_SUPPORTED_MIMES.includes(m.mimeType),
  );

  if (imageMedia.length === 0) {
    throw new Error("No compatible images for Anthropic Vision (supports jpeg/png/gif/webp only, no video/YouTube)");
  }

  // Build content blocks: text + images
  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

  const content: ContentBlock[] = [{ type: "text", text: params.prompt }];

  for (const m of imageMedia) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: m.mimeType,
        data: m.base64,
      },
    });
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": params.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: 4096,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Anthropic Vision API error (${res.status}): ${detail.slice(0, 500) || res.statusText}`);
  }

  type AnthropicResponse = {
    content?: Array<{ type: string; text?: string }>;
  };

  const data = (await res.json()) as AnthropicResponse;
  const textParts = data.content
    ?.filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!) ?? [];

  return textParts.join("\n") || "No description generated.";
}

// ===== Provider detection for image analysis =====
type VisionProvider = {
  name: string;
  apiKey: string;
  model: string;
  supportsVideo: boolean;
  supportsYouTube: boolean;
};

function getVisionProviders(): VisionProvider[] {
  const providers: VisionProvider[] = [];

  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (geminiKey) {
    providers.push({
      name: "gemini",
      apiKey: geminiKey,
      model: process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash",
      supportsVideo: true,
      supportsYouTube: true,
    });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    providers.push({
      name: "anthropic",
      apiKey: anthropicKey,
      model: "claude-sonnet-4-20250514",
      supportsVideo: false,
      supportsYouTube: false,
    });
  }

  return providers;
}

// ===== Analyze with fallback (เหมือน OpenClaw runWithImageModelFallback) =====
async function analyzeWithFallback(params: {
  media: MediaItem[];
  prompt: string;
  hasVideo: boolean;
  hasYouTube: boolean;
}): Promise<{ description: string; provider: string; model: string; attempts: Array<{ provider: string; model: string; error: string }> }> {
  const providers = getVisionProviders();

  if (providers.length === 0) {
    throw new Error("No vision AI provider configured. Set GEMINI_API_KEY or ANTHROPIC_API_KEY.");
  }

  // Filter providers: ถ้ามี video/YouTube ต้องใช้ provider ที่รองรับ
  const compatibleProviders = providers.filter((p) => {
    if (params.hasYouTube && !p.supportsYouTube) return false;
    if (params.hasVideo && !p.supportsVideo) return false;
    return true;
  });

  // ถ้าไม่มี compatible provider สำหรับ video → ลองทุกตัว (จะ error ใน analyze function เอง)
  const tryProviders = compatibleProviders.length > 0 ? compatibleProviders : providers;

  const attempts: Array<{ provider: string; model: string; error: string }> = [];

  for (const provider of tryProviders) {
    try {
      let description: string;

      if (provider.name === "gemini") {
        description = await analyzeWithGemini({
          media: params.media,
          prompt: params.prompt,
          apiKey: provider.apiKey,
          model: provider.model,
        });
      } else if (provider.name === "anthropic") {
        description = await analyzeWithAnthropic({
          media: params.media,
          prompt: params.prompt,
          apiKey: provider.apiKey,
          model: provider.model,
        });
      } else {
        throw new Error(`Unknown vision provider: ${provider.name}`);
      }

      console.log(`[image] Analysis succeeded with ${provider.name}/${provider.model}`);
      return {
        description,
        provider: provider.name,
        model: provider.model,
        attempts,
      };
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      console.warn(`[image] ${provider.name}/${provider.model} failed: ${errorMsg.substring(0, 200)}`);
      attempts.push({
        provider: provider.name,
        model: provider.model,
        error: errorMsg.substring(0, 500),
      });
    }
  }

  // ทุก provider ล้มหมด
  const errorSummary = attempts.map((a) => `${a.provider}/${a.model}: ${a.error}`).join("; ");
  throw new Error(`All vision providers failed. ${errorSummary}`);
}

// ===== Tool definition =====
export const imageTool: ToolDefinition = {
  name: "image",
  description:
    "Analyze and describe images, videos, or YouTube URLs using vision AI. Supports YouTube links (youtube.com, youtu.be) natively — can summarize, transcribe, and analyze YouTube videos. Also supports direct image/video file URLs (up to 5). Use when the user provides a media URL or YouTube link and wants analysis, OCR, comparison, description, or video summary.",
  inputSchema: {
    type: "object" as const,
    properties: {
      image: {
        type: "string",
        description: "Single image or video URL to analyze.",
      },
      images: {
        type: "array",
        items: { type: "string" },
        description: `Multiple image/video URLs to analyze (max ${MAX_MEDIA}).`,
      },
      prompt: {
        type: "string",
        description: `What to analyze. Default for images: "${DEFAULT_PROMPT}". For videos: auto-summarize.`,
      },
    },
    required: [],
  },
  execute: async (input) => {
    // Check at least one vision provider is available
    const providers = getVisionProviders();
    if (providers.length === 0) {
      return JSON.stringify({
        error: "missing_api_key",
        message: "No vision AI provider configured. Set GEMINI_API_KEY or ANTHROPIC_API_KEY.",
      });
    }

    // Collect media URLs
    const urls: string[] = [];
    if (typeof input.image === "string" && input.image.trim()) {
      urls.push(input.image.trim());
    }
    if (Array.isArray(input.images)) {
      for (const u of input.images) {
        if (typeof u === "string" && u.trim()) {
          urls.push(u.trim());
        }
      }
    }

    // Deduplicate
    const uniqueUrls = [...new Set(urls)];

    if (uniqueUrls.length === 0) {
      return JSON.stringify({
        error: "missing_media",
        message: "Provide at least one image/video URL via 'image' or 'images' parameter.",
      });
    }

    if (uniqueUrls.length > MAX_MEDIA) {
      return JSON.stringify({
        error: "too_many_files",
        message: `Maximum ${MAX_MEDIA} files allowed, got ${uniqueUrls.length}.`,
      });
    }

    const start = Date.now();

    try {
      // แยก YouTube URLs ออกจาก URLs ที่ต้อง fetch
      const youtubeUrls = uniqueUrls.filter(isYouTubeUrl);
      const fetchUrls = uniqueUrls.filter((u) => !isYouTubeUrl(u));

      // YouTube URLs → เช็ค duration ก่อน, ถ้ายาวเกินปฏิเสธทันที
      if (youtubeUrls.length > 0) {
        console.log(`[image] YouTube URL(s): ${youtubeUrls.join(", ")}`);

        // เช็ค duration ทุก YouTube URL
        for (const ytUrl of youtubeUrls) {
          const durationSec = await getYouTubeDuration(ytUrl);
          if (durationSec !== null) {
            const durationMin = durationSec / 60;
            console.log(`[image] YouTube duration: ${formatDuration(durationSec)} (${Math.round(durationMin)} min)`);

            if (durationMin > MAX_YOUTUBE_MINUTES) {
              return JSON.stringify({
                error: "video_too_long",
                message: `วิดีโอยาว ${formatDuration(durationSec)} (${Math.round(durationMin)} นาที) — เกินขีดจำกัด ${MAX_YOUTUBE_MINUTES} นาที ไม่สามารถสรุปได้เพราะจะใช้เวลาประมวลผลนานเกินไป`,
                duration: formatDuration(durationSec),
                durationSeconds: durationSec,
                maxMinutes: MAX_YOUTUBE_MINUTES,
                url: ytUrl,
              });
            }
          } else {
            console.log(`[image] YouTube duration: unknown (could not extract)`);
          }
        }
      }

      const youtubeMedia: YouTubeRef[] = youtubeUrls.map((url) => ({
        url,
        isYouTube: true as const,
        isVideo: true as const,
      }));

      // Fetch non-YouTube media in parallel
      const media: MediaItem[] = [...youtubeMedia];
      const errors: Array<{ url: string; error: string }> = [];

      if (fetchUrls.length > 0) {
        console.log(`[image] Fetching ${fetchUrls.length} file(s)...`);
        const fetchResults = await Promise.allSettled(
          fetchUrls.map((u) => fetchMediaAsBase64(u)),
        );

        for (let i = 0; i < fetchResults.length; i++) {
          const result = fetchResults[i];
          if (result.status === "fulfilled") {
            media.push(result.value);
          } else {
            errors.push({
              url: fetchUrls[i],
              error: result.reason?.message || String(result.reason),
            });
          }
        }
      }

      if (media.length === 0) {
        return JSON.stringify({
          error: "all_fetches_failed",
          message: "Failed to fetch all files.",
          details: errors,
        });
      }

      // Auto-detect prompt: use video prompt if any video present
      const hasVideo = media.some((m) => m.isVideo);
      const hasYouTube = media.some((m) => "isYouTube" in m);
      const prompt = (typeof input.prompt === "string" && input.prompt.trim())
        || (hasVideo ? DEFAULT_VIDEO_PROMPT : DEFAULT_PROMPT);

      // Analyze with fallback (Gemini → Anthropic)
      const fetchedMedia = media.filter((m): m is MediaData => !("isYouTube" in m));
      const totalSize = fetchedMedia.reduce((sum, m) => sum + m.sizeBytes, 0);
      const mediaTypes = media.map((m) => "isYouTube" in m ? "youtube" : (m as MediaData).isVideo ? "video" : "image");
      console.log(`[image] Analyzing ${media.length} file(s) [${mediaTypes.join(", ")}]...`);

      const result = await analyzeWithFallback({
        media,
        prompt,
        hasVideo,
        hasYouTube,
      });

      const payload: Record<string, unknown> = {
        description: result.description,
        provider: result.provider,
        model: result.model,
        mediaCount: media.length,
        mediaTypes: [...new Set(mediaTypes)],
        tookMs: Date.now() - start,
      };

      if (result.attempts.length > 0) {
        payload.failedAttempts = result.attempts;
      }

      if (totalSize > 0) {
        payload.totalSizeMB = Number((totalSize / 1024 / 1024).toFixed(1));
      }

      if (media.length === 1) {
        payload.url = media[0].url;
      } else {
        payload.urls = media.map((m) => m.url);
      }

      if (errors.length > 0) {
        payload.fetchErrors = errors;
      }

      return JSON.stringify(payload, null, 2);
    } catch (err: any) {
      return JSON.stringify({
        error: "analysis_failed",
        message: err?.message || String(err),
        tookMs: Date.now() - start,
      });
    }
  },
};
