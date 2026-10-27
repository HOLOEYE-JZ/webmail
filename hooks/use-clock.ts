"use client";

import { useEffect, useMemo, useState } from "react";
import { toDisplayDate } from "@/lib/timezone";

/** Now as a real instant (ms), refreshed every `intervalMs`. */
export function useClock(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** How often lists by due day look at the clock, so a new day moves them. */
const DISPLAY_CLOCK_MS = 60_000;

/** Now on the user's wall clock (a display date, lib/timezone.ts), refreshed every minute. */
export function useDisplayNow(): Date {
  const now = useClock(DISPLAY_CLOCK_MS);
  return useMemo(() => toDisplayDate(new Date(now)), [now]);
}
