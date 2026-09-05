import type { Metadata } from "next";
import { Suspense } from "react";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";

export const metadata: Metadata = { title: "Reset password" };

export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-screen items-start justify-center px-4 py-12 sm:py-20">
      <Suspense fallback={null}>
        <ResetPasswordForm />
      </Suspense>
    </main>
  );
}
