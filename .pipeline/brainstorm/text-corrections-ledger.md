# Text correction suggestions

Grounding: project/client/address/shipping/contact/email/notes render through `web/app.js`; work descriptions already have real subscription rewrite proposals and undo. Current form does not perform grammatical correction on blur. Phone spacing is separately implemented locally in v0.1.18.

| # | Raw quote | Interpretation | Status |
|---|---|---|---|
| 0 | "looks a little bit cleaner ... final product" | Improve customer-facing wording without changing supplied facts | Confirmed |
| 1 | "project name ... missing an E ... accent" | Suggest French spelling and accent corrections, e.g. chene → chêne | Confirmed |
| 2 | "actual address ... punctuation errors" | Suggest capitalization/formatting, preserve street identity and house/postal numbers | Confirmed |
| 3 | "correct ... punctuation ... capital somewhere" | Include capitalization and punctuation; never add work details | Confirmed |
| 4 | "as my dad's entering information" | Trigger after a completed edit instead of requiring the existing rewrite button | Corrected by response: after leaving field preferred |
| 5 | "doesn't even have to be the AI" | Local deterministic formatting where reliable; subscription AI for language suggestions | Proposed |
| 6 | "Suggest corrections for all fields" | Suggestions rather than silently replacing entered text; factual/numeric fields are validated, never invented | Confirmed |
| 7 | "maybe when he actually leaves the field" | On blur, check only changed nonempty text and present one compact suggestion | Confirmed |
| 8 | "brainstorm ... give me ideas" | Proposal only until user approves implementation | Confirmed |

Proposed best path: original field remains editable; one small suggested correction directly underneath, accept checkmark and dismiss X. Accept exposes Undo. No grammar service request while typing. A request result applies only to the same document, field, and revision it inspected. Names/addresses are never translated or factually completed; email addresses and financial values are preserved.

Other roads considered: browser spellcheck underline (local, but weak on capitalization/context); correction button per field (explicit but more clutter); full document review before PDF (good final safety pass but interrupts finishing); automatic replace-on-blur (fast, rejected by user's suggestions-only answer); correction sidebar (more room but too much UI).

No implementation in this update: final presentation and scope need user review. No external correction requests made in brainstorming.
