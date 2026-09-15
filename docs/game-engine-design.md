# Game engine design

Design for the pure game engine of 56 and 28. It builds on [rules.md](../rules.md) (the
game rules) and [design.md](../design.md) (app decisions). Section references like
"rules §4" and "design §10" point to those files.

This spec is **independent of the tech stack**. Names like `decide` and `playCard` describe
concepts, not a specific language's types. Choosing the stack comes after this spec.

## 1. Goals and boundaries

- The engine owns **everything in rules.md** for a whole **session**: dealing, auctions, the 28
  face-down card, play, redeals, scoring, token balances, dealer rotation, and the session
  ending when a team reaches 0 tokens.
- It also owns the app rules that change game flow: illegal-play modes (design §4), the
  surrender vote (design §5) and the host's End match (design §10).
- It is **pure**: no I/O, database, network, timers, logging, randomness or current time. The same
  state and action always give the same result.
- It **does not** know about players, names, PINs, connections, the host role, stalls, the Ready
  gate, room codes or timers. Those belong to the service, which tells the engine what to do
  through actions.
- Randomness enters only through the **shuffled deck** in the `deal` action and the
  **first dealer** chosen by the service.

## 2. Seats, teams and sources of actions

- Seats are numbered `0 … N−1` **counter-clockwise**. The next seat is `(i + 1) mod N`.
  The dealer's right is `dealer + 1`.
- **Team A** holds the even seats and **Team B** the odd seats. Team size is `N / 2`.
- The engine knows **seats only**. A replaced player (design §10) changes nothing inside the
  engine.
- Every action has a **source**:
  - **seat**: auction calls, placing the face-down card, playing, asking for the reveal,
    surrender proposal and votes
  - **host**: End match. The service checks that the sender holds the host role or is an
    unlocked Table view.
  - **system**: deal, start next match, restart session. The service sends these.

## 3. Public interface

| Function | Returns |
|---|---|
| `newSession(config, firstDealer)` | The starting state (phase `awaitingDeal`) and `sessionStarted`, or a rejection if the config is invalid |
| `decide(state, action)` | A list of events, or a rejection `{code, details}`. Never changes state. |
| `evolve(state, event)` | The new state. Does no checking. |
| `act(state, action)` | `decide`, then `evolve` for each event. Returns `{state, events}` or the rejection. |
| `allowedActions(state, seat)` | What that seat can do right now (§12) |
| `allowedHostActions(state)` | Whether End match with `restart` and with `award` is available |
| `view(state, viewer, viewSettings)` | What a seat or the Table view may see (§11) |
| `redactEvent(event, viewer, viewSettings)` | The event as that viewer may see it, or nothing (§11) |

- `viewer` is a seat number or `table`.
- `viewSettings` holds the room's **round history** (none / last / full) and **live points**
  (on / off) settings. They only affect what is shown, not game logic.

## 4. Modules

| Module | Handles |
|---|---|
| `cards` | Card identity, points, rank order, building the deck for a config |
| `config` | Engine config and checking it's valid |
| `seats` | Teams, next seat, partners |
| `stakes` | Tier lookup, multiplier, whether a team can afford a call, moving tokens |
| `auction` | Shared auction rules, set up for 56, 28 first auction and 28 second auction |
| `hiddenTrump` | 28 face-down card, asking for the reveal, forced plays |
| `play` | Following suit, the trump-lead rule, legal cards, round winner, disqualifying plays |
| `redeal` | Redeal checks |
| `scoring` | Match result and token transfers |
| `surrender` | Result certainty and the vote |
| `hostActions` | End match (restart or award) |
| `session` | Phase changes, dealer rotation, session end, restart |
| `views` | Views, allowed actions for display, event redaction |
| `engine` | Routes actions to modules; the public interface |

56 and 28 share one core (cards, following suit, round winner, scoring, tokens). 28's two
auctions and hidden trump live in their own modules.

## 5. Cards and config

### 5.1 Cards
- A card is **suit** (spades, hearts, diamonds, clubs), **rank** (J 9 A 10 K Q 8 7) and
  **copy** (1 or 2). 56 uses two copies of each card. 28 uses one.
- The copy only makes identical cards distinguishable. It never affects rank. Between identical
  cards, the one **played first** ranks higher (rules §6.2).
- Points and rank order are as in rules §1.

### 5.2 Config
| Field | Values |
|---|---|
| `gameType` | `56` or `28` |
| `playerCount` | 56: 4, 6, 8. 28: 4. |
| `includeEightsAndSevens` | 56 only |
| `illegalPlayMode` | `block` or `autoStop` |
| `startingTokens` | Whole number from 1 through 999 |
| `stakeTiers` | List of `{fromBid, toBid, winStake, lossStake}` |
| `redealThreshold` | Points at or below which a hand forces a redeal |
| `surrenderOption` | `off` or `on` |

`newSession` rejects a config that is invalid, for example:
- a player count not allowed for the game type
- 8s and 7s with a player count they don't divide evenly into (rules §3)
- stake tiers with gaps, overlaps, or not covering the whole bid range (56: 28–56, 28: 14–28)
- stake tiers whose win or loss stake decreases as the bid rises
- a starting token count or stake value that isn't a whole number from 1 through 999
- a redeal threshold that isn't a whole number from zero through the cap for that game/player
  count (56: 13/8/6 for 4/6/8 players; 28: 6)

## 6. State

The state is the full truth, including all hands. It **never leaves the server**. It is plain
data that can be saved as JSON.

### 6.1 Session fields
- `config`
- `tokens`: balance for Team A and Team B
- `dealer`: the current dealer's seat
- `matchLog`: one summary per persistently logged result in this session (§10.3)
- `pastSessions`: the winner and final tokens of each earlier session in the room
- `phase`: one of the phases in §6.2

### 6.2 Phases
| Phase | Meaning | Leaves through |
|---|---|---|
| `awaitingDeal(reason)` | Waiting for a deck. Reason: `firstDeal`, `nextMatch`, `redeal` or `restart`. | `deal` |
| `auction` | An auction is running | Auction end |
| `placingCard` | 28: the auction winner must place the face-down card | `placeCard` |
| `play` | Rounds are being played (including while a surrender vote pauses play) | Last round, disqualification, surrender, End match |
| `matchOver(summary)` | Match scored; waiting for everyone to be Ready | `startNextMatch` |
| `sessionOver(winner, summary)` | A team reached 0 tokens | `restartSession` |

### 6.3 Match fields (while a match is in progress)
- `hands`: cards held by each seat
- `undealt`: 28's second four cards per seat, until the second deal
- `auction`:
  - `stage`: `56`, `28-first` or `28-second`
  - `calls`: every call so far, in order, with its seat
  - `turn`
  - `highBid`: seat, amount, suit or no trump (56), bid style (56 suit bids)
  - `doubledBy`: the doubler's seat, if a double is active
  - `redoubled`
  - `consecutivePasses`
  - `carriedBid`: 28 second auction only; the first-auction bid with its double status
- `contract`, set when an auction ends. In 28 it is set when the first auction ends (after the
  face-down card is placed, or at the forced bid) and stands as the first-auction contract
  through the second auction and any placement after it; a double or redouble made in the second
  auction is recorded in the auction state only. It is replaced when the second auction ends
  (`auctionEnded`, after a new winner places) before play.
  - `bidder` seat and team
  - `amount`
  - `trump`: a suit, `noTrump`, or `hidden(suit)`
  - `multiplier`: 1, 2 or 4
  - `forced`
- `faceDown` (28): `{owner, card}`, and `revealedInRound` (round number, or none)
- `rounds`: finished rounds, each with leader, plays in order, winner and points
- `currentRound`:
  - `leader`, `plays` in order, `turn`, `leadSuit`
  - `revealedThisRound`
  - `revealAskedBy`: the seat that asked for the reveal on its current turn, if any
- `trumpPlayed`: whether a card that **counted as trump** was played in an earlier round
- `points`: points per team from finished rounds
- `surrender`:
  - `decided`: the losing team, once the result is certain
  - `vote`: `{proposer, yes, no}` while a vote runs
  - `lastFailedRound`: the round number of the last failed vote

## 7. Dealing

- **Action** `deal(deck)`, from the system, only in `awaitingDeal`.
- The deck must contain **exactly** the cards this config uses, or it's rejected with
  `invalidDeck`.
- Cards are dealt **one at a time counter-clockwise starting at the dealer's right**: card `k`
  goes to seat `(dealer + 1 + k) mod N`.
- **56**: every card is dealt, then the redeal check runs (§7.1). If no redeal, the auction
  starts.
- **28**: the first `4 × N` cards are dealt and the first auction starts. The rest go to
  `undealt`. The second deal uses the same order.

### 7.1 Redeal check (rules §9)
- A redeal happens if **one team holds no Jack**, or **any complete holding is worth the
  `redealThreshold` or less**. In 28, the complete holding includes the face-down card as part
  of its owner's eight cards for both checks even though it isn't in that player's hand.
- **56**: checked after the deal. **28**: checked after the second deal (all 8 cards).
- On a redeal: events `redealt(reason)` and `matchEnded` with outcome `redealt`. All bids, both
  auctions and the face-down card are cancelled. The phase becomes `awaitingDeal(redeal)` with
  the **same dealer**. No tokens move.
- Reason is `teamWithoutJack(team)` or `lowHand(seat, points)`.

## 8. Auction

### 8.1 Turn order
- Each auction starts at the **dealer's right** and the turn moves to the next seat after each
  call.
- **Redouble** is the only call made out of turn.

### 8.2 Calls
All calls are rejected with a reason code if their conditions fail (for example `notYourTurn`,
`invalidBid`, `bidTooLow`, `bidOutOfRange`, `cannotAfford`, `doubleNotAllowed`, `noDoubleActive`).

- **`bid`**, on the seat's turn:
  - **Amount** strictly higher than the current highest bid, and in range:
    - 56: 28–56
    - 28 first auction: 14–28
    - 28 second auction: 21–28 and at least `carriedBid + 1`
  - **56** bids carry a suit or no trump, and suit bids carry a **bid style**
    (`numberFirst` or `suitFirst`). **28** bids are numbers only.
  - **Malformed bids** (missing suit, an invalid suit string, missing style on a suit bid, an
    invalid style string, or a style given on a no-trump bid) are rejected with `invalidBid`
    and a `reason` detail naming the problem (`missingSuit`, `invalidSuit`, `missingStyle`,
    `invalidStyle`, or `unexpectedStyle`). A **28** bid that carries a `suit` field (including
    `suit: null`) is rejected with `invalidBid` and reason `unexpectedSuit`; a 28 bid carrying a
    `style` field is rejected with `unexpectedStyle`. The client never offers or sends a suit
    for a 28 bid, and the protocol schema must reject one, so this rejection is only a
    server-side guard. `bidOutOfRange`/`bidTooLow` are only for the amount.
  - **Affordability**: the bidding team's tokens ≥ the bid's loss stake (rules §4.6).
  - Effects: becomes `highBid`, **cancels any active double** (including a carried-over one)
    and resets `consecutivePasses`. A seat may raise its own or its partner's bid.
- **`pass`**, on the seat's turn. Increments `consecutivePasses`.
- **`double`**, on the seat's turn:
  - The **other team** holds the highest bid, and no double is active.
  - The highest bid is **not forced**.
  - **Affordability**: the doubling team's tokens ≥ 2 × the bid's win stake.
  - Effects: sets `doubledBy`, resets `consecutivePasses`.
- **`redouble`**, at any time during the auction:
  - Any member of the **doubled team**, while a double is active.
  - **Affordability**: the bidding team's tokens ≥ 4 × the bid's loss stake.
  - Effects: the auction **ends immediately** with multiplier 4.

The forced bid is exempt from affordability (rules §4.3).

### 8.3 End of the auction
Checked after every call:
- **After a bid, no double active**: ends after **N − 1 consecutive passes**. The highest
  bidder never gets another turn to raise.
- **After a double**: ends when the turn would get back to the **doubler** with no new bid
  (N − 1 consecutive passes after the double). The doubler doesn't call again. Multiplier 2.
- **No bids at all** (56 and 28 first auction): after **N passes**, the dealer's right takes the
  **forced bid**: 28 no trump in 56, 14 no trump in 28. Event `forcedBid(seat, amount)`.
- **Redouble**: ends at once (§8.2).
- **28 second auction with no new bid**: after **N passes**, the carried bid, its double status
  and its face-down card all stand. This full initial circuit is an exception to the usual
  doubled-auction termination: a double carried from the first auction doesn't end the second
  auction early when the turn first reaches its original doubler.
- On end: event `auctionEnded(contract)` when the contract is known. A 28 auction whose winner
  must place a face-down card instead emits the public event `placingCardStarted(seat)` and
  enters `placingCard`; `auctionEnded` follows `cardPlaced` (§8.4). A 28 match can therefore
  emit `auctionEnded` twice: once for each auction.

### 8.4 28: face-down card and second deal (rules §10.2)
- **`placeCard(card)`**, from the auction winner in `placingCard`:
  - The card must be in their hand. Its suit becomes the **hidden trump**. Otherwise rejected
    with `notYourTurn` (another seat) or `cardNotInHand`.
  - The card leaves the hand and becomes `faceDown`.
  - Event `cardPlaced(seat, card)`, then `auctionEnded(contract)` with `hidden(suit)` trump.
- **After the first auction**:
  1. If the contract is **forced 14 no trump**, no card is placed. Otherwise the winner places one.
  2. The engine deals `undealt` (event `dealt(second, …)`). No system action is needed.
  3. The redeal check runs (§7.1).
  4. If the first auction ended in a **redouble**, or its bid is **28** (doubled or not), play
     starts with the placed hidden trump and the first-auction contract, including its
     multiplier. Otherwise the second auction starts, with the first-auction bid as
     `carriedBid`; the first-auction `contract` stands until the second auction ends (§6.3).
- **After the second auction**:
  - **New winner** (including the holder raising their own bid): any earlier face-down card goes
    back to its owner's hand (event `faceDownReturned(seat, card)`), and the winner places a card
    of any suit. The holder may keep the same suit or switch.
  - **No new bid**: everything carried over stands. A forced 14 no trump that stands is played
    as **no trump**, with no face-down card.
- The carried bid can be doubled (unless forced), and a carried double can be redoubled.
- **Event orders**:
  - First auction won normally or by redouble: `passed` or `redoubled`, then
    `placingCardStarted(winner)`. Then `placeCard`: `cardPlaced`, `auctionEnded`,
    `dealt(second)`, then `auctionStarted(28-second)`, or `playStarted` for a redoubled or 28
    first auction.
  - Forced 14: `passed`, `forcedBid`, `auctionEnded`, `dealt(second)`,
    `auctionStarted(28-second)`.
  - Redeal after the second deal: `dealt(second)`, `redealt`, `faceDownReturned` (only when a
    card was placed), `matchEnded(redealt)`.
  - Second auction with a new winner: `passed` or `redoubled`, `faceDownReturned` (when a card
    is face down), `placingCardStarted(winner)`. Then `placeCard`: `cardPlaced`, `auctionEnded`,
    `playStarted`.
  - Second auction with no new bid: `passed` or `redoubled`, `auctionEnded`, `playStarted`.

### 8.5 Start of play
- The `contract` is fixed with bidder, amount, trump, multiplier and `forced`.
- Event `playStarted(leader)`. The **dealer's right** leads the first round.

## 9. Play

### 9.1 Actions
- **`playCard(card)`**, on the seat's turn, in `play`, with no surrender vote running. The card is
  from the hand, or the face-down card (§9.3).
- **`askReveal`** (28 only), on the seat's turn, when:
  - trump is still hidden
  - the current round already has a lead card (the seat isn't leading)
  - the seat hasn't asked yet this turn
  - the seat isn't the bidder in a forced face-down situation (§9.3)

  Effects: event `revealAsked(seat)` then `trumpRevealed(card)`. The face-down card goes back
  to the bidder's hand. `revealedInRound` and `revealedThisRound` are set.
  `revealAskedBy` is set to the seat.

### 9.2 Legal plays
The same rules in both illegal-play modes:
1. **Following suit**: if the seat holds a card of the lead suit, it must play one. **Exception**:
   the seat in `revealAskedBy` may play any card on this turn.
2. **Leading trump**: a seat can't lead a trump card unless one of these is true:
   - `trumpPlayed` is set
   - every card in its hand is trump
   - trump is `noTrump`, or still hidden (28; the hidden suit is a plain suit)
3. **The face-down card** follows §9.3.

In 28 before the reveal, "holding the lead suit" looks only at the hand. The face-down card
isn't part of the hand.

### 9.3 The face-down card
The bidder can play the face-down card **only when forced**:
- trump is **led** before the reveal and the face-down card is the bidder's **only card of the
  trump suit** (the hand holds none), or
- the face-down card is the bidder's **last card**.

Playing it counts as the reveal: events `trumpRevealed(card)` then
`cardPlayed(seat, card, fromFaceDown)`, and the reveal round is set.

While forced, `askReveal` is rejected. At any other time the face-down card can only be played
after a reveal has put it back in the hand, where it is an ordinary card. Playing the face-down
card at any other time is **rejected in both modes** with `faceDownNotPlayable`.

If the bidder holds other trump-suit cards when trump is led, they follow suit with one of those
and the face-down card stays hidden.

### 9.4 Illegal plays by mode

**Always rejected, in both modes**:
- not the seat's turn (`notYourTurn`)
- card not in hand (`cardNotInHand`)
- face-down card when not forced (`faceDownNotPlayable`)
- playing or asking during a surrender vote (`surrenderVoteRunning`)
- `askReveal` when not allowed by §9.1 (`revealNotAllowed`)

**Disqualifying plays**:
| Kind | What happened |
|---|---|
| `didNotFollowSuit` | Played another suit while holding the lead suit (and not in `revealAskedBy`) |
| `ledTrumpEarly` | Led trump against rule 2 of §9.2 |
| `didNotPlayFaceDown` | The bidder was forced (§9.3) and played a different card |
| `revealWhileAbleToFollow` | Asked for the reveal while holding the lead suit |

- **Block**: rejected with `illegalPlay(kind)`.
- **Auto-stop**: accepted. Events:
  1. `cardPlayed(…)`, or for a reveal request `revealAsked(seat)` and `trumpRevealed(card)`
  2. `disqualified(seat, kind)`
  3. The match is scored at once (§10.2) with outcome `disqualified`.

  Rounds aren't finished. Points already collected are recorded in the summary.

### 9.5 What counts as trump
- **56**: the trump suit. None in a no-trump match.
- **28**: the trump suit, **from the round where trump was revealed onward**. In that round,
  trump-suit cards played **before** the reveal also count. In rounds finished before the reveal,
  and in a no-trump match, nothing counts as trump.

### 9.6 Winning a round
- The winner is the highest card that **counts as trump**. If there's none, the highest card of
  the **lead suit**. Other cards can't win.
- Between identical cards, the one played first ranks higher.
- On the round's last card:
  - event `roundWon(seat, team, points)`
  - the winner's team adds the round's points
  - if any card in the round counted as trump, `trumpPlayed` is set
  - the winner leads the next round; `revealAskedBy` and `revealedThisRound` clear
  - the surrender certainty check runs (§10.1)
- After the last round, the match is scored (§10.2): **made** if the bidding team's points ≥ the
  contract amount, otherwise **failed**.

## 10. Surrender, End match, scoring and session flow

### 10.1 Surrender (only when `surrenderOption` is `on`)
- **Certainty check**, after every round:
  - bidding team points ≥ contract amount → the **defenders** have lost
  - bidding team points + points not yet collected < contract amount → the **bidding team**
    has lost

  The first time either is true, `surrender.decided` is set and event
  `resultDecided(losingTeam)` is emitted. It stays set for the rest of the match.
- **`proposeSurrender`**, from any member of the losing team:
  - in `play`, not necessarily on their turn
  - only when `decided` is set, no vote is running, and `lastFailedRound` isn't the current round
  - Effects: event `surrenderProposed(seat)`. A vote starts with the proposer counted as **yes**.
    Play is paused.
- **`voteSurrender(yes | no)`**, from each other member of the losing team, once.
  Event `surrenderVoted(seat, vote)`.
- **Vote end**, checked after each vote (team size `T`):
  - **Passes** when yes votes > `T / 2` (4 players: 2 of 2; 6 players: 2 of 3; 8 players:
    3 of 4). Event `surrendered(team)`, then scoring with outcome `surrendered`: the losing team
    pays its side's stake as if the result had played out.
  - **Fails** when no votes make passing impossible. Event `surrenderFailed`.
    `lastFailedRound` is set to the current round, and play resumes.
- There's no vote timer. A disconnected voter is a stall, handled by the service.

### 10.2 End match (host)
- **`endMatch(restart)`**: allowed in `auction`, `placingCard` or `play` (also during a vote).
  - No tokens move. The match is logged with outcome `restarted`.
  - The phase becomes `awaitingDeal(restart)` with the **same dealer**.
- **`endMatch(award, team)`**: allowed only in `play` (also during a vote).
  - If `team` is the bidding team, the defenders pay the **win stake**. Otherwise the bidding
    team pays the **loss stake**.
  - Outcome `awarded(team)`.
- Ending a match cancels any running vote.

### 10.3 Scoring and tokens
- **Stake** = the tier's win or loss stake for the contract amount, × `multiplier`.
- **Who pays**:
  | Outcome | Payer | Stake |
  |---|---|---|
  | made | defenders | win |
  | failed | bidding team | loss |
  | disqualified, offender is the bidding team | bidding team | loss |
  | disqualified, offender is a defender | defenders | win |
  | surrendered by the defenders | defenders | win |
  | surrendered by the bidding team | bidding team | loss |
  | awarded to the bidding team | defenders | win |
  | awarded to the defenders | bidding team | loss |
- A team pays what it owes, or everything it has if that's less. The other team receives the
  same amount. Balances never go below 0.
- **Match summary**, sent in `matchEnded(summary)`:
  - dealer
  - nullable summary contract (bidder, amount, public trump state, bid style, multiplier, forced);
    it is null when a restart occurs before any contract exists, and an unrevealed 28 trump is
    stored only as `hidden` without its suit or face-down card. In 28 the contract is set when
    the first auction ends and replaced when the second auction ends (§6.3), so a restart during
    the second auction or its placement logs the public first-auction contract
  - points per team
  - tokens moved and running tokens
  - outcome: `made`, `failed`, `disqualified(seat, kind)`, `surrendered(team)`,
    `awarded(team)`, `restarted` or `redealt(reason)`

  Scored outcomes and every host restart are appended to `matchLog`. A 56 automatic redeal is
  emitted for its transient notice but isn't appended. A 28 automatic redeal is appended because
  its first auction already occurred; the redeal check runs before any second auction starts, so
  its summary contains the public first-auction contract and zero token movement. Canonical summaries erase the unrevealed suit/card rather than relying only
  on view redaction. This prevents a later occupant of the old bidder's seat from learning it
  after players move.

### 10.4 Session flow
- **After a scored match** (made, failed, disqualified, surrendered, awarded):
  - if a team is at 0 tokens: phase `sessionOver(winner, summary)`, event `sessionEnded(winner)`
  - otherwise: phase `matchOver(summary)`
- **`startNextMatch`** (system, sent after everyone taps Ready): `dealer` becomes
  `dealer + 1`, event `nextMatchStarted(dealer)`, phase `awaitingDeal(nextMatch)`.
- **Redeal and restart** skip `matchOver` and go straight to `awaitingDeal` with the same
  dealer. The engine remains pure and waits for the service to supply the next deck. The service
  persists and broadcasts the result before enqueueing that same-dealer deal; no Ready gate is
  required.
- **`restartSession(firstDealer)`** (system, from `sessionOver`):
  - the winner and final tokens are added to `pastSessions`
  - tokens reset to `startingTokens`, `matchLog` is cleared, `dealer` is `firstDealer`
  - event `sessionRestarted(firstDealer)`, phase `awaitingDeal(firstDeal)`

## 11. Events, redaction and views

### 11.1 Events
| Group | Events |
|---|---|
| Session | `sessionStarted(firstDealer, tokens)`, `sessionRestarted(firstDealer)`, `sessionEnded(winner)`, `nextMatchStarted(dealer)` |
| Deal | `dealt(stage, hands)`, `redealt(reason)` |
| Auction | `auctionStarted(stage, firstTurn, minBid)`, `bidMade(seat, amount, suit?, style?)`, `passed(seat)`, `doubled(seat)`, `doubleCancelled`, `redoubled(seat)`, `forcedBid(seat, amount)`, `auctionEnded(contract)` |
| 28 face-down card | `placingCardStarted(seat)`, `cardPlaced(seat, card)`, `faceDownReturned(seat, card)`, `revealAsked(seat)`, `trumpRevealed(card)` |
| Play | `playStarted(leader)`, `cardPlayed(seat, card, fromFaceDown)`, `roundWon(seat, team, points)`, `disqualified(seat, kind)` |
| Surrender | `resultDecided(losingTeam)`, `surrenderProposed(seat)`, `surrenderVoted(seat, vote)`, `surrenderFailed`, `surrendered(team)` |
| End of match | `matchEnded(summary)` |

A bid that cancels an active double emits `bidMade` followed by `doubleCancelled`, in that order,
in the same action.

Events are the full record of what happened. The service can save them, the UI's animation
queue plays them in order (design §12.6), and /debug shows them in its event log.

### 11.2 Redaction
`redactEvent(event, viewer, viewSettings)`:
- `dealt`: the viewer's own cards only. Other seats appear as card counts. The Table view sees
  only counts.
- `cardPlaced`, `faceDownReturned`: the card is shown only to its owner. Others see that a card
  was placed or returned.
- `auctionEnded` in 28: trump is shown as `hidden` to everyone except the bidder.
- `placingCardStarted`: public, not redacted.
- `roundWon`: `points` removed when live points are off.
- `resultDecided`: sent only to seats on the losing team.
- All other events are public.

Match summaries nested in events already contain only a summary contract. Finishing a match
removes an unrevealed 28 suit/card before the canonical summary is recorded or projected,
including for the bidder.

### 11.3 Views
`view(state, viewer, viewSettings)`:
- **Public (every viewer, including the Table view)**:
  - phase, seats and teams, tokens, dealer, whose turn
  - auction calls, highest bid, bid style, double or redouble
  - the contract; trump shown in 56, and in 28 only after the reveal
  - whether a face-down card exists and whose it is
  - card counts per seat
  - the current round
  - finished rounds, per round history: none, the last one, or all
  - points per team, only when live points are on
  - surrender vote status (proposer and votes so far)
  - recipient-safe public match summaries in `matchLog`, `pastSessions`, and the match or session
    summary; contracts may be absent, and an unrevealed 28 trump is never projected
- **For a seat only**:
  - its own hand
  - its own face-down card, face up and separate from the hand
  - `allowedActions` (§12)
  - `resultDecided`, if it's on the losing team
- **Table view**: public only, with no allowed actions.
- The service adds `allowedHostActions` to the host's view and to an unlocked Table view.
- **Never in any view**: other seats' hands, `undealt`, the deck, or the hidden trump for anyone
  except the bidder.

After each action the service sends each connection its redacted events and a fresh view. The
message format is decided with the tech stack.

## 12. Allowed actions

`allowedActions(state, seat)` lists what the UI should offer. Anything not listed is rejected by
`decide`, except in Auto-stop, where disqualifying plays are listed and accepted.

- **Auction**: `bid` with the allowed amount range (after affordability) and, in 56, suit and
  bid-style choices; `pass`; `double` when allowed; `redouble` for every member of the doubled
  team while allowed.
- **`placingCard`**: `placeCard` with the cards in hand.
- **Play** (cards and `askReveal` only on the seat's turn):
  - **Block**: the legal cards (§9.2 and §9.3), plus `askReveal` when the seat can't follow suit
    and isn't forced.
  - **Auto-stop**: every card in hand, plus the face-down card when forced, plus `askReveal`
    whenever trump is hidden, the seat isn't leading and isn't forced.
  - Nothing while a surrender vote runs, except `voteSurrender` for losing-team members who
    haven't voted.
  - `proposeSurrender` for losing-team members when allowed (§10.1).

`allowedHostActions(state)` returns `endMatch.restart` (true in `auction`, `placingCard`,
`play`) and `endMatch.award` (true in `play`).

## 13. Errors and guarantees

### 13.1 Errors
- A **rejection** is a normal result with a `code` and `details`. The client shows a message from
  the translation files.
- **Invalid config** is rejected by `newSession` (§5.2).
- **`evolve` never fails** on events from `decide`. If an event can't be applied, that's an engine
  bug, and evolve throws instead of trying to recover.

### 13.2 Guarantees
These guarantees are direct automated-test targets. Tests are not required solely for coverage,
but any executable verification of them is committed as a focused test rather than a disposable
inline command or temporary harness.
- The same state and action always give the same result.
- Every card is in exactly one place: a hand, `undealt`, `faceDown`, the current round or a
  finished round.
- Team points equal the points of the rounds each team won. When all rounds are finished they
  add up to 56 or 28.
- Tokens change only through scoring, and never go below 0.
- Replaying a session's events from `newSession` rebuilds the exact state.
- State is plain data that can be saved as JSON.

## 14. Left to the service and later work

- **Service**: persistence (state, events or both), seats and players, the host role, stalls, the
  Ready gate, timers, choosing the first dealer, shuffling with the injected random source
  (seeded for /debug).
- **Bots (later)**: call `allowedActions`, choose one, send it through `act`.
- **/debug**: runs the same engine on in-memory state with a seeded shuffle; "Show all hands"
  reads the full state directly.
