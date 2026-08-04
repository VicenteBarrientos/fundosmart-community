import type { MetadataRoute } from "next";
import { publicUrl } from "./public-url";

export default function robots(): MetadataRoute.Robots {
  return {
    // Restricted routes stay crawlable so their X-Robots-Tag noindex directive
    // can be observed. Authentication remains the actual access boundary.
    rules: {
      allow: "/",
      userAgent: "*",
    },
    sitemap: publicUrl("/sitemap.xml"),
  };
}
