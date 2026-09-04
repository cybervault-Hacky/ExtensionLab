import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "@/components/auth/LoginForm";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-start justify-center px-4 py-12 sm:py-20">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
