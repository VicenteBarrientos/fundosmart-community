"use client";

import type { Fundo, Potrero } from "@/src/modules/potreros/types";
import { AttributionControl, MapContainer, Polygon, ScaleControl, Tooltip } from "@/src/core/maps/leaflet-react";
import type { LatLngBoundsExpression } from "leaflet";
import styles from "./print.module.css";

const STATUS_COLORS: Record<Potrero["status"], string> = {
  Disponible: "#59a96a",
  "En pastoreo": "#d49a3a",
  "En descanso": "#718096",
};

type PrintPaddockMapProps = {
  fundo: Fundo;
  paddocks: Potrero[];
  onReady: () => void;
};

export function PrintPaddockMap({ fundo, onReady, paddocks }: PrintPaddockMapProps) {
  const allCoordinates = [...fundo.coordinates, ...paddocks.flatMap((paddock) => paddock.coordinates)];
  const bounds = coordinateBounds(allCoordinates);

  return (
    <MapContainer
      attributionControl={false}
      bounds={bounds}
      boundsOptions={{ padding: [22, 22] }}
      boxZoom={false}
      className={`${styles.map} ${styles.mutedMap}`}
      doubleClickZoom={false}
      dragging={false}
      keyboard={false}
      scrollWheelZoom={false}
      touchZoom={false}
      whenReady={onReady}
      zoomControl={false}
    >
      <Polygon
        pathOptions={{ color: "#173b2d", dashArray: "8 5", fill: false, weight: 3 }}
        positions={fundo.coordinates}
      />
      {paddocks.map((paddock, index) => (
        <Polygon
          key={paddock.id}
          pathOptions={{
            color: "#ffffff",
            fillColor: STATUS_COLORS[paddock.status],
            fillOpacity: 0.72,
            weight: 2,
          }}
          positions={paddock.coordinates}
        >
          <Tooltip className="map-label" direction="center" opacity={0.95} permanent>
            {index + 1}. {paddock.name}
          </Tooltip>
        </Polygon>
      ))}
      <ScaleControl imperial={false} maxWidth={130} position="bottomleft" />
      <AttributionControl position="bottomright" prefix="FundoSmart · sin mapa base" />
    </MapContainer>
  );
}

function coordinateBounds(coordinates: Fundo["coordinates"]): LatLngBoundsExpression {
  if (coordinates.length === 0) return [[-40.5, -73.1], [-40.4, -72.9]];
  const latitudes = coordinates.map(([latitude]) => latitude);
  const longitudes = coordinates.map(([, longitude]) => longitude);
  return [
    [Math.min(...latitudes), Math.min(...longitudes)],
    [Math.max(...latitudes), Math.max(...longitudes)],
  ];
}
