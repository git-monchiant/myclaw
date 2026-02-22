# MyClaw Tools Summary

## สถานะ: 6/19 tools เสร็จ

### Tools ที่ทำเสร็จแล้ว

| # | Tool | ไฟล์ | คำอธิบาย |
|---|------|------|----------|
| 0 | ToolContext | `tools/types.ts` | ส่ง `userId` เข้า tool ทุกตัว |
| 1 | `get_datetime` | `tools/datetime.ts` | วันที่/เวลาปัจจุบัน |
| 2 | `web_search` | `tools/web-search.ts` | ค้นหาเว็บ (Gemini/Brave/Perplexity/Grok) |
| 3 | `web_fetch` | `tools/web-fetch.ts` | ดึงเนื้อหาจาก URL (HTML→markdown) |
| 4 | `memory_search` | `tools/memory-search.ts` | ค้นหา memory (hybrid: vector+keyword) |
| 5 | `memory_get` | `tools/memory-get.ts` | ดึง conversation history ย้อนหลัง |
| 6 | `image` | `tools/image.ts` | วิเคราะห์รูป/วิดีโอ/YouTube URL |

### รายละเอียด Tools

#### `web_search`
- 4 providers: Gemini (Google Search grounding), Brave, Perplexity, Grok
- แก้ปัญหา Gemini redirect URLs (vertexaisearch → real URL)
- In-memory cache 5 นาที
- Env: `GEMINI_API_KEY` / `BRAVE_API_KEY` / `PERPLEXITY_API_KEY` / `XAI_API_KEY`

#### `web_fetch`
- Fetch URL → HTML to markdown / JSON / text
- SSRF guard (block private IPs)
- Content wrapper `[EXTERNAL CONTENT]` กัน prompt injection
- In-memory cache 5 นาที
- ไม่ต้อง API key

#### `memory_search`
- Hybrid search: vector + keyword + MMR + temporal decay
- ใช้ memory system ที่มีอยู่ (SQLite)
- ต้อง ToolContext (userId)

#### `memory_get`
- ดึง conversation history จาก SQLite
- Optional keyword filter
- ต้อง ToolContext (userId)

#### `image`
- วิเคราะห์รูปภาพจาก URL (Gemini Vision)
- รองรับ video จาก URL (< 20MB)
- **YouTube URL** → ส่งตรงไป Gemini ผ่าน `fileData` (เหมือน NotebookLM)
- YouTube duration check → ปฏิเสธถ้ายาวเกิน 15 นาที (LINE reply token timeout)
- รองรับหลายไฟล์พร้อมกัน (สูงสุด 5)
- SSRF guard
- Env: `GEMINI_API_KEY`

### Shared Utilities

| ไฟล์ | คำอธิบาย |
|------|----------|
| `tools/types.ts` | `ToolDefinition`, `ToolContext` interfaces |
| `tools/index.ts` | Tool registry, `findTool()`, `getToolDefinitions()`, `executeTool()` |
| `tools/web-shared.ts` | `isPrivateUrl()` SSRF guard, shared constants |
| `tools/web-fetch-utils.ts` | HTML→markdown conversion utilities |

### สิ่งที่แก้ใน ai.ts

- ปิด tools เมื่อมี media (video/audio) ส่งตรง — Gemini ทำ multimodal + tools พร้อมกันไม่ดี
- ส่ง `ToolContext { userId }` เข้า `executeTool()` ทุก provider (Gemini/Ollama/Anthropic)

---

### Tools ที่ยังไม่ได้ทำ (13 ตัว)

| # | Tool | ความซับซ้อน | หมายเหตุ |
|---|------|-------------|----------|
| 7 | `tts` | Medium | แปลงข้อความเป็นเสียง (ต้อง API key: Google/OpenAI/ElevenLabs) |
| 8 | `message` | Medium | ส่ง LINE push message (มีค่าใช้จ่าย) |
| 9 | `session_status` | Simple | แสดงสถานะ session (uptime, provider, msg count) |
| 10 | `sessions_list` | Simple | แสดงรายการ sessions/users |
| 11 | `sessions_history` | Simple | ดู history ของ session |
| 12 | `sessions_send` | Simple | ส่งข้อความข้าม session (push message) |
| 13 | `agents_list` | Simple | แสดง AI providers ที่ configure ไว้ |
| 14 | `cron` | Medium-Complex | ตั้งเวลาทำงานอัตโนมัติ (ต้อง node-cron) |
| 15 | `sessions_spawn` | Medium | สร้าง background AI task |
| 16 | `subagents` | Simple-Medium | จัดการ background tasks |
| 17 | `gateway` | Medium | system management (admin only) |
| 18 | `canvas` | Medium-Complex | LINE Flex Messages |
| 19 | `browser` | Complex | ควบคุม browser (ต้อง puppeteer) |
| 20 | `nodes` | Complex | ควบคุมอุปกรณ์ (ต้อง companion) |
