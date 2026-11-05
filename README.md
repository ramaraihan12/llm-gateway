# llm-gateway

![ci](https://github.com/ramaraihan12/llm-gateway/actions/workflows/ci.yml/badge.svg)

A small OpenAI-compatible gateway in front of OpenAI, Gemini, Anthropic and Ollama. Apps call one endpoint with an alias like `fast`, the gateway picks a provider, falls back to the next one when it fails, and logs tokens, latency and estimated cost for every request.

**Live demo:** https://llm-gateway-red.vercel.app, no key or login. Send a prompt and see which provider answered. It's the real gateway on one Gemini alias, with tight limits (see [the public demo](#the-public-demo)). The database sleeps when idle, which can add about a second to the first request after a quiet spell.

With no cloud keys set, every alias falls through to local Ollama, so you can try it without paying anything. One catch: keys already exported in your shell win over `.env`, even over an empty value there. Check the `providers loaded` line in the startup log before assuming everything is local.

## What it looks like

A real run on my laptop (RTX 3060 6 GB, no cloud keys, so `fast` ends up on Ollama):

```console
$ curl -si localhost:8080/v1/chat/completions -H "authorization: Bearer $GW_KEY" \
    -H 'content-type: application/json' \
    -d '{"model":"fast","messages":[{"role":"user","content":"In one short sentence, what does an API gateway do?"}],"max_tokens":60}'
HTTP/1.1 200 OK
x-gateway-attempts: 1
x-gateway-cache: miss
x-gateway-provider: ollama/qwen3.5-9b:iq4xs
x-ratelimit-limit-requests: 30
x-ratelimit-remaining-requests: 29

{"id":"chatcmpl-p7Wn9lr2pW-n47y5","object":"chat.completion","created":1792382503,"model":"qwen3.5-9b:iq4xs",
 "choices":[{"index":0,"message":{"role":"assistant","content":"An API gateway acts as a single entry point that
 manages, secures, and routes requests to multiple backend services."},"finish_reason":"stop"}],
 "usage":{"prompt_tokens":24,"completion_tokens":24,"total_tokens":48}}
```

With `"stream": true` Ollama's NDJSON comes out as normal OpenAI chunks (trimmed):

```
data: {"id":"chatcmpl-o4BkYt23vUp7hQSN","object":"chat.completion.chunk",...,"delta":{"role":"assistant","content":"1"},"finish_reason":null}]}
data: {"id":"chatcmpl-o4BkYt23vUp7hQSN","object":"chat.completion.chunk",...,"delta":{"content":" 2"},"finish_reason":null}]}
data: {"id":"chatcmpl-o4BkYt23vUp7hQSN","object":"chat.completion.chunk",...,"delta":{},"finish_reason":"stop"}]}
data: {"id":"chatcmpl-o4BkYt23vUp7hQSN","object":"chat.completion.chunk",...,"choices":[],"usage":{"prompt_tokens":24,"completion_tokens":10,"total_tokens":34}}
data: [DONE]
```

To see the fallback for real I put an OpenAI-style provider on a closed port in front of Ollama. Three tries with backoff, then Ollama answers and the response says `x-gateway-attempts: 4` (log lines trimmed):

```
WARN provider call failed  target=flaky/gpt-5.4-mini attempt=1 err="network error: connect ECONNREFUSED 127.0.0.1:59999"
WARN provider call failed  target=flaky/gpt-5.4-mini attempt=2 err="network error: connect ECONNREFUSED 127.0.0.1:59999"
WARN provider call failed  target=flaky/gpt-5.4-mini attempt=3 err="network error: connect ECONNREFUSED 127.0.0.1:59999"
INFO request  method=POST path=/v1/chat/completions status=200
```

The official `openai` Python client works unchanged, tool calls included. A weather tool round trip, answer streamed:

```
tool call: get_weather {"city":"Salatiga"}
answer: The current weather in Salatiga is 24°C with light rain.
```

## How it works

- `gateway.yaml` maps aliases to fallback chains of `provider/model`. Providers without an API key are dropped at startup, so a chain like gemini, openai, ollama still works on a machine with no keys.
- Each provider adapter is plain `fetch`, no SDKs. It translates messages, tools, `tool_choice`, finish reasons and usage both ways, and turns Anthropic content-block events, Gemini SSE and Ollama NDJSON into OpenAI `chat.completion.chunk`s.
- 429, 5xx and network errors are retried on the same provider with exponential backoff and full jitter, honouring `Retry-After` up to the cap. Timeouts and other 4xx errors go straight to the next provider, so one hung provider costs one timeout, not three. A stream can still fall back until its first chunk is sent.
- Client keys are 32 random bytes, stored as sha256 hashes. Each key has its own requests-per-minute token bucket.
- Every request writes a row to `usage_logs` (provider, model, tokens, latency, attempts, cache hit, cost from the `pricing` table in the config). `GET /admin/usage` sums them per model and per key.
- Exact-match cache for non-streaming requests, in memory and scoped per API key. The shipped config turns it on for 5 minutes, so the same prompt gets the same answer in that window. Set `cache.enabled: false` if you don't want that.

## Stack

TypeScript (strict), Hono on Node, Drizzle + Postgres, Zod, pino, Vitest + msw, pnpm.

## Run it

You need Node 22.12+ (I use 24), pnpm, an empty Postgres database and Ollama.

```bash
pnpm install
cp .env.example .env                     # set DATABASE_URL and ADMIN_TOKEN
pnpm db:migrate
pnpm key:create --name my-app --rpm 60   # prints the key once, only the hash is kept
pnpm dev                                 # http://localhost:8080
```

The shipped `gateway.yaml` uses `qwen3.5-9b:iq4xs` because that is what my Ollama has. Change the `ollama/...` entries to something from `ollama list`. Cloud providers switch on as soon as their key is in `.env` or in your shell, see `.env.example` for the names.

Then point any OpenAI client at `http://localhost:8080/v1` with the key from above:

```bash
curl localhost:8080/v1/chat/completions -H "authorization: Bearer $GW_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"fast","messages":[{"role":"user","content":"hi"}]}'
```

`pnpm key:list` shows every key by its prefix, and `pnpm key:revoke gw-AbC1234` switches one off right away.

`model` can be an alias or a direct `provider/model` like `ollama/qwen3.5-9b:iq4xs`. `GET /v1/models` lists the aliases that have at least one usable provider. `GET /admin/usage?since=2026-10-01` with `Authorization: Bearer $ADMIN_TOKEN` gives the summary, last 24 hours by default.

With Docker, `docker compose up --build` starts Postgres and the gateway on port 8080 and runs the migrations on start. Ollama stays on the host. Create a key with:

```bash
docker compose exec gateway node dist/cli/create-key.js --name my-app
```

`list-keys.js` and `revoke-key.js` sit next to it.

## The public demo

A gateway that holds a provider key and answers anyone is an open proxy, so the demo doesn't run the normal config. `GATEWAY_CONFIG=gateway.demo.yaml` has one provider, one alias and a `demo` block, and that block changes how requests are handled (`src/demo.ts`):

- Client keys are off. Everyone is anonymous and gets the same limits, and sending a key changes nothing.
- Only `"model": "demo"` is served. Other aliases and direct `provider/model` refs get a 403, even one that names the demo's own model. Tools get a 400.
- Messages are capped at 2000 bytes. There's no tokenizer here, so the cap is in bytes: on Gemini that came to about 400 tokens of English and 1400 of random characters.
- `max_tokens` and `max_completion_tokens` are both capped at 256, and 256 is sent when the client asks for nothing. Gemini treats that as a target: most capped answers stop at 252 tokens, but a list of numbers came back with 422.
- Each IP gets 5 requests a minute and 20 a day, and the whole demo stops at 100 a day (UTC).

Vercel runs this as a function (`api/index.ts`), which is why memory won't do for the limits: every instance would count on its own. They live in the `demo_quota` table instead, and each hit is one `INSERT ... ON CONFLICT DO UPDATE ... WHERE hits < limit`, so instances racing for the last request can't both get it. If Postgres can't be reached the request is refused, not waved through. Checks that don't need the database run first, so junk traffic doesn't wake it up.

The IP comes from `x-real-ip`, which Vercel overwrites. On another host `demo.ipHeader` has to be a header that host sets itself, or clients can pick their own bucket. Only `application/json` is accepted, because a browser can send `text/plain` from any website without a preflight and spend the daily cap that way.

To deploy your own, run `pnpm db:migrate`, then set `DATABASE_URL`, `ADMIN_TOKEN`, `GEMINI_API_KEY` and `GATEWAY_CONFIG=gateway.demo.yaml` for production only. On Neon use the pooled connection string, drop `channel_binding` from it (`postgres` passes unknown parameters on to the server) and use `sslmode=verify-full`, because `require` doesn't check the certificate with this driver.

## Tests

```bash
pnpm test
```

Every upstream API is mocked with msw, so no keys or network needed. The Postgres store test only runs when `TEST_DATABASE_URL` points at a database (CI does this). `pnpm typecheck` and `pnpm lint` are the other CI steps.

## Notes

- I've run Ollama and Gemini end to end, Gemini through the public demo (plain and streaming requests, not tool calls). The OpenAI and Anthropic adapters are written against their docs and tested against mocked responses shaped like their docs, not live calls.
- Per-key rate limits and the cache live in process memory. Fine for one instance, but with several replicas each one counts on its own. Redis would be the next step. Only the public demo's limits are in Postgres.
- Only text content goes through. Image parts get a 400 instead of being silently dropped, and so do OpenAI parameters the adapters don't translate yet (`response_format`, `seed`, penalties, logprobs and a few more) unless they are at their default. Mapping JSON mode onto each provider is next on my list.
- Once a stream has sent its first chunk there is no falling back. If the provider dies halfway the client gets an error event and the usage row is marked as an error.
