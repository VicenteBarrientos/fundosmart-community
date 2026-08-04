import type {
  AnimalInsight,
  LivestockBirth,
  LivestockHealthEvent,
  LivestockLactation,
  LivestockMilkControl,
  LivestockReproductiveEvent,
} from "../domain/types";
import type { LivestockWeighing } from "@/src/core/domain/types";

export function buildAnimalInsights(input: {
  lactations: LivestockLactation[];
  milkControls: LivestockMilkControl[];
  reproductiveEvents: LivestockReproductiveEvent[];
  births?: LivestockBirth[];
  healthEvents?: LivestockHealthEvent[];
  weighings: LivestockWeighing[];
}, nowValue?: string): AnimalInsight[];
