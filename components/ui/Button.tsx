"use client";

import { forwardRef } from "react";
import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost" | "accent";
type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps
  extends Omit<ComponentPropsWithoutRef<"button">, "onClick" | "children" | "type"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  href?: string;
  target?: string;
  children?: ReactNode;
  fullWidth?: boolean;
  onClick?: () => void;
  type?: "button" | "submit" | "reset";
}

const base =
  "inline-flex items-center justify-center gap-2 rounded-full font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 min-h-[44px]";

const sizes: Record<ButtonSize, string> = {
  sm: "px-4 text-sm",
  md: "px-6 text-[15px]",
  lg: "px-7 text-base",
};

const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--text-primary)] text-[var(--bg)] hover:opacity-90 active:opacity-80",
  secondary:
    "bg-[var(--surface-secondary)] text-[var(--text-primary)] border border-[var(--border)] hover:bg-[var(--surface)] active:opacity-90",
  ghost:
    "bg-transparent text-[var(--text-primary)] hover:bg-[var(--surface-secondary)]",
  accent:
    "bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)] active:opacity-90",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = "primary",
      size = "md",
      loading = false,
      disabled,
      href,
      target,
      children,
      fullWidth,
      onClick,
      type,
      ...props
    },
    ref,
  ) => {
    const classes = cn(
      base,
      sizes[size],
      variants[variant],
      fullWidth && "w-full",
      className,
    );

    const content = (
      <>
        {loading ? (
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
        ) : null}
        {children}
      </>
    );

    if (href) {
      return (
        <a
          ref={ref as unknown as Ref<HTMLAnchorElement>}
          href={href}
          target={target}
          className={classes}
          aria-disabled={loading}
          onClick={onClick}
        >
          {content}
        </a>
      );
    }

    return (
      <button
        ref={ref}
        type={type ?? "button"}
        disabled={disabled || loading}
        onClick={onClick}
        className={classes}
        {...props}
      >
        {content}
      </button>
    );
  },
);

Button.displayName = "Button";
