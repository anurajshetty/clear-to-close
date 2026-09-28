#!/usr/bin/env python3
"""topcard_redesign — structural guard for the client top-card redesign
(Anuraj's final call, Sept 2026).

RN components are not importable in the node suite, so this source-level
check pins the composition contract:

  1. The GUIDED BY strip is gone from the top card (no guided-by markup,
     styles, or Call/Text buttons remain in ClientTopCard.tsx).
  2. The escrow status tag ("In progress" / "Completed") renders next to
     the "YOUR TRANSACTION" kicker, driven by escrowStatusLabel.
  3. At 100% the top card stays the same card: the unified ConfettiBurst
     pops up from below the top card (no ConfettiLayer-as-top-card swap).
  4. The "Just closed!" triumph card is REMOVED (Anuraj, Sept 2026): the
     completed state is just the top card (status tag "Completed") with
     the burst — no TriumphCard export, no triumph render on the
     buyer/seller/TC screens. The review/share section is preserved.
  5. Approved client-home-card sample (Anuraj, Sept 2026): the banner
     header strip is BACK on top of the client top card (the realtor's
     synced banner, cover-cropped; brand-teal gradient fallback), with the
     realtor photo ON the banner's right side, tappable to the in-app
     realtor profile; the old top-right photo position is gone. The card is
     responsive (390pt/320pt size classes from the sample's exact tokens).
     The ahead-of-pace pill, the completion pill, and their logic are all
     gone (Anuraj, Sept 2026).

Usage: python3 tests/topcard_redesign.py   (also wired into tests/run.sh)
Exit 1 with the offending locations on failure.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

failures = []


def check(cond, label):
    print(("PASS" if cond else "FAIL") + ": " + label)
    if not cond:
        failures.append(label)


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


card = read("src/components/ClientTopCard.tsx")
triumph = read("src/components/ClientTriumph.tsx")
buyer = read("app/client/buyer/[id].tsx")
seller = read("app/client/seller/[id].tsx")
tc = read("app/client/tc/[id].tsx")
topcard_lib = read("src/lib/topCard.ts")
banner = read("src/components/BannerStrip.tsx")
pace_lib = read("src/lib/pace.ts")

# 1. GUIDED BY strip is gone from the top card.
check('testID="guided-by"' not in card, "guided-by strip markup removed from ClientTopCard")
check("GUIDED_BY_STRIP" not in card, "GUIDED_BY_STRIP no longer used by ClientTopCard")
check('testID="guided-call"' not in card, "guided Call button removed")
check('testID="guided-text"' not in card, "guided Text button removed")
check("guidedAvatar" not in card, "guided avatar styles removed")
check("guidedScrim" not in card, "guided scrim styles removed")

# 2. Status tag next to the kicker.
check('testID="escrow-status"' in card, "escrow status tag rendered next to the kicker")
check("escrowStatusLabel" in card, "status tag driven by escrowStatusLabel")
check("IN PROGRESS" not in card.replace("In progress", ""),
      "no hardcoded uppercase status copy (label helper owns the copy)")

# 3. 100%: same card + unified burst, no top-card swap, no triumph card.
check("ConfettiBurst" in card, "top card uses the shared ConfettiBurst")
check('testID="topcard-confetti-burst"' in card, "burst testID present on the top card")
check("isComplete ? (" in card and "topcard-confetti-burst" in card,
      "burst only renders at 100%")
check("if (isComplete)" not in card, "top card no longer swaps itself out at 100%")
check("TriumphCard" not in card, "TriumphCard removed from ClientTopCard")

# 4. "Just closed!" triumph card REMOVED (Anuraj, Sept 2026); review/share
#    section preserved.
for name, src in (("buyer", buyer), ("seller", seller), ("tc", tc)):
    check("<TriumphCard" not in src, name + " screen no longer renders the triumph card")
    check("TriumphCard" not in src, name + " screen no longer imports TriumphCard")
    check("Just closed!" not in src, name + ' screen has no "Just closed!" copy')
check("Just closed!" not in card, "'Just closed!' headline removed")
check("triumphHeadline" not in card, "triumph headline styles removed")
check("triumph-confetti" not in card, "triumph confetti layer removed")
check('testID="triumph-review"' in triumph, "review button preserved")
check('testID="triumph-share"' in triumph, "share button preserved")
check("<ClientTriumphSection" in buyer, "buyer review/share section preserved")
check("<ClientTriumphSection" in seller, "seller review/share section preserved")
check("onLeaveReviewPress" in buyer, "buyer review sheet wiring preserved")

# 5. Approved client-home-card sample (Anuraj, Sept 2026): the banner
#    header strip is BACK on the top card with the realtor photo on its
#    right side (tappable to the in-app profile); the old top-right photo
#    is gone; the card is responsive via the sample's size-class tokens;
#    the pace/completion pills and their logic are gone; the light theme
#    stays. The strip is the shared BannerStrip (Sept 2026 refactor, also
#    used by the realtor home screen), so the banner testIDs ride in as
#    prop values on the BannerStrip element.
check('<BannerStrip' in card, "banner strip is the shared BannerStrip component")
check('"topcard-banner-header"' in card, "banner header strip testID wired to BannerStrip")
check('"topcard-banner"' in card, "synced banner image testID wired to BannerStrip")
check('"topcard-gradient"' in card, "teal gradient fallback testID wired to BannerStrip")
check('"topcard-banner-photo"' in card, "realtor photo testID wired to BannerStrip")
check('resizeMode="cover"' in banner, "shared BannerStrip: banner is cover-cropped")
check("TealGradientFallback" in banner, "shared BannerStrip: teal gradient fallback when no banner is set")
check("onProfilePress" in card, "banner photo opens the realtor profile in-app")
check('testID="greeting-avatar"' not in card, "old top-right photo position removed")
check("avatarCircle" not in card, "old avatar styles removed")
check("topCardTokens(screenW, screenH)" in card, "card reads the viewport-fit tokens (width + height)")
check("useWindowDimensions" in card, "card sizes come from the screen dimensions")
check("011E1D" not in card, "no dark teal in the top card")
check("CLIENT_TOPCARD_BG" in card, "card background uses the CLIENT_TOPCARD_BG token")
check("backgroundColor: CLIENT_TOPCARD_BG" in card, "white light theme set as the hero background")
check("daysLeftTone" in card, "days-line number colored by daysLeftTone")
check("DAYS_LEFT_COLORS" in card, "days-left palette imported for the number colors")
check("topCardPill" not in card, "topCardPill removed from the top card")
check("completionPill" not in topcard_lib, "completionPill removed from topCard.ts")
check('testID="pace-pill"' not in card, "ahead-of-pace pill markup removed")
check("pacePill" not in card, "pace pill styles removed")
check('testID="completion-banner"' not in card, "completion pill markup removed")
check("aheadOfPace" not in pace_lib, "aheadOfPace helper removed from pace.ts")
check("PACE_GAP_POINTS" not in pace_lib, "pace threshold constant removed")
check("completionPill" not in pace_lib, "completionPill helper removed from pace.ts")
check("aheadOfPace" not in topcard_lib, "no pace logic in topCard.ts")

if failures:
    print("\n%d FAILURE(S)" % len(failures))
    sys.exit(1)
print("\nAll top-card redesign checks passed.")
