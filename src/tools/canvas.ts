/**
 * canvas tool — สร้าง LINE Flex Messages / Rich UI
 * Ported from OpenClaw: openclaw/src/agents/tools/canvas-tool.ts
 *
 * ใน OpenClaw: ควบคุม WebView canvas บน companion app
 * ใน MyClaw: สร้างและส่ง LINE Flex Messages ซึ่งเป็น rich UI ของ LINE
 *
 * Actions:
 * - generate_flex: สร้าง Flex Message จาก template + data
 * - send_flex: สร้างและส่ง Flex Message โดยตรง (push)
 * - generate_quickreply: สร้าง Quick Reply buttons
 *
 * LINE Flex Messages = rich, customizable layout cards
 * ใช้แสดง: product cards, receipts, menus, info cards, etc.
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import { lineClient } from "../line.js";

// ===== Built-in templates =====
interface FlexTemplate {
  name: string;
  description: string;
  build: (data: Record<string, unknown>) => object;
}

const templates: Record<string, FlexTemplate> = {
  // Info card
  info: {
    name: "info",
    description: "Simple info card with title, text, and optional button",
    build: (data) => ({
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: String(data.title || "Info"),
            weight: "bold",
            size: "xl",
          },
          {
            type: "text",
            text: String(data.text || ""),
            wrap: true,
            margin: "md",
            size: "sm",
            color: "#666666",
          },
        ],
      },
      ...(data.buttonLabel && data.buttonUrl
        ? {
            footer: {
              type: "box",
              layout: "vertical",
              contents: [
                {
                  type: "button",
                  action: {
                    type: "uri",
                    label: String(data.buttonLabel),
                    uri: String(data.buttonUrl),
                  },
                  style: "primary",
                },
              ],
            },
          }
        : {}),
    }),
  },

  // Image card
  image: {
    name: "image",
    description: "Image card with optional title and description",
    build: (data) => ({
      type: "bubble",
      hero: {
        type: "image",
        url: String(data.imageUrl || ""),
        size: "full",
        aspectRatio: "20:13",
        aspectMode: "cover",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          ...(data.title
            ? [{ type: "text", text: String(data.title), weight: "bold", size: "xl" }]
            : []),
          ...(data.description
            ? [{ type: "text", text: String(data.description), wrap: true, margin: "md", size: "sm", color: "#666666" }]
            : []),
        ],
      },
    }),
  },

  // List / menu
  list: {
    name: "list",
    description: "List of items with labels and values",
    build: (data) => {
      const items = Array.isArray(data.items) ? data.items : [];
      return {
        type: "bubble",
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            ...(data.title
              ? [{
                  type: "text",
                  text: String(data.title),
                  weight: "bold",
                  size: "lg",
                  margin: "none",
                }]
              : []),
            { type: "separator", margin: "md" },
            ...items.map((item: any) => ({
              type: "box",
              layout: "horizontal",
              margin: "md",
              contents: [
                { type: "text", text: String(item.label || ""), size: "sm", color: "#555555", flex: 0 },
                { type: "text", text: String(item.value || ""), size: "sm", color: "#111111", align: "end" },
              ],
            })),
          ],
        },
      };
    },
  },

  // Confirm (yes/no)
  confirm: {
    name: "confirm",
    description: "Confirmation card with two buttons",
    build: (data) => ({
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: String(data.text || "ยืนยันหรือไม่?"),
            wrap: true,
            size: "md",
          },
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        contents: [
          {
            type: "button",
            action: {
              type: "message",
              label: String(data.yesLabel || "ใช่"),
              text: String(data.yesText || "ใช่"),
            },
            style: "primary",
            flex: 1,
          },
          {
            type: "button",
            action: {
              type: "message",
              label: String(data.noLabel || "ไม่"),
              text: String(data.noText || "ไม่"),
            },
            style: "secondary",
            flex: 1,
          },
        ],
      },
    }),
  },

  // Carousel (multiple bubbles)
  carousel: {
    name: "carousel",
    description: "Horizontal carousel of cards",
    build: (data) => {
      const cards = Array.isArray(data.cards) ? data.cards : [];
      return {
        type: "carousel",
        contents: cards.slice(0, 12).map((card: any) => ({
          type: "bubble",
          ...(card.imageUrl
            ? {
                hero: {
                  type: "image",
                  url: String(card.imageUrl),
                  size: "full",
                  aspectRatio: "20:13",
                  aspectMode: "cover",
                },
              }
            : {}),
          body: {
            type: "box",
            layout: "vertical",
            contents: [
              { type: "text", text: String(card.title || ""), weight: "bold", size: "md" },
              ...(card.description
                ? [{ type: "text", text: String(card.description), wrap: true, size: "sm", color: "#666666", margin: "sm" }]
                : []),
            ],
          },
          ...(card.buttonLabel && card.buttonUrl
            ? {
                footer: {
                  type: "box",
                  layout: "vertical",
                  contents: [
                    {
                      type: "button",
                      action: {
                        type: "uri",
                        label: String(card.buttonLabel),
                        uri: String(card.buttonUrl),
                      },
                      style: "primary",
                    },
                  ],
                },
              }
            : {}),
        })),
      };
    },
  },
};

export const canvasTool: ToolDefinition = {
  name: "canvas",
  description:
    "Create and send rich LINE Flex Messages (cards, lists, carousels, confirm dialogs). Actions: " +
    '"generate_flex" creates a Flex Message JSON from template + data (returns JSON for inspection), ' +
    '"send_flex" creates and sends a Flex Message directly to the user, ' +
    '"generate_quickreply" creates Quick Reply buttons. ' +
    "Templates: info (title+text+button), image (image+title+desc), list (key-value pairs), confirm (yes/no), carousel (multiple cards). " +
    "You can also provide raw Flex Message JSON for full control. " +
    "Use for rich displays: product info, menus, receipts, confirmations, image galleries.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["generate_flex", "send_flex", "generate_quickreply"],
        description: "Action to perform.",
      },
      template: {
        type: "string",
        enum: ["info", "image", "list", "confirm", "carousel"],
        description: "Template to use (for generate_flex/send_flex).",
      },
      data: {
        type: "object",
        description:
          "Data for the template. Varies by template: " +
          'info: {title, text, buttonLabel?, buttonUrl?}, ' +
          'image: {imageUrl, title?, description?}, ' +
          'list: {title?, items: [{label, value}]}, ' +
          'confirm: {text, yesLabel?, yesText?, noLabel?, noText?}, ' +
          'carousel: {cards: [{title, description?, imageUrl?, buttonLabel?, buttonUrl?}]}',
      },
      rawFlex: {
        type: "object",
        description: "Raw Flex Message JSON (overrides template). Must be a valid Flex container (bubble or carousel).",
      },
      altText: {
        type: "string",
        description: "Alt text shown in notification and non-Flex clients (default: auto-generated).",
      },
      quickReplies: {
        type: "array",
        description: 'Array of quick reply items: [{label: string, text: string}] or [{label: string, uri: string}]',
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            text: { type: "string" },
            uri: { type: "string" },
          },
        },
      },
    },
    required: ["action"],
  },

  execute: async (input, context?: ToolContext) => {
    const action = typeof input.action === "string" ? input.action.trim() : "";

    try {
      switch (action) {
        case "generate_flex":
        case "send_flex": {
          let flexContents: object;

          // Raw flex overrides template
          if (input.rawFlex && typeof input.rawFlex === "object") {
            flexContents = input.rawFlex as object;
          } else {
            const templateName = typeof input.template === "string" ? input.template.trim() : "";
            if (!templateName || !templates[templateName]) {
              return JSON.stringify({
                error: "invalid_template",
                message: `Template "${templateName}" not found. Available: ${Object.keys(templates).join(", ")}`,
              });
            }

            const data = (input.data && typeof input.data === "object") ? input.data as Record<string, unknown> : {};
            flexContents = templates[templateName].build(data);
          }

          const altText = typeof input.altText === "string" && input.altText.trim()
            ? input.altText.trim()
            : "MyClaw message";

          const flexMessage = {
            type: "flex" as const,
            altText,
            contents: flexContents,
          };

          if (action === "generate_flex") {
            return JSON.stringify({
              success: true,
              action: "generate_flex",
              flexMessage,
              note: 'Use "send_flex" to send this to the user, or use this JSON as reference.',
            });
          }

          // send_flex
          const userId = context?.userId;
          if (!userId) {
            return JSON.stringify({ error: "no_user", message: "No userId available for sending." });
          }

          await lineClient.pushMessage({
            to: userId,
            messages: [flexMessage as any],
          });

          console.log(`[canvas] Sent flex message to ${userId}`);
          return JSON.stringify({ success: true, action: "send_flex", to: userId, altText });
        }

        case "generate_quickreply": {
          const items = Array.isArray(input.quickReplies) ? input.quickReplies : [];
          if (items.length === 0) {
            return JSON.stringify({ error: "empty_items", message: "quickReplies array is required." });
          }

          const quickReply = {
            items: items.slice(0, 13).map((item: any) => {
              if (item.uri) {
                return {
                  type: "action",
                  action: {
                    type: "uri",
                    label: String(item.label || "").substring(0, 20),
                    uri: String(item.uri),
                  },
                };
              }
              return {
                type: "action",
                action: {
                  type: "message",
                  label: String(item.label || "").substring(0, 20),
                  text: String(item.text || item.label || ""),
                },
              };
            }),
          };

          return JSON.stringify({
            success: true,
            action: "generate_quickreply",
            quickReply,
            note: "Attach this quickReply to any message to show quick reply buttons.",
          });
        }

        default:
          return JSON.stringify({
            error: "unknown_action",
            message: `Unknown action "${action}". Available: generate_flex, send_flex, generate_quickreply.`,
          });
      }
    } catch (err: any) {
      return JSON.stringify({ error: "action_failed", action, message: err?.message || String(err) });
    }
  },
};
