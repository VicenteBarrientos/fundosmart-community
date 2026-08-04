import { ServiceWorkerRegistration } from "@/src/core/offline/ServiceWorkerRegistration";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "leaflet/dist/leaflet.css";
import "./fonts.css";
import "./globals.css";

export const viewport: Viewport = {
  initialScale: 1,
  themeColor: "#143b2b",
  viewportFit: "cover",
  width: "device-width",
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3001";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const baseUrl = new URL(`${protocol}://${host}`);
  const socialImage = new URL("/og.png", baseUrl).toString();

  return {
    applicationName: "FundoSmart",
    description:
      "FundoSmart unifica potreros, animales, leche, sanidad y costos para la lechería y ganadería del Sur de Chile.",
    icons: {
      apple: [{ sizes: "180x180", type: "image/png", url: "/fundosmart-ultra-min-apple-touch-icon.png" }],
      icon: [
        { type: "image/svg+xml", url: "/fundosmart-ultra-min-favicon.svg" },
        { sizes: "192x192", type: "image/png", url: "/fundosmart-ultra-min-app-icon-192.png" },
      ],
      shortcut: "/fundosmart-ultra-min-favicon.ico",
    },
    manifest: "/manifest.webmanifest",
    metadataBase: baseUrl,
    openGraph: {
      description:
        "Territorio, animales, leche, sanidad y costos en un solo sistema, con migración auditable desde herramientas Cooprinsem.",
      images: [
        {
          alt: "FundoSmart — el predio completo, en un solo sistema",
          height: 907,
          url: socialImage,
          width: 1733,
        },
      ],
      locale: "es_CL",
      title: "FundoSmart — El predio completo, en un solo sistema",
      type: "website",
    },
    title: "FundoSmart — Gestión de predios ganaderos",
    twitter: {
      card: "summary_large_image",
      description: "Software ganadero del Sur de Chile, con tu historia migrada de forma auditable.",
      images: [socialImage],
      title: "FundoSmart — El predio completo, en un solo sistema",
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es-CL">
      <body>
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
