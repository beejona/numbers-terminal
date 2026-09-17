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

## Running it locally

It's plain HTML, CSS and JavaScript with no build step and no dependencies. Open `index.html`, or
serve the folder with `python3 -m http.server`.
