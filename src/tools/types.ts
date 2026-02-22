/**
 * MyClaw Tool System
 *
 * โครงสร้างสำหรับเพิ่ม tool ใหม่:
 * 1. สร้างไฟล์ใน src/tools/ (เช่น web-search.ts)
 * 2. implement ToolDefinition interface
 * 3. register ใน src/tools/index.ts
 *
 * AI จะเห็น tool ที่ register แล้วอัตโนมัติ
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { messagingApi } from "@line/bot-sdk";

// Context ที่ส่งให้ tool ทุกตัวเมื่อถูกเรียก
export interface ToolContext {
  userId: string;
  lineClient?: messagingApi.MessagingApiClient;
}

// Tool definition ที่ทุก tool ต้อง implement
export interface ToolDefinition {
  // ชื่อ tool (AI จะเรียกด้วยชื่อนี้)
  name: string;

  // คำอธิบายให้ AI เข้าใจว่า tool ทำอะไร
  description: string;

  // JSON Schema ของ parameters ที่ tool รับ
  inputSchema: Anthropic.Tool["input_schema"];

  // function ที่รันจริงเมื่อ AI เรียก tool
  execute: (input: Record<string, unknown>, context?: ToolContext) => Promise<string>;
}
