# Compact number and language panels — idea ledger

Date: 2026-09-29. Active surface: the installed Windows app, editor footer and Save Draft header button. The user requested five compact looks for each of the two footer panels before selecting a new layout.

| # | User's words | Interpretation | Status |
| --- | --- | --- | --- |
| 0 | “everything is pretty good, except” | Keep the rest of the chosen app design. | confirmed |
| 1 | “these two UIs ... side by side ... also ... compact” | Preserve two columns, reduce both cards' default and expanded height. | confirmed |
| 2 | “proposed number ... when you click modify ... way too big” | Keep number editing inside the existing card with one short control row. | confirmed |
| 3 | “figure out a way ... translate to English smaller” | Keep translation and review available with a compact default control. | confirmed |
| 4 | “five different looks for each panel” | Present five distinct number-panel looks and five distinct language-panel looks for selection, not silently replace either live panel. | confirmed |
| 5 | “little icon ... draft gets saved automatically ... could be removed ... put right into ... Save Draft button” | Merge the save indicator into the existing Save Draft button; preserve the manual save action. | confirmed |
| 6 | “when you hover ... save automatically” | Explain automatic local saving in the button tooltip. | confirmed |
| 7 | “how do you know when a draft gets saved? ... what's the time?” | Show pending, saving, success and failure on the button; include last confirmed save time in the tooltip. | confirmed |
| 8 | “would the button just start ... rotating?” | Animate only a small status badge during an active save, keeping the main button still and clickable. | confirmed |
| 9 | “I'll choose” (implied by requesting proposals) | Wait for the chosen number and language looks before changing the production footer layout. | pending user choice |

## Grounding

`web/app.js` debounces ordinary edits for 500 ms, then awaits the Rust `save_draft` command. Some structural actions save immediately. The save status was a separate icon plus the manual Save Draft button. `web/style.css` has equal-width footer columns, but expanded invoice editing adds a form and confirmation below the existing card header; the language card stretches to match it.

## Options

The ten concrete visual proposals are in [compact-panels.html](../../mockups/compact-panels.html). Recommended pair: N1 (simple number line with inline edit) and E1 (one-row PDF language control). Both keep plain French labels and avoid hiding the action behind an icon.

## Open choice

User chooses N1–N5 and E1–E5. The current footer remains intact until that choice. The save status merge is independent of the choice and is implemented in the app source.
