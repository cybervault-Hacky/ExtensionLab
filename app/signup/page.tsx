import type { Metadata } from "next";
import { Suspense } from "react";
import { SignupForm } from "@/components/auth/SignupForm";

export const metadata: Metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <main className="flex min-h-screen items-start justify-center px-4 py-12 sm:py-20">
      <Suspense fallback={null}>
        <SignupForm />
      </Suspense>
    </main>
  );
}
