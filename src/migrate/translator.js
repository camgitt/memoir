import { getConfig, saveConfig } from '../config.js';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const RETRYABLE_CODES = [429, 500, 502, 503];

export async function resolveApiKey(inquirer) {
  // 1. Check env var
  if (process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY;
  }

  // 2. Check memoir config
  const config = await getConfig() || {};
  if (config.geminiApiKey) {
    return config.geminiApiKey;
  }

  // 3. Prompt user
  const { apiKey } = await inquirer.prompt([{
    type: 'password',
    name: 'apiKey',
    message: 'Gemini API key (free at aistudio.google.com):',
    mask: '*',
    validate: (v) => v.length > 10 || 'Please enter a valid API key'
  }]);

  // Save for next time
  config.geminiApiKey = apiKey;
  await saveConfig(config);

  return apiKey;
}

async function callGeminiApi(prompt, apiKey) {
  const response = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 8192
      }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    if (response.status === 400 || response.status === 403) {
      throw new Error('Invalid Gemini API key. Get a free key at https://aistudio.google.com');
    }
    if (RETRYABLE_CODES.includes(response.status)) {
      const error = new Error(`Gemini API error (${response.status}): ${err}`);
      error.retryable = true;
      throw error;
    }
    throw new Error(`Gemini API error (${response.status}): ${err}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error('Empty response from Gemini API');
  }

  return text.trim();
}

export async function translateMemory(content, sourceProfile, targetProfile, apiKey) {
  const prompt = `You are an expert at translating AI coding assistant memory/instruction files between different tools.

SOURCE TOOL: ${sourceProfile.name}
SOURCE FORMAT: ${sourceProfile.format}

TARGET TOOL: ${targetProfile.name}
TARGET FORMAT: ${targetProfile.format}

INSTRUCTIONS:
- Translate the content below so it works perfectly as a ${targetProfile.name} instruction file.
- Preserve ALL information, preferences, conventions, and context from the source.
- Adapt the structure and phrasing to match ${targetProfile.name}'s conventions.
- Remove any tool-specific references that don't apply to ${targetProfile.name}.
- Keep the tone direct and instructional.
- Output ONLY the translated content, no explanations or wrapping.

SOURCE CONTENT:
${content}`;

  try {
    return await callGeminiApi(prompt, apiKey);
  } catch (err) {
    if (err.retryable) {
      await new Promise(r => setTimeout(r, 3000));
      return await callGeminiApi(prompt, apiKey);
    }
    throw err;
  }
}
