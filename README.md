# Pluto TV – Stop Autoplay

A userscript that stops the Pluto TV web player from playing the next episode on its own.

## How it works

About 29 seconds before an episode's reported end, Pluto shows an end card
(`<endcard-web-component>`) reading "Starts in N SECONDS", with an X button.
About 5 seconds later it switches to the next episode and skips the rest of the credits.

The script has two layers:

1. **Dismiss the end card.** When the card appears, the script clicks its X. The card
   uses a closed shadow root, so the script runs as a content script
   (`@inject-into content`) and uses Firefox's `openOrClosedShadowRoot` to reach the button.
2. **Safety net.** If the page switches to another episode within 15 seconds of the end card
   or the end of the video, and you didn't click or press a key, the script pauses the
   new episode and shows a notice. Your next click or keypress lifts the block.

## Install (Firefox + Violentmonkey)

1. Install [Violentmonkey](https://addons.mozilla.org/firefox/addon/violentmonkey/).
2. Open the [raw script](https://raw.githubusercontent.com/ccosby/pluto-stop-autoplay/main/pluto-stop-autoplay.user.js).
   Violentmonkey shows its install page. Click **Install**.
3. Reload any open pluto.tv tabs.

Violentmonkey checks that URL for updates, so new versions pushed to `main`
(with a higher `@version`) install automatically.

Layer 1 relies on Firefox's `openOrClosedShadowRoot`. In other browsers or userscript
managers, only the layer 2 safety net may work.

## Menu (Violentmonkey toolbar icon)

- **Autoplay blocking: ON/OFF**: turns blocking on or off.
- **📋 Copy diagnostics**: copies the record of recent end cards and blocks.
  Useful if Pluto changes something and the script stops working.
- **🗑 Clear diagnostics**

## Troubleshooting

Paste the diagnostics into a file such as `captures/report.json` (gitignored). Each `endcard` record
includes the card's shadow DOM, the button the script clicked, and whether the card
went away afterwards.
