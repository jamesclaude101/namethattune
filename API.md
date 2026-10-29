# API v1

Base URL: `https://namethattune.checkthislist.com/api/v1`

This is the whole game. The web client is one consumer; the iOS app will be
another. Nothing about the rules lives in the client.

**Conventions**

- JSON in, JSON out. No cookies, no sessions.
- Auth is the header `X-Game-Token: <token>`. **Not** `Authorization` — Azure
  Static Web Apps consumes that header in its own auth pipeline and never
  forwards it to a managed function, so a token sent that way arrives as
  nothing and every call 403s. The API still accepts
  `Authorization: Bearer <token>` as a fallback for hosting that passes it
  through. Two kinds of token:
  - **host token** — returned once when the room is created. Drives the game.
  - **player token** — returned once when a player joins. Submits answers.
- Errors are `{ "error": "human readable sentence" }` with a real status code.
- The server owns the clock. Never trust or send client timestamps.
- Correct answers are **not** in any response until the room reaches `reveal`.

**Room phases**

```
lobby ──start──> question ──┬─(all answered | clock expired | host advance)─> reveal
                            │                                                   │
                            └───────────────── next question <──────── advance ─┤
                                                                                │
                                                                      final <───┘
```

---

## `GET /health`

No auth. Useful as a smoke test after deploying.

```json
{
  "ok": true,
  "api": "v1",
  "bankVersion": 2,
  "questions": 77,
  "eras": ["80s", "90s", "00s", "10s", "20s"],
  "maxPlayers": 6,
  "persistence": "cosmos"
}
```

`"persistence": "memory"` means `COSMOS_CONNECTION_STRING` is not set and rooms
will vanish when the function app recycles. Fine locally, wrong in production.

---

## `POST /rooms`

No auth. Creates a room and returns the host's credentials.

Request (every field optional):

```json
{ "eras": ["90s", "00s"], "questionCount": 10, "clockSeconds": 20 }
```

`questionCount` must be 5, 10, 15 or 20. `clockSeconds` must be 15, 20 or 30.
Anything else falls back to the default rather than erroring.

Response `201`:

```json
{
  "code": "H7KQ",
  "hostToken": "…",
  "settings": { "eras": ["90s","00s"], "questionCount": 10, "clockSeconds": 20 },
  "poolSize": 34,
  "room": { "…": "public view" }
}
```

Store `hostToken`. It is shown once and cannot be recovered.

---

## `GET /rooms/{code}`

The poll endpoint. Returns the public view (below).

- With **no** token: spectator view.
- With a **player** token: adds `you`.
- With the **host** token: adds `you: null`, and *settles* the room — a question
  whose clock has expired or whose players have all answered flips to `reveal`.

That last point matters: **the game only advances while the host is polling.**
There is no timer service. Poll at ~600ms as host, ~900ms as a player.

### Public view

```json
{
  "code": "H7KQ",
  "phase": "question",
  "index": 3,
  "total": 10,
  "clockSeconds": 20,
  "eras": ["90s","00s"],
  "serverNow": "2026-10-29T18:04:11.212Z",
  "questionStartedAt": "2026-10-29T18:04:05.004Z",
  "msRemaining": 13800,
  "answeredCount": 2,
  "players": [
    { "id": "a1b2c3d4e5f6", "name": "Jimmy", "score": 2480, "streak": 2,
      "answered": true, "lastCorrect": null, "lastPoints": null }
  ],
  "question": {
    "index": 3,
    "prompt": "In “Zombie,” which year does Dolores O’Riordan name?",
    "choices": ["1949", "1916", "1969", "1922"],
    "era": "90s",
    "difficulty": "hard"
  },
  "reveal": null,
  "you": null
}
```

- `msRemaining` is authoritative at the moment of the response. Anchor it to
  your own monotonic clock and tick locally between polls; do not re-derive it
  from `questionStartedAt` and the device clock, which may be skewed.
- `lastCorrect` / `lastPoints` stay `null` until `phase === "reveal"`. This is
  deliberate — it stops a client from showing a verdict early.
- During `reveal`, `reveal` is populated:

```json
"reveal": {
  "correctIndex": 1,
  "correctText": "1916",
  "song": "Zombie",
  "artist": "The Cranberries",
  "year": 1994
}
```

- During `final`, a `leaderboard` array is added:

```json
"leaderboard": [
  { "rank": 1, "id": "a1b2…", "name": "Jimmy", "score": 8740, "right": 8, "best": 5 }
]
```

---

## `POST /rooms/{code}/players`

No auth — this *is* the join. Only works while `phase === "lobby"`.

```json
{ "name": "Jimmy" }
```

Response `201`:

```json
{ "playerId": "a1b2c3d4e5f6", "playerToken": "…", "name": "Jimmy", "room": { } }
```

Errors: `409` room full (6), name taken, or game already started. `400` no name.

---

## `POST /rooms/{code}/start`

Host token. Deals the round and moves to `question`.

Optionally overrides the settings one last time, same shape as `POST /rooms`.
Returns the public view. Errors `409` if already started or nobody joined.

---

## `POST /rooms/{code}/answers`

Player token.

```json
{ "questionIndex": 3, "choiceIndex": 1 }
```

`questionIndex` is optional but **send it** — it is how a phone that was asleep
gets a clean `409` instead of answering the wrong question.

Response `202`:

```json
{ "locked": true, "questionIndex": 3, "answeredCount": 3, "totalPlayers": 4 }
```

Note what is *not* there: whether you were right. Poll for the reveal.

Errors: `409` already answered, question closed, or not taking answers.
`400` `choiceIndex` outside 0–3.

### Scoring (server-side, for reference)

```
correct  = choiceIndex === correctIndex  AND  elapsed <= clock + 1.2s grace
base     = round((500 + 500 * (1 - elapsed/clock)) / 10) * 10     // 500–1000
streak   = min(250, 50 * (consecutiveCorrect - 1))
points   = correct ? base + streak : 0
```

A wrong answer or a timeout resets the streak to zero.

---

## `POST /rooms/{code}/advance`

Host token. Moves `question → reveal`, or `reveal → next question | final`.
Players who never answered are given a zero and lose their streak at the
`question → reveal` transition.

Returns the public view. `409` if there is nothing to advance.

---

## Notes for the iOS client

- Everything above is plain HTTPS + JSON; `URLSession` is enough, no SDK.
- Keep `hostToken` / `playerToken` in the Keychain, not `UserDefaults`.
- Poll with a timer; back off to ~2s when the app is in the background and
  refresh immediately on `willEnterForeground` (the web client does the same
  thing on `visibilitychange`).
- New questions ship by editing `api/shared/bank.json` and pushing. The app
  never needs an App Store update to get new content, because questions only
  ever arrive from the API.
- Do **not** ship this as a WKWebView wrapper. App Review rejects thin web
  wrappers under guideline 4.2. Build a real SwiftUI client against this API —
  there are only six endpoints.
