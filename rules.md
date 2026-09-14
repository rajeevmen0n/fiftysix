# Rules of 56 and 28

This is the source of truth for game logic. It describes the card games themselves. Decisions
specific to the app (rooms, settings, UI behaviour) are in [design.md](design.md). If the code
disagrees with this file, follow this file and flag the difference. If a situation isn't
covered here, ask. Don't make up a rule.

**Terms used here**
- **Match**: one deal. Cards are dealt, there's an auction, every round is played, then tokens
  transfer.
- **Round**: one trick.
- **Hand**: the cards a player holds.

---

## 1. Cards

| Rank (high → low) | J | 9 | A | 10 | K | Q | 8 | 7 |
|---|---|---|---|---|---|---|---|---|
| Points | 3 | 2 | 1 | 1 | 0 | 0 | 0 | 0 |

- Each suit adds up to 7 points (J 3 + 9 2 + A 1 + 10 1).
- Suits don't rank against each other. The only thing that matters is whether a card is trump,
  lead suit, or neither.

## 2. Players, teams and deal

- There is an even number of players in two teams, with teammates in alternate seats.
- Dealing and play both go **counter-clockwise**.
- After each match the deal passes counter-clockwise, to the dealer's right. A redeal (§9)
  is done by the same dealer.
- The player on the **dealer's right** bids first and leads the first round. Each round's
  winner leads the next one.

## 3. 56: setup

- Two decks are used. J 9 A 10 K Q from both gives **48 cards**. The 8s and 7s can also be
  added for **64 cards**. Either way the total is **56 points**.
- The cards must divide evenly among the players:

| Players | 48 cards | 64 cards |
|---|---|---|
| 4 | 12 each | 16 each |
| 6 | 8 each | not possible |
| 8 | 6 each | 8 each |

- All cards are dealt before the auction.

## 4. Auction

This section covers 56 and both auctions in 28. §10 lists what's different in 28.

### 4.1 Calls
- On their turn a player can **bid**, **pass** or **double** (§4.4).
- **Redouble** (§4.5) is the only call made out of turn.
- A pass only counts for that turn. A player who passed can bid on a later turn.
- Partners can overbid each other at any time.

### 4.2 Bids in 56
- A bid is a **number plus a suit**, or a number plus **no trump**. The range is **28–56**.
- Each bid must be a **strictly higher number** than the current highest bid. Suit or no trump
  makes no difference to the order.
- **Bid style** is a way of signalling to teammates and has no effect on the rules. It only
  applies to suit bids:
  - "**30 spades**" (number first) means strong, high-point cards in that suit.
  - "**spades 30**" (suit first) means many cards in that suit, not necessarily high ones.

### 4.3 End of the auction
- **Normal end**: the auction ends after **N−1 passes in a row** following the highest bid,
  where N is the number of players. The highest bidder never gets another turn to raise their
  own bid.
- **Everyone passes without a bid**: the first bidder (dealer's right) is **forced** to take
  **28 no trump** in 56 or **14 no trump** in 28. The forced bid can't be doubled, and token
  limits (§4.6) don't apply to it.

### 4.4 Double
- **Who can double**: any player on the team that doesn't hold the highest bid, **on their own
  turn**, at any bid amount, including the maximum.
- **After a double**:
  - Any player, on either team, can still **overbid** on their turn. That **cancels the
    double**, and the auction continues as normal from the new bid.
  - If every player passes until the turn gets back to the **doubler**, the auction **ends at
    once**. The doubler doesn't get another call.
- The bid's stakes are multiplied by **×2**.

### 4.5 Redouble
- **Who can redouble**: any member of the team whose bid was doubled, **out of turn**, at any
  time after the double and before the auction ends.
- The auction **ends immediately**.
- The stakes become **×4**.

### 4.6 Token limits on calls
A team can only make a call if it can pay the most it could lose from that call.
- **Bid**: the bidding team's tokens must be at least the **loss stake** of that bid. The
  opponents' balance doesn't matter.
- **Double**: the doubling team's tokens must be at least **2× the win stake**, which is what
  they would pay if the bid is made.
- **Redouble**: the bidding team's tokens must be at least **4× the loss stake**.
- The forced bid (§4.3) is exempt.

## 5. Trump

- **56**: the winning bid names the trump suit or no trump. Everyone can see the trump suit and
  any double or redouble.
- **28**: the trump suit is hidden until revealed. See §10.3.

## 6. Play

### 6.1 Following suit
- The first card of a round sets the **lead suit**.
- Each player **must follow the lead suit** if they can.
- A player who can't follow suit may play **any card**. They don't have to play trump or try
  to win the round.

### 6.2 Winning a round
1. If any trump was played, the **highest trump** wins.
2. Otherwise the **highest card of the lead suit** wins.
- Any trump beats every non-trump card. Off-suit cards that aren't trump can never win.
- **Identical cards** (possible with two decks): the one played **first** ranks higher.

### 6.3 Leading trump
- A player **can't lead trump** until a trump has been played in an **earlier round**.
- **Exception**: if the leader holds only trump cards, they can lead one, and that counts as
  trump having been played.
- In a **no trump** match any suit can be led at any time.

## 7. Scoring

- At the end of the match each team adds up the points in the rounds it won. There are no
  bonuses, not for the last round and not for winning every round.
- The bidding team **makes** its bid if its points are **equal to or more than** the bid.
- If the bid is made, the opponents pay the **win stake**. If it isn't, the bidding team pays
  the **loss stake**.

### 7.1 Stakes (default tiers)
Tiers can be changed per room (see design.md).

| Game | Bid | Win stake | Loss stake |
|---|---|---|---|
| 56 | 28–39 | 1 | 2 |
| 56 | 40–55 | 2 | 3 |
| 56 | 56 | 3 | 4 |
| 28 | 14–19 | 1 | 2 |
| 28 | 20–27 | 2 | 3 |
| 28 | 28 | 3 | 4 |

- **Double** multiplies both stakes by ×2, and **redouble** by ×4. For example, a redoubled 30
  in 56 wins 4 or loses 8.

### 7.2 Tokens
- Each team starts with **10 tokens** by default. Rooms can change this.
- Stakes move tokens from one team to the other.
- A team that owes more than it has drops to 0.
- **A team at 0 tokens loses.**

## 8. Illegal play (revoke)

- A **revoke** is failing to follow the lead suit while holding a card of that suit.
- **Penalty**: play stops at once and the offending team **loses the match**. Tokens move at
  the bid's stakes, including any double or redouble:
  - If the offenders are the **bidding team**, they pay the **loss stake**.
  - If the offenders are the **defending team**, they pay the **win stake**.
- The next dealer then deals a new match.
- The app's Auto-stop mode applies this same penalty to a few other illegal plays: leading trump
  too early, and in 28, the bidder not playing a forced face-down card or asking for the reveal
  while able to follow suit. See design.md §4.

## 9. Redeal

Redeals are automatic. The same dealer deals again, and all bids are cancelled. A redeal
happens when:
- one **team holds no Jack**, or
- any player's hand is worth **the threshold or less**. Defaults: **56 → 2 points or less**,
  **28 → 1 point or less**. Rooms can change the threshold.

When the check happens:
- **56**: after the deal.
- **28**: after **all 8 cards** are dealt. A redeal cancels both auctions and the face-down
  trump card. The face-down card still counts as part of its owner's eight-card holding for
  both the hand-point and team-Jack checks.

To prevent a room configuration in which every possible deal must redeal, the app caps a custom
threshold below the average points per player:

| Game and players | Maximum threshold |
|---|---:|
| 56, 4 players | 13 |
| 56, 6 players | 8 |
| 56, 8 players | 6 |
| 28, 4 players | 6 |

## 10. 28: differences from 56

### 10.1 Setup
- One deck of J 9 A 10 K Q 8 7, **32 cards**, for **4 players** with **8 cards each**, and
  **28 points** in total.

### 10.2 Two deals and two auctions
1. **First deal**: 4 cards each.
2. **First auction**: numbers only, no suit, in the range **14–28**. Everything else follows §4
   (passing, doubles, redouble, token limits, the forced **14 no trump**).
3. **Trump card**: the winner picks a trump suit and puts **one card of that suit from their
   hand face down**. This is mandatory, because there's no no-trump bid in 28. The only
   exception is the forced 14 no trump, which has no face-down card.
4. **Second deal**: 4 more cards each.
5. **Second auction**: a new auction starting at the dealer's right, in which everyone gets a
   turn, including whoever holds the current bid.
   - The minimum bid is **21**, or **one more than the current bid** if that's higher.
   - The bid from the first auction carries over, along with its double status.
   - If **all N players pass**, the first-auction bid, its double status and its face-down
     card all stand.
   - Any **new bid** cancels a carried-over double. This includes a raise by the player who
     already holds the bid.
   - The **new winner** places a face-down card of any suit they choose, which can be a
     different suit. Any earlier face-down card goes back to its owner's hand. A player who
     raises their own bid can switch suit or swap the card.
   - The carried-over bid **can be doubled**, and a carried-over double **can be redoubled**.
   - If a double carries over from the first auction, it does **not** shorten this initial circuit
     of the second auction. Every player gets one call. If all four pass, the carried bid and
     double stand; only a redouble or a new bid ends or changes that circuit sooner.
   - If the first auction ended in a **redouble**, there is no second auction. The second
     deal happens and play begins.
   - A **forced 14 no trump** from the first auction still has a second auction. If everyone
     passes again, the match is played as 14 no trump, with no trump at all.
   - The end condition, doubles and token limits work as in §4.

### 10.3 Hidden trump
- Only the bidder knows the trump suit. Until trump is **revealed**, play is the same as no
  trump: any suit can be led, including the hidden trump suit, which counts as a plain suit.
- The **face-down card isn't part of the bidder's hand** and can't be played until it's revealed.
- **Asking for the reveal**: any player who **can't follow suit**, including the bidder, can ask
  for the trump to be revealed.
  - The card is shown to everyone and goes back into the bidder's hand.
  - The player who asked **doesn't have to play trump** and can play any card. If the bidder
    asked, they can choose whether to play the revealed card.
  - A player who can't follow suit can also play without asking for the reveal.
- **The round where trump is revealed**: every trump-suit card in that round counts as trump,
  including cards played before the reveal. Rounds that are already finished stay as they were.
- **When the bidder must reveal**:
  - If the trump suit is led before the reveal and the bidder's only card of that suit is the
    face-down one, they must reveal it and play it.
  - If the face-down card is the bidder's last card, they must reveal it and play it.
  - If the bidder has other cards of the trump suit in hand, they follow suit with one of those
    and the face-down card stays hidden.
- **After the reveal**, the trump-lead rule (§6.3) applies. Only cards that counted as trump,
  from the reveal round onward, count as trump having been played. Trump-suit cards played as
  plain cards before the reveal don't.
- If the match ends before the reveal, the hidden suit and face-down card are **not revealed by
  scoring or the result screen**. Post-match summaries, logs, views and events omit them for every
  recipient; the bidder retains only the knowledge they already had during play.

### 10.4 Stakes
- See §7.1. The defaults are 14–19 → 1/2, 20–27 → 2/3 and 28 → 3/4.
