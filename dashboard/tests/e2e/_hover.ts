/**
 * Hovering a mark of the Fleet swimlane from a spec.
 *
 * A mark does not hold still under a resting pointer. The window
 * advances (3 px a second at 5m), and every row below the divider
 * between the live and the recent agents moves 9 px when that divider
 * comes or goes, which it does as an agent that another spec has just
 * posted for passes 15 s without an event. A 10 px glyph or an 8 px
 * line then leaves the pointer, `mouseleave` closes its tooltip, and
 * the tooltip does not come back to a pointer that does not move. A
 * spec that hovers once and then asserts fails whenever that move
 * lands between the two.
 *
 * The same move is why a spec that compares positions reads them in
 * one synchronous `evaluate`: boxes read one call at a time can be
 * 9 px apart on the same lane.
 */
import { expect } from "@playwright/test";

/** How long one hover gets to show what it opens before the pointer
 *  is put back on the mark. A tooltip opens in the render the hover
 *  causes, so a second is many frames. It is the timeout of the
 *  assertions inside `hoverUntil`. */
export const HOVER_SHOWS_MS = 1_000;
/** How long `hoverUntil` repeats a hover. The rows move a few pixels
 *  at a time and about once a second; ten seconds is several such
 *  moves. */
const HOVER_SETTLE_MS = 10_000;

/**
 * Hover a mark until what the hover shows holds, as a user who finds
 * the tooltip gone hovers the mark again: one retried block. `hover`
 * puts the pointer on the mark (and reads the mark's box again if it
 * needs one); `shows` asserts what the hover opens, each assertion
 * with `HOVER_SHOWS_MS` as its timeout, so that a miss is followed by
 * a new hover.
 */
export async function hoverUntil(
  hover: () => Promise<void>,
  shows: () => Promise<void>,
): Promise<void> {
  await expect(async () => {
    await hover();
    await shows();
  }).toPass({ timeout: HOVER_SETTLE_MS });
}
