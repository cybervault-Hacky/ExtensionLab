"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface CardProps extends ComponentPropsWithoutRef<"div"> {
  children?: ReactNode;
  padding?: boolean;
  interactive?: boolean;
}

export function Card({
  className,
  children,
  padding = true,
  interactive = false,
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        "card",
        padding && "card-pad",
        interactive &&
          "transition-transform duration-200 hover:scale-[1.01] hover:shadow-soft",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
