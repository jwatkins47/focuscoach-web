// src/server/server.js
import express from "express"
import dotenv from "dotenv"
import OpenAI from "openai"
import cors from "cors"
import path from "path"
import { fileURLToPath } from "url"
import pkg from "pg"

const { Pool } = pkg

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 8080

// --- ESM dirname ---
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// --- Serve frontend build (Vite output) ---
app.use(express.static(path.join(__dirname, "../../dist")))

// --- Required env ---
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is missing")
  process.exit(1)
}
if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is missing")
  process.exit(1)
}

// --- OpenAI client ---
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

// Use env if you set it in Railway; fallback is safe
const MODEL = process.env.OPENAI_MODEL || "gpt-5-mini"

// --- Postgres pool ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

// ------------------------------
// DB init
// ------------------------------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      steps JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)
}

// ------------------------------
// Test Route
// ------------------------------
app.get("/api/test-ai", async (req, res) => {
  try {
    const response = await client.responses.create({
      model: MODEL,
      input: "Say CONNECTED if the AI is working.",
    })

    return res.json({
      success: true,
      message: response.output_text,
    })
  } catch (err) {
    console.error("TEST AI ERROR:", err)
    return res.status(500).json({
      success: false,
      error: err?.message || String(err),
    })
  }
})

// ------------------------------
// Breakdown Route (generate + save)
// ------------------------------
app.post("/api/breakdown", async (req, res) => {
  try {
    const { title, minutes, priority, dread, context } = req.body

    if (!title || typeof title !== "string") {
      return res.status(400).json({
        success: false,
        error: "Task title required",
      })
    }

    const prompt = `
Break this task into a contained, linear sequence of steps that leads to a meaningful completion.

Rules:
- Always start with an extremely small, low-friction first step.
- Do not include any decision-making inside steps (no "choose", "decide", "pick", "review").
- Avoid vague verbs like "organize", "plan", or "improve" without specifying exactly what to do.
- Each step must be concrete and physically executable.
- Keep steps concise (under 15 words each).
- Dynamically choose the number of steps based on task complexity (usually 5-9).
- End with a clear completion step and explicitly say "Stop."

The result should feel safe, finite, and linear.

Task: ${title}
Time available: ${minutes || "unknown"} minutes
Priority: ${priority || "unknown"}
Dread level: ${dread || "unknown"}
Context: ${context || "unknown"}
`.trim()

    const response = await client.responses.create({
      model: MODEL,
      input: prompt,
    })

    const raw = (response.output_text || "").trim()

    const steps = raw
      .split("\n")
      .map((s) => s.replace(/^(\s*[-•]\s*|\s*\d+[\.\)]\s*)/, "").trim())
      .filter(Boolean)
      .slice(0, 9)

    // Save to DB
    const saved = await pool.query(
      `INSERT INTO tasks (title, steps) VALUES ($1, $2) RETURNING id, created_at`,
      [title, JSON.stringify(steps)]
    )

    return res.json({
      success: true,
      steps,
      task: saved.rows[0],
    })
  } catch (err) {
    console.error("AI BREAKDOWN ERROR:", err)
    return res.status(500).json({
      success: false,
      error: err?.message || String(err),
    })
  }
})

// ------------------------------
// List saved tasks (history)
// ------------------------------
app.get("/api/tasks", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, steps, created_at
       FROM tasks
       ORDER BY created_at DESC
       LIMIT 50`
    )

    return res.json({ success: true, tasks: result.rows })
  } catch (err) {
    console.error("GET TASKS ERROR:", err)
    return res.status(500).json({
      success: false,
      error: err?.message || String(err),
    })
  }
})

// ------------------------------
// Serve SPA for all non-API routes
// ------------------------------
app.get("*", (req, res) => {
  // Don't steal API routes
  if (req.path.startsWith("/api/")) return res.status(404).send("Not Found")
  res.sendFile(path.join(__dirname, "../../dist/index.html"))
})

// ------------------------------
// Start
// ------------------------------
async function start() {
  try {
    await initDb()
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`)
    })
  } catch (err) {
    console.error("❌ Server failed to start:", err)
    process.exit(1)
  }
}

start()