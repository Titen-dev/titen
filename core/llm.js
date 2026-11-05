import { getConfig } from './config.js';
import { TitenError, ErrorCodes } from './errors.js';

function errorFromStatus(status, msg) {
  if (status === 401 || status === 403) return new TitenError(ErrorCodes.BAD_KEY, 'Your OpenRouter API key was rejected. Run `titen setup` to set a valid key.', { status });
  if (status === 402) return new TitenError(ErrorCodes.NO_CREDIT, 'Your OpenRouter account is out of credit. Top up at https://openrouter.ai/credits', { status });
  if (status === 429) return new TitenError(ErrorCodes.RATE_LIMIT, 'The AI provider is rate limiting requests. Try again in a minute.', { status });
  return new TitenError(ErrorCodes.LLM_ERROR, `AI provider error (${status}): ${msg}`, { status });
}

/**
 * One call to OpenRouter chat/completions (OpenAI-compatible).
 * Returns the raw response JSON. Adds its usage to `usage` when given.
 */
export async function chat({
  messages,
  tools,
  toolChoice,
  plugins,
  model,
  maxTokens = 2000,
  temperature,
  timeoutMs = 120_000,
  signal,
  usage,
  config = getConfig(),
}) {
  if (!config.apiKey) {
    throw new TitenError(ErrorCodes.NO_KEY, 'No OpenRouter API key found. Run `titen setup` (or set OPENROUTER_API_KEY).');
  }

  const body = { model: model || config.model, messages, max_tokens: maxTokens, usage: { include: true } };
  if (temperature !== undefined) body.temperature = temperature;
  if (tools?.length) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }
  if (plugins?.length) body.plugins = plugins;

  const deadline = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/titen-agent',
        'X-Title': 'Titen',
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
  } catch (e) {
    if (deadline.aborted) throw new TitenError(ErrorCodes.TIMEOUT, 'The AI took too long to answer. Please try again.');
    if (signal?.aborted) throw e;
    throw new TitenError(ErrorCodes.LLM_ERROR, 'Could not reach OpenRouter. Check your internet connection.', { cause: e });
  }

  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    // OpenRouter sometimes answers 200 with an error object that carries the real code.
    const status = !res.ok ? res.status : Number.isInteger(data?.error?.code) ? data.error.code : 500;
    throw errorFromStatus(status, data?.error?.message || res.statusText || 'unknown error');
  }
  const message = data?.choices?.[0]?.message;
  if (!message) throw new TitenError(ErrorCodes.LLM_ERROR, 'The AI returned an empty response.');
  usage?.add(data.usage);
  return data;
}

/** Pull the first JSON object out of a model reply (handles ```json fences and chatter). */
export function extractJSON(text) {
  const s = String(text ?? '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : s;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object found');
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Ask for a JSON object. `validate(obj)` must return the cleaned object or throw
 * with a helpful message. On a bad reply the model gets one retry with the error.
 */
export async function chatJSON({ system, user, validate = (x) => x, ...rest }) {
  const messages = [
    { role: 'system', content: `${system}\n\nReply with ONE valid JSON object only. No markdown fences, no text before or after it.` },
    { role: 'user', content: user },
  ];

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const data = await chat({ messages, ...rest });
    const content = data.choices[0].message.content || '';
    try {
      return validate(extractJSON(content));
    } catch (e) {
      lastErr = e;
      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: `That reply was not usable: ${e.message}. Send the corrected JSON object only.` });
    }
  }
  throw new TitenError(ErrorCodes.BAD_OUTPUT, `The AI gave an answer in the wrong format (${lastErr?.message}). Please try again.`);
}

/** Check a key against OpenRouter's /key endpoint. Returns key info or throws. */
export async function checkKey(apiKey, config = getConfig()) {
  const res = await fetch(`${config.baseUrl}/key`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => {
    throw new TitenError(ErrorCodes.LLM_ERROR, 'Could not reach OpenRouter to check the key.', { cause: e });
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw errorFromStatus(res.status, data?.error?.message || res.statusText);
  return data?.data || {};
}
