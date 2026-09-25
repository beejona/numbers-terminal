# Numbers Terminal Simulator

Practice the floor 7 "Click in order!" terminal in the browser, with the look and the settings of
Odin's terminal solver.

**Play it: https://beejona.github.io/numbers-terminal/**

## How it works

The real terminal is a four row chest whose fourteen numbered panes sit in a 2x7 block. Click them
in order, 1 to 14. The solver highlights the next three panes in the three "Order" colours, so with
**Show Numbers** off you just click the brightest one each time.

- **R** - new terminal
- **S** - settings, **Esc** closes them

Your best time is kept in the browser, on your machine only.

## Settings

Appearance: Render type (Odin / Normal / Custom GUI), Term Size, Normal Term Size, Roundness,
Slot gap, Show Numbers.

Functionality: Numbers (14 or 10), Block Incorrect Clicks, Client Prediction, Hover mode, Drop key
(and the key it's bound to), Resolve timeout, First Click Prot, Ping, Auto restart.

Colors: Background, Order 1, Order 2, Order 3.

**Numbers** shortens the run to ten clicks, drawn as a 2x5 grid instead of the full 2x7. Each
count keeps its own best time.

**Drop key** is the in-game trick: hold the key (Q by default, rebindable) and sweep the cursor
over the panes to click them. **Hover mode** is the same thing without holding anything. Sweeping
over the wrong panes never counts as a misclick.

**Ping** delays every click the way the server does, and **Client Prediction** clears the pane
straight away instead of waiting for it - so with a high ping and prediction off, the terminal
feels exactly as sluggish as it does in game. If ping is longer than the resolve timeout, the pane
comes back until the click is confirmed, which is what the mod's reload does.

Settings persist in the browser, and **Reset to Odin defaults** puts them all back.

## Leaderboard

Press **L** (or the Leaderboard button) and pick a name. From then on your terminals are
**ranked**: they're played through the leaderboard server the way SkyBlock's terminals are played
through Hypixel's.

- The server deals the terminal. Every click goes to it with the menu's current window id; it
  clears the pane on its next tick (20 a second, at most one pane a tick) and only then sends back
  a new window id, which can't be guessed, so there's no clicking ahead ("zero ping"). A click
  with an old id is thrown away, and flooding the server gets you kicked.
- The server times the run with its own clock. So your real ping counts, as in game, and the
  Ping setting only applies to practice. The fastest anything can clear a terminal is one pane a
  tick: 0.7 s for 14, 0.5 s for 10, plus ping.
- The page also sends a record of each run (when and where each pane was cleared, and the
  pointer's path), which has to look like a person played it (`worker/src/checkrun.js`); a Click
  run has to be all real clicks.
- Without a name, or with **Ranked runs** switched off, terminals are practice and aren't saved.
- Your best for each terminal size (14 or 10) and play mode (Click, Drop key or Hover) is kept.
  **Old times** shows the times from before terminals ran on the server.
- Names are Minecraft-style (3 to 16 letters, numbers, underscores), and slurs are refused, also
  when spelled with numbers, underscores or repeated letters (`namefilter.js`). A name belongs to
  the browser that first used it.

The server is a Cloudflare Worker with a D1 database and a Durable Object per ranked terminal, in
`worker/`. `node worker/test/run.mjs` tests it, and `node worker/test/serve.mjs` runs it locally on
port 8787 (open the page with `?api=http://127.0.0.1:8787`).

## Running it locally

It's plain HTML, CSS and JavaScript with no build step and no dependencies. Serve the folder with
`python3 -m http.server` (the leaderboard is a JavaScript module, which browsers won't load from a
plain `index.html` file).
