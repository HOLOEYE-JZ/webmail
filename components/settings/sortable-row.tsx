"use client";

import React, { useState, type ReactNode } from "react";
import { GripVertical, Pencil, Trash2 } from "@/components/icons";
import { cn } from "@/lib/utils";

/**
 * Drag to reorder the rows of a settings list (tags, follow-up actions).
 * `onMove` gets the dragged row's index and the one it was dropped on;
 * `canMove` keeps a row within its part of the list.
 */
export function useRowDrag(onMove: (from: number, to: number) => void, canMove?: (from: number, to: number) => boolean) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const end = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };
  const allowed = (index: number) => dragIndex !== null && dragIndex !== index && (!canMove || canMove(dragIndex, index));
  return (index: number): SortableRowDrag => ({
    onDragStart: () => setDragIndex(index),
    onDragOver: (e: React.DragEvent) => {
      if (!allowed(index)) return;
      e.preventDefault();
      if (index !== dragOverIndex) setDragOverIndex(index);
    },
    onDrop: () => {
      if (allowed(index)) onMove(dragIndex!, index);
      end();
    },
    onDragEnd: end,
    isDragOver: dragOverIndex === index && allowed(index),
    isDragging: dragIndex === index,
  });
}

export interface SortableRowDrag {
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  isDragOver: boolean;
  isDragging: boolean;
}

/**
 * A row of a settings list: the grip shown on hover, the row's content, its
 * tools. With `onMoveBy` the grip is a button the arrow keys move the row with.
 */
export function SortableRow({ drag, onMoveBy, moveLabel, className, children, ...rest }: {
  drag: SortableRowDrag;
  onMoveBy?: (delta: number) => void;
  moveLabel?: string;
  className?: string;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "onDragStart" | "onDragOver" | "onDrop" | "onDragEnd" | "draggable">) {
  // Dragging needs a pointer: no grip taking room on a phone.
  const grip = <GripVertical className="hidden sm:block w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-50 group-focus-within:opacity-50 cursor-grab" />;
  return (
    <div
      {...rest}
      draggable
      onDragStart={drag.onDragStart}
      onDragOver={drag.onDragOver}
      onDrop={drag.onDrop}
      onDragEnd={drag.onDragEnd}
      className={cn(
        "flex items-center gap-3 py-2.5 px-3 rounded-md border bg-background group transition-opacity",
        drag.isDragging ? "opacity-40" : "opacity-100",
        drag.isDragOver ? "border-primary" : "border-border",
        className,
      )}
    >
      {onMoveBy ? (
        <button
          type="button"
          aria-label={moveLabel}
          title={moveLabel}
          onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            onMoveBy(e.key === "ArrowUp" ? -1 : 1);
          }}
          className="-m-1 hidden shrink-0 rounded p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:block"
        >
          {grip}
        </button>
      ) : grip}
      {children}
    </div>
  );
}

/** A row's rename and delete buttons, shown on hover. */
export function RowTools({ onEdit, onDelete, editLabel, deleteLabel, deleteDisabled, deleteTitle }: {
  onEdit: () => void;
  onDelete: () => void;
  editLabel: string;
  deleteLabel: string;
  deleteDisabled?: boolean;
  /** The delete button's tooltip, when it differs from its label (why it is disabled). */
  deleteTitle?: string;
}) {
  return (
    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
      <button
        type="button"
        onClick={onEdit}
        className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
        title={editLabel}
        aria-label={editLabel}
      >
        <Pencil className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={deleteDisabled}
        className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
        title={deleteTitle ?? deleteLabel}
        aria-label={deleteLabel}
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
