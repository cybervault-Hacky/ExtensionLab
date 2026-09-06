"use client";

/**
 * Phase 14: Razorpay Standard Checkout loader.
 *
 * Loads the official checkout script on demand (never upfront), with a
 * bounded timeout and an accessible failure state. The configuration passed
 * to `window.Razorpay` contains ONLY public values the server returned:
 * key id (public by design) + the provider subscription reference. No
 * secrets, no client-chosen amounts — the charge follows the Razorpay plan
 * created server-side.
 */

const SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";
const SCRIPT_TIMEOUT_MS = 15_000;

interface RazorpayHandlerResponse {
  razorpay_payment_id: string;
  razorpay_order_id?: string;
  razorpay_subscription_id?: string;
  razorpay_signature: string;
}

interface RazorpayOptions {
  key: string;
  subscription_id: string;
  name: string;
  description: string;
  theme?: { color?: string };
  handler: (response: RazorpayHandlerResponse) => void;
  modal?: { ondismiss?: () => void; animation?: boolean };
}

interface RazorpayStatic {
  new (options: RazorpayOptions): { open: () => void; on: (event: string, handler: (payload: unknown) => void) => void };
}

declare global {
  interface Window {
    Razorpay?: RazorpayStatic;
  }
}

let loading: Promise<RazorpayStatic> | null = null;

function loadCheckoutScript(): Promise<RazorpayStatic> {
  if (typeof window === "undefined") return Promise.reject(new Error("no-window"));
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (loading) return loading;
  loading = new Promise<RazorpayStatic>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    const timer = setTimeout(() => {
      script.remove();
      loading = null;
      reject(new Error("timeout"));
    }, SCRIPT_TIMEOUT_MS);
    script.onload = () => {
      clearTimeout(timer);
      if (window.Razorpay) resolve(window.Razorpay);
      else {
        loading = null;
        reject(new Error("unavailable"));
      }
    };
    script.onerror = () => {
      clearTimeout(timer);
      loading = null;
      reject(new Error("failed"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export type CheckoutOutcome =
  | { kind: "success"; response: RazorpayHandlerResponse }
  | { kind: "dismissed" }
  | { kind: "script-error" };

/**
 * Opens Razorpay Checkout for a server-created subscription. Resolves when
 * the popup flow ends: `success` carries the relayed confirmation (verified
 * server-side before it is trusted), `dismissed` when the user closed it.
 */
export async function openRazorpayCheckout(input: {
  keyId: string;
  subscriptionId: string;
  planName: string;
  currency: string;
}): Promise<CheckoutOutcome> {
  let RazorpayCtor: RazorpayStatic;
  try {
    RazorpayCtor = await loadCheckoutScript();
  } catch {
    return { kind: "script-error" };
  }
  return new Promise<CheckoutOutcome>((resolve) => {
    const checkout = new RazorpayCtor({
      key: input.keyId,
      subscription_id: input.subscriptionId,
      name: "ExtensionLab",
      description: `${input.planName} plan · monthly subscription`,
      theme: { color: "#0f62fe" },
      handler: (response) => resolve({ kind: "success", response }),
      modal: {
        // The user closed checkout without paying; nothing was charged.
        ondismiss: () => resolve({ kind: "dismissed" }),
        animation: true,
      },
    });
    // Payment failures inside the modal are surfaced by Razorpay itself; the
    // handler only fires on success. A failure leaves the promise resolved
    // via ondismiss when the user closes the modal.
    checkout.open();
  });
}
