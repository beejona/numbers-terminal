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

Press **L** (or the Leaderboard button) and pick a name. From then on, every run that beats your
best for its terminal size (14 or 10) and play mode (Click, Drop key or Hover) goes up on the
board by itself, and runs you did before picking a name go up when you save it. The board
refreshes while it's open; **All** shows everyone's single best, with the mode it was played in and
its ping.

- Names are Minecraft-style (3 to 16 letters, numbers, underscores), and slurs are refused, also
  when spelled with numbers, underscores or repeated letters (`namefilter.js`).
- A name belongs to the browser that first used it, so nobody else can post under it.
- Times come from the browser, so they can't be proven. Each run is posted with a record of it -
  the layout, when and where each pane was cleared, and the pointer's path - which the server checks
  against the time (`worker/src/checkrun.js`): the clicks have to be in order and on their panes,
  the time has to match them, a Click run has to be all real clicks with the pointer moved onto
  each pane before it's pressed (not in the same instant, most of the time), no pointer in two places
  at once, no closer together than a hand can click, not machine-evenly spaced and not all dead
  centre. Click runs under half a second, and Drop key or Hover runs under 25 ms a pane, are turned
  down outright. Clicks made up by a script don't play the terminal at all. Names and times can be taken off by hand (see `worker/`).

The server is a Cloudflare Worker with a D1 database, in `worker/`. `node worker/test/run.mjs`
tests it, and `node worker/test/serve.mjs` runs it locally on port 8787 (open the page with
`?api=http://127.0.0.1:8787`).

## Running it locally

It's plain HTML, CSS and JavaScript with no build step and no dependencies. Serve the folder with
`python3 -m http.server` (the leaderboard is a JavaScript module, which browsers won't load from a
plain `index.html` file).
