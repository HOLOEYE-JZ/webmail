/**
 * The follow-up dialog's action menu as the user keeps it (Settings ›
 * Follow-ups): their own actions, the operator's, and the built-in ones, in
 * the user's order, each shown in the menu or not. Kept in one setting,
 * `followUpMenu`, synced like the others; the default action
 * (`followUpDefaultAction`) names one of them by its ref.
 */
import { FOLLOW_UP_ACTION_NAMES } from "./follow-up-action-names";
import {
  FOLLOW_UP_ACTIONS,
  MAX_EXTRA_FOLLOW_UP_ACTIONS,
  MAX_FOLLOW_UP_ACTION_LENGTH,
  normalizeAction,
  sanitizeFollowUpActions,
  type FollowUpActionKey,
} from "./follow-up-actions";

export interface FollowUpMenuSetting {
  /** The user's own actions, as typed, in the order added. */
  own: string[];
  /** Refs in the user's order; the rest follow their group in its own order. */
  order: string[];
  /** Refs the user switched on or off; the rest are shown as `shownByDefault` says. */
  shown: Record<string, boolean>;
}

export const EMPTY_FOLLOW_UP_MENU: FollowUpMenuSetting = { own: [], order: [], shown: {} };

/** Where an action comes from, in the menu's order: the user's, the operator's, built in. */
export type FollowUpActionGroup = "own" | "company" | "builtin";
const GROUPS: readonly FollowUpActionGroup[] = ["own", "company", "builtin"];

export interface FollowUpMenuEntry {
  ref: string;
  group: FollowUpActionGroup;
  /** The built-in action's key. */
  key?: FollowUpActionKey;
  /** What the menu shows and the task's title carries. */
  text: string;
  shown: boolean;
}

/** A built-in action's ref; the others are named by their text. */
export const builtInRef = (key: FollowUpActionKey) => `builtin:${key}`;
export const textRef = (text: string) => `text:${normalizeAction(text).toLocaleLowerCase()}`;

/** The default action's ref when nobody chose one: "Follow up". */
export const DEFAULT_FOLLOW_UP_ACTION = builtInRef("follow_up");

const nameKey = (text: string) => normalizeAction(text).toLocaleLowerCase();
const BUILT_IN_NAMES = new Set(Object.values(FOLLOW_UP_ACTION_NAMES).flat().map(nameKey));

/** Whether a text names a built-in action in any language ("Anrufen", "Call"). */
export function namesBuiltInAction(text: string): boolean {
  return BUILT_IN_NAMES.has(nameKey(text));
}

/**
 * The menu as the user sees it in the settings: every action once, by
 * group, each group in the user's order. An operator's action named as a
 * built-in one is left out (the built-in one stands for it); an own action
 * named as either, too.
 */
export function followUpMenu({ menu, company, name, builtInShown = FOLLOW_UP_ACTIONS }: {
  menu: FollowUpMenuSetting;
  /** The operator's actions (`policy.followUpActions`). */
  company: readonly string[];
  /** A built-in action's name in the current language. */
  name: (key: FollowUpActionKey) => string;
  /** The built-in actions shown until the user switches them. */
  builtInShown?: readonly FollowUpActionKey[];
}): FollowUpMenuEntry[] {
  const seen = new Set<string>();
  const entries: FollowUpMenuEntry[] = [];
  for (const key of FOLLOW_UP_ACTIONS) {
    entries.push({ ref: builtInRef(key), group: "builtin", key, text: name(key), shown: builtInShown.includes(key) });
    seen.add(nameKey(name(key)));
  }
  const add = (group: FollowUpActionGroup, list: readonly string[]) => {
    for (const text of sanitizeFollowUpActions(list)) {
      if (seen.has(nameKey(text)) || namesBuiltInAction(text)) continue;
      seen.add(nameKey(text));
      entries.push({ ref: textRef(text), group, text, shown: true });
    }
  };
  add("company", company);
  add("own", menu.own);
  const rank = new Map(menu.order.map((ref, index) => [ref, index]));
  const natural = new Map(entries.map((entry, index) => [entry.ref, index]));
  const place = (entry: FollowUpMenuEntry) => rank.get(entry.ref) ?? menu.order.length + natural.get(entry.ref)!;
  return entries
    .map((entry) => (typeof menu.shown[entry.ref] === "boolean" ? { ...entry, shown: menu.shown[entry.ref] } : entry))
    .sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || place(a) - place(b));
}

/** The menu with `ref` switched on or off. */
export function withShown(menu: FollowUpMenuSetting, ref: string, shown: boolean): FollowUpMenuSetting {
  return { ...menu, shown: { ...menu.shown, [ref]: shown } };
}

/** The menu in the order the entries now stand. */
export function withOrder(menu: FollowUpMenuSetting, entries: readonly FollowUpMenuEntry[]): FollowUpMenuSetting {
  return { ...menu, order: entries.map((entry) => entry.ref) };
}

export type OwnActionProblem = "empty" | "too_long" | "exists" | "full";

/**
 * Why `text` cannot become one of the user's own actions, or null: it must
 * say something, fit the operator's limit, and name no action the menu has
 * already (ignoring case) nor a built-in one in any language. `except` is
 * the action being renamed.
 */
export function ownActionProblem(
  text: string,
  entries: readonly FollowUpMenuEntry[],
  menu: FollowUpMenuSetting,
  except?: string,
): OwnActionProblem | null {
  const action = normalizeAction(text);
  if (!action) return "empty";
  if (action.length > MAX_FOLLOW_UP_ACTION_LENGTH) return "too_long";
  const others = entries.filter((entry) => entry.ref !== (except === undefined ? undefined : textRef(except)));
  if (namesBuiltInAction(action) || others.some((entry) => nameKey(entry.text) === nameKey(action))) return "exists";
  if (except === undefined && menu.own.length >= MAX_EXTRA_FOLLOW_UP_ACTIONS) return "full";
  return null;
}

/** The menu with `text` added as the user's own action, shown, after the others. */
export function withOwnAction(menu: FollowUpMenuSetting, text: string): FollowUpMenuSetting {
  const action = normalizeAction(text);
  const ref = textRef(action);
  const shown = { ...menu.shown };
  delete shown[ref];
  return { own: [...menu.own, action], order: menu.order.filter((r) => r !== ref), shown };
}

/** The menu with an own action renamed, keeping its place and whether it is shown. */
export function withRenamedAction(menu: FollowUpMenuSetting, from: string, to: string): FollowUpMenuSetting {
  const oldRef = textRef(from);
  const action = normalizeAction(to);
  const newRef = textRef(action);
  const shown = { ...menu.shown };
  if (oldRef in shown) {
    shown[newRef] = shown[oldRef];
    if (newRef !== oldRef) delete shown[oldRef];
  }
  return {
    own: menu.own.map((a) => (textRef(a) === oldRef ? action : a)),
    order: menu.order.map((r) => (r === oldRef ? newRef : r)),
    shown,
  };
}

/** The menu without an own action. */
export function withoutAction(menu: FollowUpMenuSetting, text: string): FollowUpMenuSetting {
  const ref = textRef(text);
  const shown = { ...menu.shown };
  delete shown[ref];
  return { own: menu.own.filter((a) => textRef(a) !== ref), order: menu.order.filter((r) => r !== ref), shown };
}

/**
 * The setting as a server blob or a settings file carries it, which may
 * come from another build or be edited by hand: anything malformed dropped,
 * the own actions within the operator's limits.
 */
export function sanitizeFollowUpMenu(raw: unknown): FollowUpMenuSetting {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_FOLLOW_UP_MENU };
  const input = raw as Partial<Record<keyof FollowUpMenuSetting, unknown>>;
  const order = Array.isArray(input.order) ? [...new Set(input.order.filter((r): r is string => typeof r === "string"))] : [];
  const shown: Record<string, boolean> = {};
  if (input.shown && typeof input.shown === "object" && !Array.isArray(input.shown)) {
    for (const [ref, value] of Object.entries(input.shown)) {
      if (typeof value === "boolean" && ref !== "__proto__") shown[ref] = value;
    }
  }
  return { own: sanitizeFollowUpActions(input.own), order, shown };
}

/**
 * The action a new follow-up starts with: the entry `ref` names, else
 * "Follow up" (an own action deleted since, an operator's withdrawn).
 */
export function defaultFollowUpAction(entries: readonly FollowUpMenuEntry[], ref: string): FollowUpMenuEntry {
  return entries.find((entry) => entry.ref === ref)
    ?? entries.find((entry) => entry.ref === DEFAULT_FOLLOW_UP_ACTION)!;
}
