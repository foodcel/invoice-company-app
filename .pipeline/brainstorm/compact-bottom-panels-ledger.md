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
| 9 | “I like N2 ... I like E2” | Use N2 and E2 as the selected directions for a focused mockup; wait for explicit confirmation before implementing them in the app. | corrected |
| 10 | “N ... on the left, just like ... click modify” | Put N° to the left of 2061 in both N2's normal and edit states. | confirmed |
| 11 | “options are just French, English ... no other buttons” | Make E2 a full-card, equal-width Français / English switch with no title or secondary button inside the panel. | confirmed |
| 12 | “default's gonna be French ... click English ... look at it ... save it” | French is selected initially; selecting English changes the document preview, which Dad can inspect before using the existing PDF action. | confirmed |
| 13 | “generate both mockups ... then I'll confirm ... implemented directly in the app” | Deliver mockups now; production implementation waits for the user's review. | confirmed |

## Grounding

`web/app.js` debounces ordinary edits for 500 ms, then awaits the Rust `save_draft` command. Some structural actions save immediately. The save status was a separate icon plus the manual Save Draft button. `web/style.css` has equal-width footer columns, but expanded invoice editing adds a form and confirmation below the existing card header; the language card stretches to match it.

## Options

The original ten options remain in [compact-panels.html](../../mockups/compact-panels.html). The user selected N2 and E2 with the refinements above. The focused, interactive [N2 + E2 mockup](../../mockups/compact-panels-n2-e2.html) shows both cards together, number editing and language switching.

## Open choice

The user reviews the N2 + E2 mockup and confirms or corrects it. The production footer remains intact until that confirmation. The save status merge is independent and already present in v0.1.9.
