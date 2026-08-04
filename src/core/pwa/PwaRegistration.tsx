"use client";

import { useEffect } from "react";

export function PwaRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((cause) => console.warn("[fundosmart] service worker unavailable", cause));
  }, []);
  return null;
}
