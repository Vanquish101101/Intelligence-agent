import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  process.stderr.write('Error: OPENAI_API_KEY environment variable is required\n');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const server = new Server(
  { name: 'whisper-mcp-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'transcribe_audio',
      description: 'Download an audio/video file from a URL and transcribe it to text using OpenAI Whisper. Use when a video has no subtitles or captions available.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Direct URL to an audio or video file (mp3, mp4, m4a, wav, webm, ogg)'
          },
          language: {
            type: 'string',
            description: 'Language hint for better accuracy (e.g. "ru" for Russian, "en" for English). Optional.'
          },
          prompt: {
            type: 'string',
            description: 'Optional context hint to improve transcription accuracy (e.g. topic or keywords)'
          }
        },
        required: ['url']
      }
    },
    {
      name: 'transcribe_youtube_fallback',
      description: 'Transcribe a YouTube video when no auto-captions are available. Requires a direct audio URL extracted by Apify (not the youtube.com URL itself).',
      inputSchema: {
        type: 'object',
        properties: {
          audio_url: {
            type: 'string',
            description: 'Direct audio stream URL from the video (extracted by Apify youtube-scraper actor)'
          },
          language: {
            type: 'string',
            description: 'Language hint (e.g. "ru", "en")'
          }
        },
        required: ['audio_url']
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'transcribe_audio' || name === 'transcribe_youtube_fallback') {
      const url = args.url || args.audio_url;
      const language = args.language || undefined;
      const prompt = args.prompt || undefined;

      // Download to temp file
      const ext = getExtension(url);
      const tmpFile = path.join(tmpdir(), `whisper_${Date.now()}${ext}`);

      await downloadFile(url, tmpFile);

      const fileSizeMB = fs.statSync(tmpFile).size / (1024 * 1024);
      if (fileSizeMB > 25) {
        fs.unlinkSync(tmpFile);
        return {
          content: [{
            type: 'text',
            text: `Error: File size ${fileSizeMB.toFixed(1)}MB exceeds OpenAI Whisper limit of 25MB. Try a shorter clip.`
          }]
        };
      }

      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpFile),
        model: 'whisper-1',
        language,
        prompt
      });

      fs.unlinkSync(tmpFile);

      return {
        content: [{
          type: 'text',
          text: transcription.text
        }]
      };
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Transcription error: ${error.message}`
      }],
      isError: true
    };
  }
});

async function downloadFile(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(destPath));
}

function getExtension(url) {
  const knownExts = ['.mp3', '.mp4', '.m4a', '.wav', '.webm', '.ogg', '.flac'];
  const urlPath = new URL(url).pathname;
  const ext = path.extname(urlPath).toLowerCase();
  return knownExts.includes(ext) ? ext : '.mp4';
}

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('Whisper MCP server running on stdio\n');
