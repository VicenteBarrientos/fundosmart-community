"use client";

import { useEffect } from "react";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || window.location.protocol !== "https:") return;

    let active = true;
    void navigator.serviceWorker.register("/sw.js", { scope: "/" })
      .then((registration) => {
        if (active) void registration.update();
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  return null;
}
