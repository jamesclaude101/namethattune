# Name That Tune

Lyrics trivia from 1985 to now. One screen hosts, up to six phones play, the
fastest correct answer wins the question.

Live at **https://namethattune.checkthislist.com**

## How a game goes

1. Someone opens the site on the TV and taps **Host a game**, picks eras,
   round length and clock, then opens the room.
2. The TV shows a four-letter code. Everyone else opens the same URL on their
   phone, taps **Join with a code**, and types the code and their name.
3. The host taps start. The question goes up on the TV with four colored,
   shaped answers; the same four buttons appear on every phone.
4. Points are half for being right and half for being quick, plus a streak
   bonus. Reveal shows the answer and the song, then the host moves on.

## Layout

```
web/                    static client, both roles
  index.html            every screen as a <template>
  app.js               state machine + polling; no framework
  styles.css           one stylesheet, .view.host scales up for a TV
  staticwebapp.config.json

api/                    Azure Functions (Node 20), the whole game
  shared/bank.json      THE QUESTIONS — the only file you edit to add content
  shared/engine.js      dealing, scoring, phases, public projection (pure)
  shared/store.js       Cosmos, with an in-memory fallback for local runs
  shared/http.js        JSON responses + bearer auth
  health/ rooms-*/      one folder per endpoint

infra/main.bicep        Cosmos serverless + Static Web App
infra/deploy.ps1        provisions it and prints the token and DNS records
tools/check-bank.js     CI guard against bad questions
API.md                  the API contract (also the iOS spec)
```

## Why it is built this way

**The server owns the game.** Clients never see a correct answer before the
reveal, and never compute a score. A doctored request cannot buy points because
elapsed time comes from the server's own timestamp on the question. This is not
paranoia about cheating at a party game — it is what makes a second client
(iOS) a few hundred lines instead of a reimplementation.

**No realtime service.** Six players in one room do not need WebSockets. The
host screen polls every 600ms, and that poll is also what closes a question
whose clock has run out. That removes a billable service, a reconnect state
machine, and the whole class of "my phone fell asleep" bugs. If it ever feels
laggy, Azure Web PubSub drops in behind the same API without touching client
logic.

**Questions live in git, not the database.** They are small, read-only and
reviewable in a diff. `tools/check-bank.js` runs in CI and rejects duplicate
ids, duplicate prompts, repeated choices and bad metadata.

**No audio.** The questions paraphrase lyrics rather than quoting them, and
nothing is streamed. That keeps the game clear of music licensing entirely, and
sidesteps synchronising playback across six phones. The trade-off is real: the
name promises audio the game does not deliver.

## Deploying

You need an Azure subscription, a GitHub repo and DNS control over
`checkthislist.com`. You do **not** need Node installed — the GitHub Action
builds in the cloud.

```powershell
az login
./infra/deploy.ps1
```

It prints the deployment token, the default hostname and the exact DNS record.
Then:

1. Add the token to the GitHub repo as the secret `AZURE_STATIC_WEB_APPS_API_TOKEN`.
2. Push to `main`. The Action deploys `web/` and `api/`.
3. Add the CNAME at your DNS host.
4. `az staticwebapp hostname set --name namethattune-swa --resource-group namethattune-rg --hostname namethattune.checkthislist.com`

Smoke test: `curl https://<hostname>/api/v1/health` should report
`"persistence": "cosmos"`. If it says `"memory"`, the Cosmos app setting did
not land and rooms will disappear when the function app recycles.

## Running locally

Optional, and needs Node 20 plus the SWA CLI:

```bash
npm install -g @azure/static-web-apps-cli
cd api && npm install && cd ..
swa start web --api-location api
```

With no `COSMOS_CONNECTION_STRING` the API keeps rooms in memory, which is
enough to play through a round on one machine.

## Adding questions

Edit `api/shared/bank.json`. One object per question:

```json
{
  "id": "short-slug",
  "prompt": "In “Song,” what did the artist say about the thing?",
  "answer": "The right one",
  "wrong": ["A plausible one", "Another plausible one", "A third"],
  "song": "Song", "artist": "Artist", "year": 1994,
  "era": "90s", "difficulty": "medium"
}
```

Rules that CI enforces: unique `id`, unique `prompt`, exactly three `wrong`,
no two choices alike, `era` in `80s 90s 00s 10s 20s`, `difficulty` in
`easy medium hard`, `year` between 1985 and now.

Rules CI cannot enforce, so mind them yourself:

- Paraphrase lyrics, do not quote them. "What does Axl compare her eyes to?"
  not a transcribed line.
- Make the three wrong answers genuinely plausible. A distractor that is the
  wrong *kind* of thing (a song title among album titles) gives the answer away.
- Spread difficulty. A round that is all deep cuts is not fun.

**The bank holds 278 questions** — 53 from the late '80s, 58 from the '90s,
57 from the '00s, 59 from the '10s and 51 from the '20s. A 20-question
all-eras round therefore draws four from each decade, and a group can play
several nights before seeing a repeat.

A handful of songs carry two questions each. The dealer tracks which songs it
has already used in a round and skips past a second question about the same
track, falling back to a repeat only if the pool is too thin to avoid one.

## Where the iPhone app fits

The API is already the full game surface and is versioned at `/api/v1`, so the
iOS app is a client, not a port. See the notes at the end of `API.md`. The short
version: six endpoints, `URLSession`, tokens in the Keychain, and new questions
arrive from the server so content never needs an App Store release.

## Cost

Static Web Apps Free tier, Functions on consumption, Cosmos serverless. For a
game played a few times a month this lands under $2/month, most of which is
Cosmos minimum charges.
