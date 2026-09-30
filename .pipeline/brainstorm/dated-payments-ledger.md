# Dated deposits and payments — visual exploration

Date: 2026-09-29. Status: option 1 approved, with larger date text. Mockup updated; production integration pending.

| # | Raw quote | Interpretation | Status |
|---|---|---|---|
| 1 | “where you can ... put the depot” | Extend the current optional deposit field in the invoice editor's Au besoin section. | confirmed |
| 2 | “add another line, like another depot” | Each deposit/payment gets a repeatable row; the add button follows the last row. | confirmed |
| 3 | “far right ... separated” | Preserve one enclosing input shape, with a divider before the date segment on the right. | confirmed |
| 4 | “chooser like this right in the actual text box” | Calendar button uses the existing app's inset highlight, rounded date popover, and green date segment. | confirmed |
| 5 | “receives ... balance ... prepaid” | Amount rows can represent deposits or other partial payments received, not only the first deposit. | confirmed |
| 6 | “put the number of prepaid ... add the date” | An amount and receipt date belong to each row. New rows begin empty; examples are prefilled. | preview assumption |
| 7 | “multiple other lines” | Add and remove payment rows; show the summed amount without changing the invoice's tax calculations. | confirmed |
| 8 | “three mockups ... interpret what I mean” | Deliver three interactive visual variants for comparison before changing production. | confirmed |
| 9 | “Each payment and its date, plus the total” | The final PDF lists each payment and its date, then their combined total and the remaining balance. | confirmed |
| 10 | “same concept of adding other rows” | Match the existing full-width Add a line button. Each new payment appears above it and pushes the button downward. | confirmed |
| 11 | “first one ... dates a little bit bigger ... final option” | Select Date lisible, increase its date text from 12px to 14px, and allow enough width for the calendar and label. | locked |

## Grounding

At the start of this exploration the app stored one string `deposit` and rendered one optional full-width amount field (`web/app.js`). Its total reduced the balance after tax. The approved app palette and date controls are in `web/style.css`. There is no design-map.json in this checkout. The N2/E2 compact footer decision remains intact.

## Three visual directions

1. **Date lisible:** amount plus a full readable date segment and calendar icon. Closest fit to the user's highlighted area; recommended for immediate clarity.
2. **Date compacte:** shorter numeric date segment. More room for the amount, with the same interaction.
3. **Calendrier discret:** small two-line “Reçu le” segment beside a calendar icon. Less width, but a smaller date label.

All three use a date picker, repeatable rows, matched remove buttons, a total of payments received, light/dark modes, and an illustrative PDF breakdown. Amounts/dates are fictional. Empty amount rows do not appear in the illustrative PDF. This page does not save business data or modify the installed app.

## Artifact

`mockups/dated-payments.html`. The user selected option 1 with larger date text. PDF presentation is confirmed: each payment and date, combined total, remaining balance. Integration is implemented for v0.1.11; existing single-deposit records migrate to undated rows. Delivery verification is tracked in `.pipeline/delivery/dated-payments/GATES.md`.
