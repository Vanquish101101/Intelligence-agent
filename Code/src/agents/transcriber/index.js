import 'dotenv/config';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function transcribeAndAnalyze(audioUrl, topic = '') {
  const transcript = await transcribeFromUrl(audioUrl);
  const analysis = await analyzeTranscript(transcript, topic);
  return { transcript, analysis };
}

export async function transcribeFromUrl(url) {
  const ext = guessExt(url);
  const tmpFile = path.join(tmpdir(), `ia_transcribe_${Date.now()}${ext}`);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  await pipeline(response.body, createWriteStream(tmpFile));

  const sizeMB = fs.statSync(tmpFile).size / (1024 * 1024);
  if (sizeMB > 25) {
    fs.unlinkSync(tmpFile);
    throw new Error(`Файл ${sizeMB.toFixed(1)}MB превышает лимит Whisper (25MB). Попробуй более короткий клип.`);
  }

  try {
    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: 'whisper-1'
    });
    return result.text;
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

async function analyzeTranscript(transcript, topic) {
  const topicHint = topic ? ` по теме "${topic}"` : '';

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://vanquish.intelligence-agent',
      'X-Title': 'Intelligence Agent'
    },
    body: JSON.stringify({
      model: 'anthropic/claude-haiku-4-5',
      messages: [{
        role: 'user',
        content: `Ты — эксперт по вирусному контенту. Проанализируй транскрипт видео${topicHint}.

ТРАНСКРИПТ:
${transcript.slice(0, 3000)}

Определи кратко:
🎣 **Хук** — что зацепляет в первые 5–10 секунд
💡 **Главная идея** — основная ценность для зрителя
🏗 **Структура** — как построено повествование
😮 **Триггеры** — эмоции и психологические крючки
✍️ **Идеи** — 2–3 идеи для похожего контента

По-русски, кратко и конкретно.`
      }],
      max_tokens: 600
    })
  });

  if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content || 'Анализ недоступен';
}

function guessExt(url) {
  const known = ['.mp3', '.mp4', '.m4a', '.wav', '.webm', '.ogg', '.flac'];
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return known.includes(ext) ? ext : '.mp4';
  } catch {
    return '.mp4';
  }
}
