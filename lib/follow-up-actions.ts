/**
 * What a follow-up asks for ("Flag to" in Outlook): the built-in actions, and
 * the extra ones an operator adds for every user in the admin policy
 * (`followUpActions`, e.g. a step in the company's own systems). Users can
 * always type their own.
 *
 * No dependencies: the server's policy loader uses it too.
 */

/** The built-in actions, as Outlook offers them; keys of `follow_up.actions`. The first is the default. */
export const FOLLOW_UP_ACTIONS = [
  "follow_up",
  "reply",
  "reply_all",
  "call",
  "forward",
  "read",
  "review",
  "for_your_information",
  "no_response_necessary",
  "do_not_forward",
] as const;
export type FollowUpActionKey = (typeof FOLLOW_UP_ACTIONS)[number];

/**
 * An action as typed, its whitespace collapsed and trimmed; `fallback` (the
 * default action, "Follow up") when nothing is left.
 */
export function normalizeAction(text: string, fallback = ""): string {
  return text.replace(/\s+/g, " ").trim() || fallback;
}

/** At most this many extra actions, each at most this long. */
export const MAX_EXTRA_FOLLOW_UP_ACTIONS = 20;
export const MAX_FOLLOW_UP_ACTION_LENGTH = 80;

/**
 * The operator's extra actions as users get them: strings only, trimmed,
 * inner whitespace collapsed, none empty or too long, each once (ignoring
 * case), at most `MAX_EXTRA_FOLLOW_UP_ACTIONS`. policy.json can be edited by
 * hand, so anything else is dropped.
 */
export function sanitizeFollowUpActions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const actions: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const action = normalizeAction(entry);
    if (!action || action.length > MAX_FOLLOW_UP_ACTION_LENGTH) continue;
    const key = action.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push(action);
    if (actions.length >= MAX_EXTRA_FOLLOW_UP_ACTIONS) break;
  }
  return actions;
}
