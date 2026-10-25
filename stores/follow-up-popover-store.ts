import { create } from "zustand";
import type { Email } from "@/lib/jmap/types";

/** Where the popover's top left corner goes, in window coordinates. */
export interface FollowUpPopoverPoint {
  x: number;
  y: number;
}

interface FollowUpPopoverState {
  /** The mail the popover sets the follow-up of, null while it is closed. */
  email: Email | null;
  position: FollowUpPopoverPoint;
  /** What gets the focus back when the popover closes, if the focus would be lost. */
  trigger: HTMLElement | null;
  /** Opens it at a point, e.g. where the user right clicked. */
  openAt: (email: Email, at: FollowUpPopoverPoint, trigger?: HTMLElement | null) => void;
  /** Opens it under an element, e.g. a button, which gets the focus back. */
  openBelow: (email: Email, anchor: HTMLElement) => void;
  close: () => void;
}

/** Space between an element and the popover under it. */
const GAP = 4;

/**
 * The one popover "Follow up" of the mail view (`FollowUpPopoverHost`):
 * opened by the flag's right click, the mail's context menu or any button,
 * and kept apart from them, since a context menu is gone once it opened it.
 */
export const useFollowUpPopover = create<FollowUpPopoverState>((set) => ({
  email: null,
  position: { x: 0, y: 0 },
  trigger: null,
  openAt: (email, at, trigger = null) => set({ email, position: { x: at.x, y: at.y }, trigger }),
  openBelow: (email, anchor) => {
    const rect = anchor.getBoundingClientRect();
    set({ email, position: { x: rect.left, y: rect.bottom + GAP }, trigger: anchor });
  },
  // The trigger stays, so the focus can go back to it.
  close: () => set({ email: null }),
}));
