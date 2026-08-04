import type { Metadata } from "next";
import { LandingPage } from "@/src/modules/landing/LandingPage";
import { publicUrl } from "./public-url";

export const metadata: Metadata = {
  alternates: {
    canonical: publicUrl(),
  },
  robots: {
    follow: true,
    index: true,
  },
};

export default function HomePage() {
  return <LandingPage />;
}
