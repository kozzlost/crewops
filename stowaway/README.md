# Stowaway

A no-login party game for 3 to 8 people waiting for a train. Every passenger's ticket shows the same secret
destination. One player, the stowaway, has no ticket and only knows the category. Players give one-word clues,
then vote out the stowaway.

- **Car A, everyone on their own phone:** one person starts a room and shares the link (or the 4-letter code).
  No accounts, no app install.
- **Car B, pass one phone around:** works offline on a single phone.

This folder is self-contained and separate from the CrewOps app. Vercel only builds the repo's root
`index.html`, so nothing here affects the CrewOps deploy.

## How it works

| Piece | What it does |
|---|---|
| `server.js` | A Node server: serves the page and syncs each room over a WebSocket at `/ws`. It holds the real game state and sends each phone only what that player may see. Passengers never receive who the stowaway is, and the stowaway never receives the word, until the votes are in. |
| `public/engine.js` | The game rules (dealing, turn order, voting, scoring). The same file runs on the server and in the browser. |
| `public/index.html` | The whole front end, with no build step. |
| `test/play-round.test.js` | Five simulated phones play two full rounds against the real server. |

Rooms live in memory. They're forgotten 6 hours after everyone leaves, or whenever the server restarts.

## Run it locally

```bash
cd stowaway
npm install
npm start          # http://localhost:3000
npm test           # end-to-end check with 5 simulated phones
```

To try it with phones on the same Wi-Fi, open `http://<your-computer's-IP>:3000`.

## Deploy free on Render (about 10 minutes)

1. Sign up at **render.com** with your GitHub account. The free tier doesn't need a credit card.
2. Choose **New → Web Service**, then connect the `kozzlost/crewops` repository.
3. Fill in:
   - **Branch:** the branch that has this folder (`main` once it's merged)
   - **Root Directory:** `stowaway`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
   - Optional, under Advanced: **Health Check Path** `/healthz`
4. Click **Create Web Service**. After the first build (2–3 minutes), Render gives you a URL like
   `https://stowaway-xxxx.onrender.com`. That's the link to share.

Render sets `PORT` itself, and the server reads it. You don't need any environment variables.

### The free-tier nap

Render's free tier puts the server to sleep after about 15 minutes with no visitors. The next visit wakes it,
which can take up to a minute. The page shows a "Waking up the game server" message while that happens.
**Open the link a minute before you want to play.** A sleeping server has no rooms, so start a new room after it
wakes. Render's paid Starter tier (about $7/month) never sleeps, if that ever becomes annoying.

## Limits built in

12 players per room, 500 rooms per server, 16 KB per message, 40 messages per 5 seconds per phone,
and all text inputs are length-capped.
