# Business seat AI integration

- [x] G1: Provider support preserves existing document/AI validation.
  CHECK: scripts/check-rust.cmd
  EXPECT: test result: ok
  EVIDENCE: 20 Rust tests passed. Release compilation also succeeded after the runtime feature flags were tightened.
- [x] G2: Editor regressions and production web build pass.
  CHECK: npm run check
  EXPECT: passed
  EVIDENCE: 19 web checks passed; two isolated defect mutations were rejected by the focused settings checks.
- [x] G3: A packaged Windows executable includes the pinned official Codex runtime.
  CHECK: scripts/build-windows.cmd
  EXPECT: Finished
  EVIDENCE: Signed v0.1.12 installer built and installed locally. Installed product version is 0.1.12; installed executable matches the release binary except the documented three-byte NSIS bundle marker. Bundled Codex runtime hash matches the pinned hash.
- [ ] G4: Real Business token rewrite and translation succeed; invalid token is rejected.
  Manual: User enters a workspace-created Codex access token privately. Record successful real outputs and negative auth result without credential values. No inference success may be inferred from a saved token or catalogue.
- [x] G5a: Installed app settings display Business, OpenAI API and Z.ai with a protected credential field.
  EVIDENCE: Native installed window accessibility inspection confirmed all three providers; production settings check verifies type=password and no saved credential rendering.
- [ ] G5b: Privately entered Business token is saved and accepted by the provider.
  BLOCKER: User reports verification/login looping during token creation. No usable Business token or real Business request has been verified.

## Historical direction (superseded by subscription-only requirement)

Use a privately entered Z.ai API key to test current AI features. Resume Business authentication later. Z.ai live rewrite, translation, microphone capture and voice field extraction are pending credential entry and real tests. The connection test uses three synthetic requests; it does not test microphone capture itself. This local v0.1.12 build has not been published as Dad's update.

No blocked third-party OAuth grants, browser session credentials, private endpoints, or another application's auth identity are used. The official token route remains subject to workspace permissions and entitlements.

## Current direction: subscription usage only

v0.1.13 removes metered API adapters and fields. Personal ChatGPT OAuth and Business workspace token are the only supported selections. This replaces the old API-key instructions above. Z.ai and Claude subscriptions have no established authorized route for this invoice app, and are not represented as connected. See SUBSCRIPTION-GATES.md for current acceptance evidence. Business access token creation and real inference remain pending.
