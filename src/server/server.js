import express from "express"
import dotenv from "dotenv"
import OpenAI from "openai"
import cors from "cors"
import path from "path"
import { fileURLToPath } from "url"
dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

app.use(express.static(path.join(__dirname, "../../dist")))
const PORT = process.env.PORT || 8080

// Make sure this exists in your .env file
// OPENAI_API_KEY=sk-xxxxx
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is missing in .env file")
  process.exit(1)
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

// Optional: change model if you want
const MODEL = "gpt-5.2-mini"

// ------------------------------
// Test Route
// ------------------------------
app.get("/api/test-ai", async (req, res) => {
  try {
    const response = await client.responses.create({
      model: MODEL,
      input: "Say CONNECTED if the AI is working."
    })

    return res.json({
      success: true,
      message: response.output_text
    })
  } catch (err) {
    console.error("TEST AI ERROR:", err)
    return res.status(500).json({
      success: false,
      error: err?.message || String(err)
    })
  }
})

// ------------------------------
// Breakdown Route (THIS FIXES 404)
// ------------------------------
app.post("/api/breakdown", async (req, res) => {
  try {
    const { title, minutes, priority, dread, context } = req.body

    if (!title || typeof title !== "string") {
      return res.status(400).json({
        success: false,
        error: "Task title required"
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
`

    const response = await client.responses.create({
      model: MODEL,
      input: prompt
    })

    const raw = (response.output_text || "").trim()

    const steps = raw
      .split("\n")
      .map((s) =>
        s.replace(/^(\s*[-•]\s*|\s*\d+[\.\)]\s*)/, "").trim()
      )
      .filter(Boolean)
      .slice(0, 8)

    return res.json({
      success: true,
      steps
    })
  } catch (err) {
    console.error("AI BREAKDOWN ERROR:", err)

    return res.status(500).json({
      success: false,
      error: err?.message || String(err)
    })
  }
})

// ------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`)
})