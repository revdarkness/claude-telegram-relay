/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context, InputFile } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { unlinkSync, existsSync } from "fs";
import { join, basename } from "path";

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT || "300000", 10); // 5 min default
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
const PIPER_DIR = join(RELAY_DIR, "piper", "piper");
const PIPER_MODEL = process.env.PIPER_MODEL || "en_US-lessac-medium.onnx";

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session tracking for conversation continuity
const SESSION_FILE = join(RELAY_DIR, "session.json");

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

let session = await loadSession();

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

// Cleanup on exit
process.on("exit", () => {
  try {
    unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

if (!ALLOWED_USER_ID) {
  console.error("TELEGRAM_USER_ID not set!");
  console.log("\nThis bot gives full Claude CLI access. Set TELEGRAM_USER_ID in .env");
  console.log("to restrict access. Send /start to @userinfobot to get your ID.");
  process.exit(1);
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();

  // If ALLOWED_USER_ID is set, enforce it
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId}`);
    await ctx.reply("This bot is private.");
    return;
  }

  await next();
});

// ============================================================
// CORE: Call Claude CLI
// ============================================================

async function callClaude(
  prompt: string,
  options?: { resume?: boolean; imagePath?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume previous session if available and requested
  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  args.push("--output-format", "text");

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // Pass through any env vars Claude might need
      },
    });

    // Race Claude execution against a timeout
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("CLAUDE_TIMEOUT")), CLAUDE_TIMEOUT_MS);
    });

    let output: string;
    let stderr: string;
    let exitCode: number;

    try {
      [output, stderr, exitCode] = await Promise.race([
        Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]),
        timeout,
      ]);
      clearTimeout(timer!);
    } catch (err: any) {
      clearTimeout(timer!);
      if (err?.message === "CLAUDE_TIMEOUT") {
        proc.kill();
        console.error(`Claude timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`);
        return `Error: Claude timed out after ${CLAUDE_TIMEOUT_MS / 1000} seconds.`;
      }
      throw err;
    }

    if (exitCode !== 0) {
      console.error("Claude error:", stderr);
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    // Extract session ID from output if present (for --resume)
    const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
    if (sessionMatch) {
      session.sessionId = sessionMatch[1];
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
    }

    return output.trim();
  } catch (error) {
    console.error("Spawn error:", error);
    return `Error: Could not run Claude CLI`;
  }
}

// ============================================================
// VOICE: Transcription (Groq Whisper) & TTS (Edge TTS / ElevenLabs)
// ============================================================

async function transcribeVoice(audioBuffer: Buffer): Promise<string> {
  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "voice.ogg");
  formData.append("model", "whisper-large-v3-turbo");

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: formData,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq transcription failed: ${response.status} ${err}`);
  }

  const result = await response.json();
  return result.text;
}

async function piperTTS(text: string): Promise<Buffer> {
  const oggFile = join(TEMP_DIR, `tts_${Date.now()}.ogg`);
  const piperBin = join(PIPER_DIR, "piper");
  const modelPath = join(PIPER_DIR, PIPER_MODEL);
  try {
    // Pipe piper raw audio directly into ffmpeg — no intermediate WAV file
    const proc = spawn(
      ["bash", "-c", `"${piperBin}" --model "${modelPath}" --output-raw | ffmpeg -y -f s16le -ar 22050 -ac 1 -i pipe:0 -c:a libopus -b:a 48k -ar 48000 "${oggFile}"`],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, LD_LIBRARY_PATH: PIPER_DIR },
      }
    );
    proc.stdin.write(text);
    proc.stdin.end();
    await proc.exited;
    return await readFile(oggFile);
  } finally {
    await unlink(oggFile).catch(() => {});
  }
}

async function elevenLabsTTS(text: string): Promise<Buffer> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=opus_48000_64`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs TTS failed: ${response.status} ${err}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function textToSpeech(text: string): Promise<Buffer> {
  // Use ElevenLabs if configured, otherwise use local espeak-ng
  if (ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID) {
    try {
      return await elevenLabsTTS(text);
    } catch (err) {
      console.error("ElevenLabs failed, falling back to Piper:", err);
    }
  }
  return await piperTTS(text);
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Debug: log all incoming message types
bot.on("message", async (ctx, next) => {
  const msg = ctx.message;
  const types = ["text", "voice", "audio", "photo", "document", "video", "sticker", "video_note"] as const;
  const detected = types.filter((t) => t in msg && (msg as any)[t]);
  console.log(`[DEBUG] Message types: ${detected.join(", ") || "unknown"}`);
  await next();
});

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  console.log(`Message: ${text.substring(0, 50)}...`);

  await ctx.replyWithChatAction("typing");

  // Add any context you want here
  const enrichedPrompt = buildPrompt(text);

  const response = await callClaude(enrichedPrompt, { resume: true });
  await sendVoiceAndText(ctx, response);
});

// Voice messages & audio files
bot.on(["message:voice", "message:audio"], async (ctx) => {
  const type = ctx.message.voice ? "voice" : "audio";
  console.log(`${type} message received`);
  await ctx.replyWithChatAction("typing");

  if (!GROQ_API_KEY) {
    await ctx.reply("Voice transcription requires GROQ_API_KEY to be set.");
    return;
  }

  let filePath: string | null = null;
  try {
    // Download voice OGG from Telegram
    const file = await ctx.getFile();
    const timestamp = Date.now();
    filePath = join(TEMP_DIR, `voice_${timestamp}.ogg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    const audioBuffer = Buffer.from(await response.arrayBuffer());
    await writeFile(filePath, audioBuffer);

    // Transcribe via Groq Whisper
    const transcription = await transcribeVoice(audioBuffer);
    console.log(`Transcription: ${transcription.substring(0, 80)}...`);

    // Send to Claude
    const enrichedPrompt = buildPrompt(`[Voice]: ${transcription}`);
    const claudeResponse = await callClaude(enrichedPrompt, { resume: true });

    await sendVoiceAndText(ctx, claudeResponse);
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message.");
  } finally {
    if (filePath) await unlink(filePath).catch(() => {});
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  console.log("Image received");
  await ctx.replyWithChatAction("typing");

  try {
    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    // Download the image
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    // Claude Code can see images via file path
    const caption = ctx.message.caption || "Analyze this image.";
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    const claudeResponse = await callClaude(prompt, { resume: true });

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    await sendResponse(ctx, claudeResponse);
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = basename(doc.file_name || `file_${timestamp}`);
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const prompt = `[File: ${filePath}]\n\n${caption}`;

    const claudeResponse = await callClaude(prompt, { resume: true });

    await unlink(filePath).catch(() => {});

    await sendResponse(ctx, claudeResponse);
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
});

// ============================================================
// HELPERS
// ============================================================

function buildPrompt(userMessage: string): string {
  // Add context to every prompt
  // Customize this for your use case

  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `
You are JARVIS — a highly intelligent AI assistant responding via Telegram.
Personality: formal but witty, with dry humor. Address the user as "sir" occasionally.
Be concise and efficient. Prioritize clarity and substance over filler.

Current time: ${timeStr}

User: ${userMessage}
`.trim();
}

async function sendVoiceAndText(ctx: Context, response: string): Promise<void> {
  try {
    const speechBuffer = await textToSpeech(response);
    await ctx.replyWithVoice(new InputFile(speechBuffer, "response.ogg"), {
      caption: response.length <= 1024 ? response : undefined,
    });
    // If caption was too long, send full text separately
    if (response.length > 1024) {
      await sendResponse(ctx, response);
    }
  } catch (ttsError) {
    console.error("TTS error, falling back to text:", ttsError);
    await sendResponse(ctx, response);
  }
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  // Split long responses
  const chunks = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a natural boundary
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

// ============================================================
// START
// ============================================================

bot.catch((err) => {
  console.error("Bot error:", err.message || err);
});

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);

bot.start({
  allowed_updates: ["message", "callback_query"],
  onStart: () => {
    console.log("Bot is running!");
  },
});
