import type { MetadataRoute } from "next";
import { publicUrl } from "./public-url";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      changeFrequency: "monthly",
      priority: 1,
      url: publicUrl(),
    },
  ];
}
