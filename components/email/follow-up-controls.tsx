"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, Info } from "@/components/icons";

/** Space kept between a popover or a hint and the window's edge. */
const EDGE = 8;

/**
 * Where a floating box goes beside its anchor: below it (a popover) or above
 * it (a hint), turned to the other side when there is no room, and kept
 * inside the window. Fixed, so a dialog that scrolls does not cut it off.
 */
function useFloating(open: boolean, anchor: RefObject<HTMLElement | null>, box: RefObject<HTMLElement | null>, side: "below" | "above") {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden", top: 0, left: 0 });
  useLayoutEffect(() => {
    if (!open) {
      setStyle({ visibility: "hidden", top: 0, left: 0 });
      return;
    }
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const b = box.current;
      if (!a || !b) return;
      const width = b.offsetWidth;
      const height = b.offsetHeight;
      const below = a.bottom + 4;
      const above = a.top - 4 - height;
      let top = side === "below"
        ? (below + height > window.innerHeight - EDGE && above >= EDGE ? above : below)
        : (above < EDGE ? below : above);
      top = Math.max(EDGE, Math.min(top, window.innerHeight - EDGE - height));
      const left = Math.max(EDGE, Math.min(side === "below" ? a.left : a.left + a.width / 2 - width / 2, window.innerWidth - EDGE - width));
      setStyle({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, box, side]);
  return style;
}

/**
 * A property shown as a button with its value ("Follow up ▾", "Only me ▾"),
 * which opens a popover to change it.
 */
export const PropertyButton = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** The value is one the user set or a group: drawn like a chosen chip. */
  set?: boolean;
  icon?: ReactNode;
  expanded: boolean;
}>(function PropertyButton({ set, icon, expanded, className, children, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-haspopup="listbox"
      aria-expanded={expanded}
      className={cn(
        "inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-60",
        set
          ? "border-primary/50 bg-primary/10 text-foreground hover:bg-primary/15"
          : "border-border bg-muted text-foreground hover:bg-accent",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
});

const OPTION = "[role=option]:not([aria-disabled=true])";

/**
 * The popover of a `PropertyButton`: a list of options, inside the window
 * whatever the window's width. Escape closes it (and only it), as does a
 * click or the focus going elsewhere; the focus goes back to its button.
 * Rendered inside the dialog, so the dialog's focus trap takes it in.
 */
export function PropertyPopover({ anchor, open, onClose, label, testId, header, children }: {
  anchor: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onClose: () => void;
  /** The list's accessible name. */
  label: string;
  testId?: string;
  /** Above the list, not scrolled with it: a search field. */
  header?: ReactNode;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const style = useFloating(open, anchor, box, "below");

  const close = useCallback((refocus: boolean) => {
    onClose();
    if (refocus) anchor.current?.focus();
  }, [onClose, anchor]);

  useEffect(() => {
    if (!open) return;
    const pop = box.current;
    // The chosen option first, else the search field, else the first option.
    const first = pop?.querySelector<HTMLElement>(`${OPTION}[aria-selected=true]`)
      ?? pop?.querySelector<HTMLElement>("input")
      ?? pop?.querySelector<HTMLElement>(OPTION);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Before the dialog's own handler, which would close the dialog.
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        close(true);
      }
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (anchor.current?.contains(target) || pop?.contains(target)) return;
      close(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open, anchor, close]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const options = Array.from(box.current?.querySelectorAll<HTMLElement>(OPTION) ?? []);
    if (options.length === 0) return;
    e.preventDefault();
    const at = options.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0
      : e.key === "End" ? options.length - 1
      : e.key === "ArrowDown" ? (at + 1) % options.length
      : (at <= 0 ? options.length - 1 : at - 1);
    options[next].focus();
  };

  return (
    <div
      ref={box}
      data-testid={testId}
      style={style}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && !box.current?.contains(next) && !anchor.current?.contains(next)) close(false);
      }}
      className="fixed z-[70] flex w-max min-w-[13rem] max-w-[calc(100vw-1rem)] flex-col rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
    >
      {header}
      <div role="listbox" aria-label={label} className="max-h-[min(18rem,calc(100vh-8rem))] overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

/** One option of a `PropertyPopover`. A disabled one says why in `title`. */
export function PopoverOption({ selected, disabled, title, onSelect, testId, icon, sub, children }: {
  selected: boolean;
  disabled?: boolean;
  title?: string;
  onSelect?: () => void;
  testId?: string;
  icon?: ReactNode;
  /** A muted second part on the right. */
  sub?: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      title={title}
      data-testid={testId}
      onClick={() => { if (!disabled) onSelect?.(); }}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "bg-primary/10 font-medium text-foreground" : "hover:bg-muted",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      {sub && <span className="ml-auto shrink-0 pl-3 text-xs font-normal text-muted-foreground">{sub}</span>}
    </button>
  );
}

/** A small heading inside a popover's list. */
export function PopoverHeading({ children }: { children: ReactNode }) {
  return <div className="px-2 pb-0.5 pt-1.5 text-xs text-muted-foreground">{children}</div>;
}

export function PopoverSeparator() {
  return <div role="separator" className="my-1 h-px bg-border" />;
}

/**
 * ⓘ: an explanation shown while the pointer is over it or it has the focus
 * (a tap focuses it on a phone). Its text stays in the page as the button's
 * description, so a screen reader reads it with the button.
 */
export function HelpTip({ label, testId, children }: {
  /** The button's name ("Explanation"). */
  label: string;
  testId?: string;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const style = useFloating(open, button, tip, "above");
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-describedby={id}
        data-testid={testId ? `${testId}-button` : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => { if (document.activeElement !== button.current) setOpen(false); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(true)}
        className="inline-grid h-5 w-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Info className="h-4 w-4" aria-hidden="true" />
      </button>
      <span
        ref={tip}
        id={id}
        role="tooltip"
        data-testid={testId}
        hidden={!open}
        style={style}
        className="fixed z-[70] w-64 max-w-[calc(100vw-1rem)] space-y-1 rounded-md bg-foreground px-2.5 py-2 text-xs font-normal leading-snug text-background shadow-lg"
      >
        {children}
      </span>
    </>
  );
}
