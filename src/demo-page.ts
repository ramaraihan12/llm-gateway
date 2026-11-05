import type { DemoConfig } from './config.js';

// The response is drawn the way `curl -i` prints it, because the headers are
// what this page is there to show. Model output only ever goes in through
// textContent. String.raw keeps the \n in the script literal.
const script = String.raw`
const form = document.querySelector('form');
const button = form.querySelector('button');
const panel = document.getElementById('response');
const shown = ['x-gateway-provider', 'x-gateway-attempts', 'x-gateway-cache', 'x-ratelimit-remaining-requests',
  'x-demo-daily-remaining', 'retry-after'];

document.getElementById('curl').textContent = document.getElementById('curl').textContent
  .replace('ORIGIN', location.origin);

function line(text, className) {
  const el = document.createElement('div');
  el.textContent = text;
  if (className) el.className = className;
  panel.append(el);
  return el;
}

function drawHead(res) {
  panel.replaceChildren();
  line('HTTP ' + res.status + (res.ok ? ' OK' : ''), res.ok ? 'status' : 'status bad');
  for (const name of shown) {
    const value = res.headers.get(name);
    if (value !== null) line(name + ': ' + value, name === 'x-gateway-provider' ? 'hit' : '');
  }
  line('');
}

async function readStream(res, body) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let usage;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return usage;
    buffer += value;
    const events = buffer.split('\n\n');
    buffer = events.pop();
    for (const event of events) {
      const data = event.replace(/^data: ?/, '');
      if (data === '[DONE]') continue;
      const chunk = JSON.parse(data);
      if (chunk.error) throw new Error(chunk.error.message);
      usage = chunk.usage || usage;
      body.textContent += (chunk.choices[0] && chunk.choices[0].delta.content) || '';
    }
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const stream = form.elements.stream.checked;
  button.disabled = true;
  button.textContent = 'Sending...';
  panel.replaceChildren();
  line('Waiting for the gateway...', 'quiet');
  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: form.dataset.model,
        stream,
        stream_options: stream ? { include_usage: true } : undefined,
        messages: [{ role: 'user', content: form.elements.prompt.value }],
      }),
    });
    drawHead(res);
    const body = line('', 'answer');
    let usage;
    if (!res.ok) {
      const data = await res.json();
      body.className = 'answer bad';
      const busy = res.status === 502 ? '. The free Gemini tier is busy, try again in a minute.' : '';
      body.textContent = data.error.message + busy;
    } else if (stream) {
      usage = await readStream(res, body);
    } else {
      const data = await res.json();
      body.textContent = data.choices[0].message.content || '';
      usage = data.usage;
    }
    if (usage) line(usage.prompt_tokens + ' tokens in, ' + usage.completion_tokens + ' tokens out', 'quiet');
  } catch (err) {
    line(err.message, 'answer bad');
  } finally {
    button.disabled = false;
    button.textContent = 'Send prompt';
  }
});
`;

const style = `
:root {
  color-scheme: light dark;
  --bg: #e9eef5;
  --panel: #f8fafc;
  --ink: #152033;
  --muted: #55637a;
  --line: #c6d0de;
  --accent: #2743c9;
  --on-accent: #ffffff;
  --hit: #ffe680;
  --bad: #b3261e;
  --mono: ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1520;
    --panel: #171f2d;
    --ink: #e3e9f3;
    --muted: #94a2b8;
    --line: #2c374a;
    --accent: #93a6ff;
    --on-accent: #0f1520;
    --hit: #5c4a00;
    --bad: #ff9c94;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.55 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
main { max-width: 44rem; margin: 0 auto; padding: 2.5rem 1rem 4rem; }
header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
h1 { font: 700 1.6rem/1.2 var(--mono); letter-spacing: -0.02em; margin: 0; }
h2 { font-size: 1rem; margin: 2.5rem 0 0.5rem; }
p { margin: 0.5rem 0; }
a { color: var(--accent); }
code, pre, textarea { font-family: var(--mono); font-size: 0.875rem; }
.lede { font-size: 1.1rem; margin-top: 0.75rem; }
.route {
  font: 600 0.875rem/1.4 var(--mono);
  margin: 2rem 0 0;
  padding: 0.6rem 0.75rem;
  background: var(--ink);
  color: var(--bg);
  border-radius: 6px 6px 0 0;
  overflow-wrap: anywhere;
}
form { border: 1px solid var(--line); border-top: 0; border-radius: 0 0 6px 6px; background: var(--panel); }
textarea {
  display: block;
  width: 100%;
  min-height: 6rem;
  padding: 0.75rem;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  color: inherit;
  line-height: 1.5;
  resize: vertical;
}
.actions { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 0.6rem 0.75rem; }
label { display: flex; align-items: center; gap: 0.4rem; font-size: 0.9rem; }
button {
  font: 600 0.9rem/1 system-ui, sans-serif;
  padding: 0.6rem 1rem;
  border: 0;
  border-radius: 6px;
  background: var(--accent);
  color: var(--on-accent);
  cursor: pointer;
}
button:disabled { opacity: 0.6; cursor: wait; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
textarea:focus-visible { outline-offset: -2px; }
#response {
  margin-top: 1rem;
  padding: 0.75rem;
  min-height: 7rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  font: 0.875rem/1.6 var(--mono);
  overflow-wrap: anywhere;
}
#response div { min-height: 1.4em; }
.status { font-weight: 700; }
.hit { background: var(--hit); margin: 0 -0.75rem; padding: 0 0.75rem; font-weight: 600; }
.answer { font-family: system-ui, sans-serif; font-size: 1rem; white-space: pre-wrap; }
.quiet { color: var(--muted); }
.answer + .quiet { margin-top: 0.5rem; }
.bad { color: var(--bad); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 1rem; margin: 0; }
dt { font-weight: 600; }
dd { margin: 0; color: var(--muted); }
pre {
  margin: 0;
  padding: 0.75rem;
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
}
@media (max-width: 34rem) {
  dl { grid-template-columns: 1fr; }
  dd { margin-bottom: 0.5rem; }
}
`;

/** Everything interpolated here comes from the config file, never from a request. */
export function demoPage(demo: DemoConfig, targets: string[]): string {
  const target = targets.join(', ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>llm-gateway</title>
<meta name="description" content="OpenAI-compatible gateway in front of OpenAI, Gemini, Anthropic and Ollama.">
<style>${style}</style>
</head>
<body>
<main>
  <header>
    <h1>llm-gateway</h1>
    <a href="https://github.com/ramaraihan12/llm-gateway">Source on GitHub</a>
  </header>
  <p class="lede">One OpenAI-compatible endpoint in front of OpenAI, Gemini, Anthropic and Ollama. Apps ask for an alias, the gateway picks a provider and moves to the next one when it fails.</p>

  <p class="route">POST /v1/chat/completions &nbsp;model: ${demo.alias} &rarr; ${target}</p>
  <form data-model="${demo.alias}">
    <textarea name="prompt" aria-label="Prompt" maxlength="${demo.maxInputBytes - 100}" required>In one short sentence, what does an API gateway do?</textarea>
    <div class="actions">
      <label><input type="checkbox" name="stream" checked> Stream the answer</label>
      <button type="submit">Send prompt</button>
    </div>
  </form>
  <div id="response" aria-live="polite"><div class="quiet">The answer shows up here with the gateway's response headers. x-gateway-provider says which provider served it.</div></div>

  <h2>What the gateway does</h2>
  <dl>
    <dt>Fallback chains</dt><dd><code>gateway.yaml</code> maps an alias to a list of provider/model targets, tried top to bottom.</dd>
    <dt>Retries</dt><dd>429s, 5xx and network errors are retried with backoff, then the next provider takes over.</dd>
    <dt>One format</dt><dd>Gemini SSE, Anthropic events and Ollama NDJSON all come out as OpenAI chunks.</dd>
    <dt>Rate limits and cache</dt><dd>Limits per client, plus an exact-match cache for repeated requests.</dd>
    <dt>Cost log</dt><dd>Every request records tokens, latency and estimated cost in Postgres.</dd>
  </dl>

  <h2>Call it yourself</h2>
  <pre id="curl">curl -i ORIGIN/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{"model":"${demo.alias}","messages":[{"role":"user","content":"hi"}]}'</pre>

  <h2>Limits of this demo</h2>
  <p>This is the real gateway with one alias on a free Gemini key, so no API key is needed here. Other models and tool calls are refused. Messages can be ${demo.maxInputBytes} bytes, answers ${demo.maxOutputTokens} tokens. Each IP gets ${demo.perIpPerMinute} requests a minute and ${demo.perIpPerDay} a day, and the whole demo stops at ${demo.dailyCap} a day (UTC).</p>
  <p>Prompts are not stored here, but they do go to Google's free API, so leave out anything private.</p>
</main>
<script>${script}</script>
</body>
</html>
`;
}
