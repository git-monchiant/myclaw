/**
 * browser tool — ควบคุม browser สำหรับ web scraping / screenshots / interaction
 * Ported from OpenClaw: openclaw/src/agents/tools/browser-tool.ts
 *
 * ใน OpenClaw: ควบคุม browser ผ่าน Gateway (sandbox/host/node modes)
 * ใน MyClaw: headless Chromium ผ่าน Puppeteer (local sandbox mode)
 *
 * Actions:
 * - status: สถานะ browser
 * - start: เปิด browser
 * - stop: ปิด browser
 * - navigate: ไปยัง URL
 * - screenshot: ถ่ายภาพหน้าจอ
 * - snapshot: ดึง text content จากหน้าเว็บ (accessibility tree style)
 * - click: คลิก element
 * - type: พิมพ์ข้อความใน element
 * - fill: clear + type ใน input field
 * - press: กด keyboard key (Enter, Tab, Escape, etc.)
 * - hover: hover over element
 * - select: เลือก option ใน <select>
 * - drag: drag element ไปยัง target
 * - wait: รอ selector/navigation/timeout
 * - evaluate: รัน JavaScript ใน page
 * - console: ดู console messages
 * - dialog: จัดการ dialog (alert/confirm/prompt)
 * - tabs: แสดง tabs ทั้งหมด
 * - focus: switch tab by index
 * - open: เปิด tab ใหม่
 * - close: ปิด tab
 * - pdf: export หน้าเว็บเป็น PDF
 * - upload: upload file via file chooser
 *
 * Lazy-loaded: Puppeteer จะถูกโหลดเมื่อเรียกใช้ครั้งแรกเท่านั้น
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import path from "path";
import fs from "fs";

// ===== Lazy singleton browser =====
let browserInstance: any = null; // puppeteer.Browser
let activePage: any = null; // puppeteer.Page
let puppeteerModule: any = null;

// Console message buffer (captured per page)
const consoleBuffer: Array<{ level: string; text: string; ts: string; url: string }> = [];
const MAX_CONSOLE = 500;

// Pending dialog (captured by dialog event)
let pendingDialog: any = null; // puppeteer.Dialog

async function getPuppeteer() {
  if (!puppeteerModule) {
    puppeteerModule = await import("puppeteer");
  }
  return puppeteerModule.default || puppeteerModule;
}

function attachPageListeners(page: any) {
  // Console messages
  page.on("console", (msg: any) => {
    consoleBuffer.push({
      level: msg.type(),
      text: msg.text(),
      ts: new Date().toISOString(),
      url: page.url(),
    });
    if (consoleBuffer.length > MAX_CONSOLE) consoleBuffer.shift();
  });

  // Dialog handling (alert, confirm, prompt)
  page.on("dialog", (dialog: any) => {
    pendingDialog = dialog;
    console.log(`[browser] Dialog detected: ${dialog.type()} — "${dialog.message()}"`);
  });
}

async function getBrowser() {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }

  const puppeteer = await getPuppeteer();
  browserInstance = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  // Get or create initial page
  const pages = await browserInstance.pages();
  activePage = pages[0] || (await browserInstance.newPage());
  await activePage.setViewport({ width: 1280, height: 720 });
  attachPageListeners(activePage);

  console.log("[browser] Started headless Chromium");
  return browserInstance;
}

async function getPage() {
  await getBrowser();
  if (!activePage || activePage.isClosed()) {
    activePage = await browserInstance.newPage();
    await activePage.setViewport({ width: 1280, height: 720 });
    attachPageListeners(activePage);
  }
  return activePage;
}

// ===== Tool definition =====
const ALL_ACTIONS = [
  "status", "start", "stop", "navigate", "screenshot", "snapshot",
  "click", "type", "fill", "press", "hover", "select", "drag", "wait",
  "evaluate", "console", "dialog", "tabs", "focus", "open", "close",
  "pdf", "upload",
];

export const browserTool: ToolDefinition = {
  name: "browser",
  description:
    "Control a headless browser for web scraping, screenshots, and page interaction. Actions: " +
    '"status" check browser state, ' +
    '"start" launch browser, ' +
    '"stop" close browser, ' +
    '"navigate" go to URL, ' +
    '"screenshot" capture page image, ' +
    '"snapshot" extract page text content (like accessibility tree), ' +
    '"click" click an element by CSS selector, ' +
    '"type" type text into an element (appends), ' +
    '"fill" clear field then type (replaces), ' +
    '"press" press a keyboard key (Enter, Tab, Escape, ArrowDown, etc.), ' +
    '"hover" hover over an element, ' +
    '"select" choose option(s) in a <select> dropdown, ' +
    '"drag" drag element to target position, ' +
    '"wait" wait for selector/navigation/timeout, ' +
    '"evaluate" run JavaScript in page context, ' +
    '"console" view captured console messages, ' +
    '"dialog" handle alert/confirm/prompt dialogs (accept/dismiss), ' +
    '"tabs" list open tabs, ' +
    '"focus" switch to a specific tab by index, ' +
    '"open" open new tab with URL, ' +
    '"close" close current tab, ' +
    '"pdf" export page as PDF, ' +
    '"upload" upload file via file chooser. ' +
    "Browser starts automatically on first use.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ALL_ACTIONS,
        description: "Action to perform.",
      },
      url: {
        type: "string",
        description: "URL for navigate/open.",
      },
      selector: {
        type: "string",
        description: "CSS selector for click/type/fill/hover/select/drag/wait/upload.",
      },
      text: {
        type: "string",
        description: "Text for type/fill.",
      },
      key: {
        type: "string",
        description: 'Keyboard key for press (e.g. "Enter", "Tab", "Escape", "ArrowDown", "Backspace", "a", "Control+a").',
      },
      script: {
        type: "string",
        description: "JavaScript code for evaluate.",
      },
      fullPage: {
        type: "boolean",
        description: "Capture full page screenshot (default false).",
      },
      maxChars: {
        type: "number",
        description: "Max characters for snapshot (default 10000).",
      },
      waitMs: {
        type: "number",
        description: "Wait time in ms (for wait action timeout, or delay before other actions).",
      },
      waitFor: {
        type: "string",
        enum: ["selector", "navigation", "timeout"],
        description: 'What to wait for: "selector" (wait for element), "navigation" (page load), "timeout" (just wait). Default: "selector" if selector given, else "timeout".',
      },
      // select
      values: {
        type: "array",
        items: { type: "string" },
        description: "Option value(s) to select in <select> element.",
      },
      // drag
      targetSelector: {
        type: "string",
        description: "Target element CSS selector for drag.",
      },
      targetX: {
        type: "number",
        description: "Target X coordinate for drag (if no targetSelector).",
      },
      targetY: {
        type: "number",
        description: "Target Y coordinate for drag (if no targetSelector).",
      },
      // dialog
      accept: {
        type: "boolean",
        description: "Accept (true) or dismiss (false) the dialog. Default: true.",
      },
      promptText: {
        type: "string",
        description: "Text to enter in a prompt dialog.",
      },
      // console
      level: {
        type: "string",
        enum: ["all", "log", "info", "warn", "error", "debug"],
        description: 'Filter console messages by level (default "all").',
      },
      lines: {
        type: "number",
        description: "Number of console messages to return (default 50).",
      },
      // focus (tab)
      tabIndex: {
        type: "number",
        description: "Tab index to focus (0-based).",
      },
      // upload
      filePath: {
        type: "string",
        description: "Local file path to upload.",
      },
    },
    required: ["action"],
  },

  execute: async (input, context?: ToolContext) => {
    const action = typeof input.action === "string" ? input.action.trim() : "";
    const waitMs = typeof input.waitMs === "number" ? Math.min(30000, Math.max(0, input.waitMs)) : 0;

    try {
      switch (action) {
        // ===== status =====
        case "status": {
          const running = browserInstance && browserInstance.connected;
          let currentUrl = null;
          let pageTitle = null;
          let tabCount = 0;

          if (running) {
            try {
              const pages = await browserInstance.pages();
              tabCount = pages.length;
              if (activePage && !activePage.isClosed()) {
                currentUrl = activePage.url();
                pageTitle = await activePage.title();
              }
            } catch { /* ignore */ }
          }

          return JSON.stringify({
            running,
            currentUrl,
            pageTitle,
            tabCount,
            consoleMessages: consoleBuffer.length,
            pendingDialog: pendingDialog ? { type: pendingDialog.type(), message: pendingDialog.message() } : null,
          });
        }

        // ===== start =====
        case "start": {
          await getBrowser();
          return JSON.stringify({ success: true, message: "Browser started." });
        }

        // ===== stop =====
        case "stop": {
          if (browserInstance && browserInstance.connected) {
            await browserInstance.close();
            browserInstance = null;
            activePage = null;
            pendingDialog = null;
            consoleBuffer.length = 0;
            console.log("[browser] Stopped");
            return JSON.stringify({ success: true, message: "Browser stopped." });
          }
          return JSON.stringify({ success: true, message: "Browser was not running." });
        }

        // ===== navigate =====
        case "navigate": {
          const url = typeof input.url === "string" ? input.url.trim() : "";
          if (!url) return JSON.stringify({ error: "missing_url", message: "url is required." });

          const page = await getPage();
          const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

          if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

          const title = await page.title();
          const currentUrl = page.url();
          console.log(`[browser] Navigated to: ${currentUrl}`);

          return JSON.stringify({
            success: true,
            url: currentUrl,
            title,
            status: response?.status() || null,
          });
        }

        // ===== screenshot =====
        case "screenshot": {
          const page = await getPage();
          if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

          const fullPage = input.fullPage === true;
          const dataDir = process.env.DATA_DIR || "./data";
          const tmpDir = path.join(dataDir, "tmp");
          if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

          const filename = `screenshot-${Date.now()}.png`;
          const filepath = path.join(tmpDir, filename);

          // If selector specified, screenshot that element only
          if (typeof input.selector === "string" && input.selector.trim()) {
            const el = await page.$(input.selector.trim());
            if (!el) return JSON.stringify({ error: "element_not_found", selector: input.selector });
            await el.screenshot({ path: filepath, type: "png" });
          } else {
            await page.screenshot({ path: filepath, fullPage, type: "png" });
          }

          const fileSize = fs.statSync(filepath).size;
          console.log(`[browser] Screenshot saved: ${filepath} (${fileSize} bytes)`);

          return JSON.stringify({
            success: true,
            action: "screenshot",
            path: filepath,
            size: fileSize,
            fullPage,
            url: page.url(),
          });
        }

        // ===== snapshot =====
        case "snapshot": {
          const page = await getPage();
          if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

          const maxChars = typeof input.maxChars === "number" ? Math.max(100, Math.min(50000, input.maxChars)) : 10000;

          // Extract structured text content (similar to accessibility tree)
          const content = await page.evaluate(() => {
            const scripts = document.querySelectorAll("script, style, noscript, svg");
            scripts.forEach((s) => s.remove());

            // Build a simple text tree
            function extractNode(el: Element, depth: number): string {
              const tag = el.tagName.toLowerCase();
              const role = el.getAttribute("role") || "";
              const ariaLabel = el.getAttribute("aria-label") || "";
              const text = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
                ? (el.childNodes[0] as Text).textContent?.trim() || ""
                : "";

              const indent = "  ".repeat(depth);
              const parts: string[] = [];

              // Interactive elements get special notation
              if (tag === "a") {
                const href = (el as HTMLAnchorElement).href;
                const linkText = el.textContent?.trim() || "";
                if (linkText) parts.push(`${indent}[link: ${linkText}](${href})`);
              } else if (tag === "button" || role === "button") {
                parts.push(`${indent}[button: ${ariaLabel || el.textContent?.trim() || ""}]`);
              } else if (tag === "input") {
                const inputEl = el as HTMLInputElement;
                const type = inputEl.type || "text";
                const name = inputEl.name || inputEl.id || "";
                const val = inputEl.value || "";
                const ph = inputEl.placeholder || "";
                parts.push(`${indent}[input type=${type} name="${name}" value="${val}" placeholder="${ph}"]`);
              } else if (tag === "textarea") {
                const ta = el as HTMLTextAreaElement;
                parts.push(`${indent}[textarea name="${ta.name || ta.id || ""}" value="${ta.value?.substring(0, 100) || ""}"]`);
              } else if (tag === "select") {
                const sel = el as HTMLSelectElement;
                const opts = Array.from(sel.options).map((o) => `${o.selected ? ">" : " "}${o.text}`).join(", ");
                parts.push(`${indent}[select name="${sel.name || sel.id || ""}" options: ${opts}]`);
              } else if (tag === "img") {
                const img = el as HTMLImageElement;
                parts.push(`${indent}[image: ${img.alt || ""}](${img.src?.substring(0, 100)})`);
              } else if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
                parts.push(`${indent}${"#".repeat(parseInt(tag[1]))} ${el.textContent?.trim() || ""}`);
              } else if (text) {
                parts.push(`${indent}${text}`);
              }

              // Recurse children
              if (!text && !["a", "button", "input", "textarea", "select", "img"].includes(tag)) {
                for (const child of el.children) {
                  const childText = extractNode(child, depth + (["div", "section", "main", "article", "nav", "aside", "header", "footer", "form", "ul", "ol", "li", "table", "tr"].includes(tag) ? 1 : 0));
                  if (childText.trim()) parts.push(childText);
                }
              }

              return parts.join("\n");
            }

            return extractNode(document.body, 0);
          });

          const title = await page.title();
          const url = page.url();

          let text = content.replace(/\n{3,}/g, "\n\n").trim();
          const truncated = text.length > maxChars;
          if (truncated) text = text.substring(0, maxChars) + "...";

          return JSON.stringify({
            success: true,
            url,
            title,
            content: `[EXTERNAL CONTENT from ${url}]\n${text}`,
            charCount: text.length,
            truncated,
          });
        }

        // ===== click =====
        case "click": {
          const selector = typeof input.selector === "string" ? input.selector.trim() : "";
          if (!selector) return JSON.stringify({ error: "missing_selector", message: "selector is required." });

          const page = await getPage();
          if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

          await page.click(selector);
          await new Promise((r) => setTimeout(r, 500));

          return JSON.stringify({
            success: true,
            action: "click",
            selector,
            url: page.url(),
            title: await page.title(),
          });
        }

        // ===== type =====
        case "type": {
          const selector = typeof input.selector === "string" ? input.selector.trim() : "";
          const text = typeof input.text === "string" ? input.text : "";
          if (!selector) return JSON.stringify({ error: "missing_selector", message: "selector is required." });
          if (!text) return JSON.stringify({ error: "missing_text", message: "text is required." });

          const page = await getPage();
          if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

          await page.type(selector, text);
          return JSON.stringify({ success: true, action: "type", selector, textLength: text.length });
        }

        // ===== fill (clear + type) =====
        case "fill": {
          const selector = typeof input.selector === "string" ? input.selector.trim() : "";
          const text = typeof input.text === "string" ? input.text : "";
          if (!selector) return JSON.stringify({ error: "missing_selector", message: "selector is required." });

          const page = await getPage();
          if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

          // Triple-click to select all, then delete, then type
          await page.click(selector, { clickCount: 3 });
          await page.keyboard.press("Backspace");
          if (text) {
            await page.type(selector, text);
          }

          return JSON.stringify({ success: true, action: "fill", selector, textLength: text.length });
        }

        // ===== press (keyboard key) =====
        case "press": {
          const key = typeof input.key === "string" ? input.key.trim() : "";
          if (!key) return JSON.stringify({ error: "missing_key", message: 'key is required (e.g. "Enter", "Tab", "Escape", "Control+a").' });

          const page = await getPage();
          if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

          // Support modifier combos like "Control+a", "Shift+Enter"
          if (key.includes("+")) {
            const parts = key.split("+");
            const mainKey = parts.pop()!;
            for (const mod of parts) {
              await page.keyboard.down(mod);
            }
            await page.keyboard.press(mainKey);
            for (const mod of parts.reverse()) {
              await page.keyboard.up(mod);
            }
          } else {
            await page.keyboard.press(key);
          }

          await new Promise((r) => setTimeout(r, 300));
          return JSON.stringify({ success: true, action: "press", key, url: page.url() });
        }

        // ===== hover =====
        case "hover": {
          const selector = typeof input.selector === "string" ? input.selector.trim() : "";
          if (!selector) return JSON.stringify({ error: "missing_selector", message: "selector is required." });

          const page = await getPage();
          if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

          await page.hover(selector);
          return JSON.stringify({ success: true, action: "hover", selector });
        }

        // ===== select (dropdown) =====
        case "select": {
          const selector = typeof input.selector === "string" ? input.selector.trim() : "";
          if (!selector) return JSON.stringify({ error: "missing_selector", message: "selector is required for <select> element." });

          const vals = Array.isArray(input.values) ? input.values.map(String) : [];
          if (vals.length === 0) return JSON.stringify({ error: "missing_values", message: "values array is required." });

          const page = await getPage();
          if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

          const selected = await page.select(selector, ...vals);
          return JSON.stringify({ success: true, action: "select", selector, selected });
        }

        // ===== drag =====
        case "drag": {
          const selector = typeof input.selector === "string" ? input.selector.trim() : "";
          if (!selector) return JSON.stringify({ error: "missing_selector", message: "source selector is required." });

          const page = await getPage();
          if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

          const srcEl = await page.$(selector);
          if (!srcEl) return JSON.stringify({ error: "element_not_found", selector });

          const srcBox = await srcEl.boundingBox();
          if (!srcBox) return JSON.stringify({ error: "no_bounding_box", message: "Element has no visible bounding box." });

          let targetX: number;
          let targetY: number;

          if (typeof input.targetSelector === "string" && input.targetSelector.trim()) {
            const tgtEl = await page.$(input.targetSelector.trim());
            if (!tgtEl) return JSON.stringify({ error: "target_not_found", targetSelector: input.targetSelector });
            const tgtBox = await tgtEl.boundingBox();
            if (!tgtBox) return JSON.stringify({ error: "no_target_bounding_box" });
            targetX = tgtBox.x + tgtBox.width / 2;
            targetY = tgtBox.y + tgtBox.height / 2;
          } else if (typeof input.targetX === "number" && typeof input.targetY === "number") {
            targetX = input.targetX;
            targetY = input.targetY;
          } else {
            return JSON.stringify({ error: "missing_target", message: "Provide targetSelector or targetX+targetY." });
          }

          const srcX = srcBox.x + srcBox.width / 2;
          const srcY = srcBox.y + srcBox.height / 2;

          await page.mouse.move(srcX, srcY);
          await page.mouse.down();
          await page.mouse.move(targetX, targetY, { steps: 10 });
          await page.mouse.up();

          return JSON.stringify({ success: true, action: "drag", from: { x: srcX, y: srcY }, to: { x: targetX, y: targetY } });
        }

        // ===== wait =====
        case "wait": {
          const page = await getPage();
          const selector = typeof input.selector === "string" ? input.selector.trim() : "";
          const waitFor = typeof input.waitFor === "string" ? input.waitFor.trim() : (selector ? "selector" : "timeout");
          const timeout = typeof input.waitMs === "number" ? Math.min(30000, Math.max(100, input.waitMs)) : 5000;

          if (waitFor === "selector") {
            if (!selector) return JSON.stringify({ error: "missing_selector", message: "selector is required for wait selector." });
            await page.waitForSelector(selector, { timeout });
            return JSON.stringify({ success: true, action: "wait", waitFor: "selector", selector });
          } else if (waitFor === "navigation") {
            await page.waitForNavigation({ timeout, waitUntil: "domcontentloaded" });
            return JSON.stringify({ success: true, action: "wait", waitFor: "navigation", url: page.url() });
          } else {
            await new Promise((r) => setTimeout(r, timeout));
            return JSON.stringify({ success: true, action: "wait", waitFor: "timeout", ms: timeout });
          }
        }

        // ===== evaluate =====
        case "evaluate": {
          const script = typeof input.script === "string" ? input.script : "";
          if (!script) return JSON.stringify({ error: "missing_script", message: "script is required." });

          const page = await getPage();
          if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

          const result = await page.evaluate(script);
          const resultStr = JSON.stringify(result, null, 2) || "undefined";

          return JSON.stringify({
            success: true,
            action: "evaluate",
            result: resultStr.substring(0, 10000),
          });
        }

        // ===== console =====
        case "console": {
          const level = typeof input.level === "string" ? input.level.trim() : "all";
          const maxLines = typeof input.lines === "number" ? Math.max(1, Math.min(500, input.lines)) : 50;

          let filtered = consoleBuffer;
          if (level !== "all") {
            filtered = consoleBuffer.filter((m) => m.level === level);
          }

          const messages = filtered.slice(-maxLines);

          return JSON.stringify({
            totalBuffered: consoleBuffer.length,
            returned: messages.length,
            level,
            messages: messages.map((m) => `[${m.ts}] [${m.level}] ${m.text}`),
          });
        }

        // ===== dialog =====
        case "dialog": {
          if (!pendingDialog) {
            return JSON.stringify({ success: false, message: "No pending dialog. Dialogs are captured when they appear." });
          }

          const accept = input.accept !== false; // default true
          const promptText = typeof input.promptText === "string" ? input.promptText : undefined;

          const dialogInfo = {
            type: pendingDialog.type(),
            message: pendingDialog.message(),
            defaultValue: pendingDialog.defaultValue(),
          };

          if (accept) {
            await pendingDialog.accept(promptText);
          } else {
            await pendingDialog.dismiss();
          }

          pendingDialog = null;

          return JSON.stringify({
            success: true,
            action: "dialog",
            handled: accept ? "accepted" : "dismissed",
            dialog: dialogInfo,
            promptText,
          });
        }

        // ===== tabs =====
        case "tabs": {
          const browser = await getBrowser();
          const pages = await browser.pages();

          const tabs = await Promise.all(
            pages.map(async (p: any, i: number) => ({
              index: i,
              url: p.url(),
              title: await p.title().catch(() => ""),
              isActive: p === activePage,
            })),
          );

          return JSON.stringify({ tabs, count: tabs.length });
        }

        // ===== focus (switch tab) =====
        case "focus": {
          const tabIndex = typeof input.tabIndex === "number" ? input.tabIndex : -1;
          if (tabIndex < 0) return JSON.stringify({ error: "missing_tab_index", message: "tabIndex is required (0-based)." });

          const browser = await getBrowser();
          const pages = await browser.pages();

          if (tabIndex >= pages.length) {
            return JSON.stringify({ error: "invalid_index", message: `Tab index ${tabIndex} out of range (${pages.length} tabs).` });
          }

          activePage = pages[tabIndex];
          await activePage.bringToFront();

          return JSON.stringify({
            success: true,
            action: "focus",
            tabIndex,
            url: activePage.url(),
            title: await activePage.title(),
          });
        }

        // ===== open =====
        case "open": {
          const url = typeof input.url === "string" ? input.url.trim() : "";
          const browser = await getBrowser();
          const newPage = await browser.newPage();
          await newPage.setViewport({ width: 1280, height: 720 });
          attachPageListeners(newPage);

          activePage = newPage;

          if (url) {
            await newPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          }

          const title = await newPage.title();
          console.log(`[browser] Opened new tab: ${url || "blank"}`);

          return JSON.stringify({ success: true, action: "open", url: newPage.url(), title });
        }

        // ===== close =====
        case "close": {
          if (!activePage || activePage.isClosed()) {
            return JSON.stringify({ success: true, message: "No active tab to close." });
          }

          await activePage.close();

          const browser = await getBrowser();
          const pages = await browser.pages();
          activePage = pages.length > 0 ? pages[pages.length - 1] : null;

          return JSON.stringify({
            success: true,
            action: "close",
            remainingTabs: pages.length,
          });
        }

        // ===== pdf =====
        case "pdf": {
          const page = await getPage();
          if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

          const dataDir = process.env.DATA_DIR || "./data";
          const tmpDir = path.join(dataDir, "tmp");
          if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

          const filename = `page-${Date.now()}.pdf`;
          const filepath = path.join(tmpDir, filename);

          await page.pdf({
            path: filepath,
            format: "A4",
            printBackground: true,
          });

          const fileSize = fs.statSync(filepath).size;
          console.log(`[browser] PDF saved: ${filepath} (${fileSize} bytes)`);

          return JSON.stringify({
            success: true,
            action: "pdf",
            path: filepath,
            size: fileSize,
            url: page.url(),
          });
        }

        // ===== upload =====
        case "upload": {
          const selector = typeof input.selector === "string" ? input.selector.trim() : "";
          const filePath = typeof input.filePath === "string" ? input.filePath.trim() : "";
          if (!filePath) return JSON.stringify({ error: "missing_file_path", message: "filePath is required." });

          if (!fs.existsSync(filePath)) {
            return JSON.stringify({ error: "file_not_found", message: `File not found: ${filePath}` });
          }

          const page = await getPage();
          if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

          if (selector) {
            // Upload via input[type=file] element
            const fileInput = await page.$(selector);
            if (!fileInput) return JSON.stringify({ error: "element_not_found", selector });
            await fileInput.uploadFile(filePath);
          } else {
            // Use file chooser dialog
            const [fileChooser] = await Promise.all([
              page.waitForFileChooser({ timeout: 5000 }),
              // Trigger a click on the first file input if exists
              page.evaluate(() => {
                const input = document.querySelector('input[type="file"]') as HTMLInputElement;
                if (input) input.click();
              }),
            ]);
            await fileChooser.accept([filePath]);
          }

          return JSON.stringify({ success: true, action: "upload", filePath, selector: selector || "(file chooser)" });
        }

        default:
          return JSON.stringify({
            error: "unknown_action",
            message: `Unknown action "${action}". Available: ${ALL_ACTIONS.join(", ")}.`,
          });
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.error(`[browser] Error (${action}):`, msg);
      return JSON.stringify({ error: "action_failed", action, message: msg });
    }
  },
};
