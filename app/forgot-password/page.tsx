import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

export const metadata: Metadata = { title: "Forgot password" };

export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-screen items-start justify-center px-4 py-12 sm:py-20">
      <ForgotPasswordForm />
    </main>
  );
}
