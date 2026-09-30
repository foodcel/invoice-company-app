# Dated payment event routing

## Assessment

Severity: P1, form typing throws before updating state. Complexity: low, two branches belong in the existing click listener. Confidence: HIGH, source scope and reviewer reproduction agree.

Expected: clicking payment Add/Remove changes rows; typing updates its target field and autosaves.
Actual: Add/Remove did nothing; ordinary input referenced an undefined `b`.
Introduced: this uncommitted dated-payment integration, before release.

## Evidence chain

1. Typing reaches `web/app.js:1266` and throws at `b.hasAttribute(...)` (independent reviewer reproduced ReferenceError).
2. The input listener at `web/app.js:1252` defines `el`, not `b`.
3. Payment Add/Remove branches were inserted in that listener at lines 1266–1282.
4. The click listener ending at line 1251 owns `b` and existing Add/Remove work-item handlers at lines 1223–1239.
5. Root cause: payment click handlers were placed inside the input listener; existing PDF/unit checks exercised data/rendering but did not invoke UI event listeners.

## Fix and verification

Re-read these anchors before editing. Move payment button branches to the click listener and exercise client/item/payment input plus Add/Remove via isolated event-handler execution. Confirm the previously broken source fails the same check. Retain the independent PDF, migration and package checks. No additional data-schema change is needed.

Native app click-through remains unverified; a handler test must not be reported as a native-device test.

## Validation highlight

HIGH confidence: the new `.payment-amount input` rule (`web/style.css:174`) resets its box shadow after the global invalid-input rule (line 112); the date button is also outside that input rule. `paintValidation` marks the correct elements, but the integrated shell needs its own invalid styling. Add a red inset highlight to `.payment-shell:has([aria-invalid="true"])` so either invalid amount or date marks the whole control.
